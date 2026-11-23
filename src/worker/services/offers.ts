import { all, first, getSetting, OWNER_TENANT, run } from "../lib/db";
import type { Offer } from "../../shared/promos";

/**
 * Offers: a side box with a countdown that the owner shows for a time window to every customer, to subscribers of
 * chosen plans (or everyone except them), or to chosen customers. An offer can also carry a real discount on chosen
 * plans: only the customers it is for get it, on card payments and upgrades, while it runs.
 */

type OfferRow = Offer & {
  audience: string; tenant_ids: string | null; plan_ids: string | null; discount_pct: number | null; discount_plans: string | null; discount_scope: string | null; auto_key: string | null;
  active: number; views: number; clicks: number; created_at: number; updated_at: number;
};

const ids = <T>(raw: string | null): T[] => (raw ? (JSON.parse(raw) as T[]) : []);

/** Whether a customer (on plan `planId`, maybe none) is one of the offer's audience. */
function visibleTo(o: OfferRow, tenantId: number, planId: string | null): boolean {
  if (o.audience === "all") return true;
  if (o.audience === "tenants") return ids<number>(o.tenant_ids).includes(tenantId);
  if (o.audience === "plans") return !!planId && ids<string>(o.plan_ids).includes(planId);
  if (o.audience === "except_plans") return !planId || !ids<string>(o.plan_ids).includes(planId);
  return false;
}

async function planOf(db: D1Database, tenantId: number): Promise<string | null> {
  return (await first<{ plan_id: string | null }>(db, "SELECT plan_id FROM tenants WHERE id = ?", tenantId))?.plan_id ?? null;
}

async function runningFor(db: D1Database, tenantId: number, now: number): Promise<OfferRow[]> {
  const [rows, planId] = await Promise.all([
    all<OfferRow>(db, "SELECT * FROM offers WHERE active = 1 AND ends_at > ? AND (starts_at IS NULL OR starts_at <= ?) ORDER BY ends_at", now, now),
    planOf(db, tenantId),
  ]);
  return rows.filter((o) => visibleTo(o, tenantId, planId));
}

/** Offers running now for one customer, the soonest to end first. */
export async function offersFor(db: D1Database, tenantId: number, now = Date.now()): Promise<Offer[]> {
  return (await runningFor(db, tenantId, now)).map(({ id, title, body, cta, link, theme, icon, starts_at, ends_at, discount_pct, discount_plans, discount_scope }) => ({
    id, title, body, cta, link, theme, icon, starts_at, ends_at, discount_pct: discount_pct ?? null, discount_plans: discount_plans ? ids<string>(discount_plans) : null,
    discount_scope: (discount_scope as Offer["discount_scope"]) ?? "plans",
  }));
}

/** The best running offer discount this customer has on a plan (card payment or upgrade to it), if any. */
export async function offerDiscount(db: D1Database, tenantId: number, planId: string, now = Date.now()): Promise<{ pct: number; offer_id: number } | null> {
  let best: { pct: number; offer_id: number } | null = null;
  for (const o of await runningFor(db, tenantId, now)) {
    if (!o.discount_pct || o.discount_scope === "topups" || (o.discount_plans && !ids<string>(o.discount_plans).includes(planId))) continue;
    if (!best || o.discount_pct > best.pct) best = { pct: o.discount_pct, offer_id: o.id };
  }
  return best;
}

/** The best running offer discount this customer has on message top-ups, if any. */
export async function topupDiscount(db: D1Database, tenantId: number, now = Date.now()): Promise<{ pct: number; offer_id: number } | null> {
  let best: { pct: number; offer_id: number } | null = null;
  for (const o of await runningFor(db, tenantId, now)) {
    if (!o.discount_pct || (o.discount_scope !== "topups" && o.discount_scope !== "both")) continue;
    if (!best || o.discount_pct > best.pct) best = { pct: o.discount_pct, offer_id: o.id };
  }
  return best;
}

/** The owner's automatic offer: when a customer is close to running out of messages but has many days left. */
export type AutoOffer = {
  enabled: boolean;
  /** Messages left in the cycle at or below this. */
  max_left: number;
  /** Days left in the subscription at or above this. */
  min_days: number;
  pct: number;
  scope: "topups" | "both";
  hours: number;
  title: string;
  body: string;
  theme: string;
};
export const DEFAULT_AUTO_OFFER: AutoOffer = {
  enabled: false,
  max_left: 50,
  min_days: 10,
  pct: 20,
  scope: "topups",
  hours: 48,
  title: "🎁 خصم {الخصم}% على شحن الرسائل",
  body: "باقي لك {المتبقي} رسالة و{الأيام} يوم في اشتراكك — اشحن الحين بخصم {الخصم}% قبل لا تتوقف الردود.",
  theme: "violet",
};

/** Every automatic offer the system sent: to whom, when, whether they saw / opened it, and what they paid with it. */
export async function autoOfferLog(db: D1Database, limit = 100) {
  const rows = await all<{
    id: number; tenant_id: number; name: string | null; discount_pct: number | null; discount_scope: string | null; created_at: number; ends_at: number;
    viewed_at: number | null; clicked_at: number | null; paid: number | null; paid_amount: number | null; paid_what: string | null;
  }>(
    db,
    `SELECT o.id, CAST(json_extract(o.tenant_ids, '$[0]') AS INTEGER) AS tenant_id, t.name, o.discount_pct, o.discount_scope, o.created_at, o.ends_at,
       (SELECT MIN(e.created_at) FROM offer_events e WHERE e.offer_id = o.id AND e.kind = 'view') AS viewed_at,
       (SELECT MIN(e.created_at) FROM offer_events e WHERE e.offer_id = o.id AND e.kind <> 'view') AS clicked_at,
       (SELECT COUNT(*) FROM card_payments k WHERE k.offer_id = o.id AND k.status = 'paid') AS paid,
       (SELECT COALESCE(SUM(k.amount), 0) FROM card_payments k WHERE k.offer_id = o.id AND k.status = 'paid') AS paid_amount,
       (SELECT group_concat(CASE WHEN k.topup_messages IS NOT NULL THEN k.topup_messages || ' رسالة' WHEN k.upgrade_id IS NOT NULL THEN 'ترقية' ELSE 'باقة' END, '، ')
          FROM card_payments k WHERE k.offer_id = o.id AND k.status = 'paid') AS paid_what
     FROM offers o LEFT JOIN tenants t ON t.id = CAST(json_extract(o.tenant_ids, '$[0]') AS INTEGER)
     WHERE o.auto_key IS NOT NULL ORDER BY o.id DESC LIMIT ?`,
    limit,
  );
  const list = rows.map((r) => ({ ...r, name: r.name ?? `#${r.tenant_id}`, paid: r.paid ?? 0, paid_amount: (r.paid_amount ?? 0) / 100 }));
  return {
    sent: list.length,
    viewed: list.filter((r) => r.viewed_at).length,
    clicked: list.filter((r) => r.clicked_at).length,
    bought: list.filter((r) => r.paid > 0).length,
    revenue: list.reduce((s, r) => s + r.paid_amount, 0),
    list,
  };
}

export async function autoOfferRule(db: D1Database): Promise<AutoOffer> {
  return { ...DEFAULT_AUTO_OFFER, ...(await getSetting<Partial<AutoOffer> | null>(db, OWNER_TENANT, "auto_low_messages_offer", null)) };
}

/**
 * Applies the owner's automatic rule to one customer (called with their current usage): at most one such offer per
 * usage cycle. Returns the new offer id, or null.
 */
export async function maybeAutoOffer(
  db: D1Database,
  rule: AutoOffer,
  c: { tenantId: number; name: string; left: number; daysLeft: number | null; cycleKey: string; planId?: string | null },
  now = Date.now(),
): Promise<{ id: number; title: string; body: string } | null> {
  if (!rule.enabled || c.daysLeft === null || c.left > rule.max_left || c.daysLeft < rule.min_days) return null;
  // The plan part of the discount is for an upgrade only: the plans above the customer's own (not a renewal of it, not
  // a lower one). On the top plan there is nothing above, so only the top-ups get the discount.
  let scope: string = rule.scope;
  let discountPlans: string | null = null;
  if (scope === "both") {
    const higher = await all<{ id: string }>(
      db,
      `SELECT p.id FROM plans p WHERE p.active = 1 AND COALESCE(p.free, 0) = 0
         AND p.sort > COALESCE((SELECT sort FROM plans WHERE id = ?), -1) ORDER BY p.sort`,
      c.planId ?? "",
    );
    if (higher.length) discountPlans = JSON.stringify(higher.map((p) => p.id));
    else scope = "topups";
  }
  const fill = (s: string) =>
    s.replaceAll("{الخصم}", String(rule.pct)).replaceAll("{المتبقي}", c.left.toLocaleString("en-US")).replaceAll("{الأيام}", String(c.daysLeft)).replaceAll("{الاسم}", c.name);
  const title = fill(rule.title).slice(0, 60);
  const body = fill(rule.body).slice(0, 200);
  const r = await run(
    db,
    `INSERT OR IGNORE INTO offers (title, body, cta, link, theme, icon, starts_at, ends_at, audience, tenant_ids, active, plan_ids, discount_pct, discount_plans, discount_scope, auto_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '🎁', ?, ?, 'tenants', ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
    title, body, "اشحن الحين", scope === "topups" ? "/subscription?topup=1" : "/subscription", rule.theme, now, now + rule.hours * 3_600_000, JSON.stringify([c.tenantId]), rule.pct, discountPlans, scope, `low_messages:${c.tenantId}:${c.cycleKey}`, now, now,
  );
  if (!r.meta.changes) return null; // already made this cycle
  return { id: Number(r.meta.last_row_id), title, body };
}

/** An amount in halalas after a discount (Moyasar's minimum is 1 SAR). */
export const discounted = (amount: number, pct: number) => Math.max(100, Math.round((amount * (100 - pct)) / 100));

/** Notes that the customer was shown these offers (the first time only). */
export async function markViewed(db: D1Database, tenantId: number, offers: Offer[], now = Date.now()): Promise<void> {
  if (!offers.length) return;
  await db.batch(offers.map((o) => db.prepare("INSERT OR IGNORE INTO offer_events (offer_id, tenant_id, kind, created_at) VALUES (?, ?, 'view', ?)").bind(o.id, tenantId, now)));
}

/** Counts a click on an offer the customer can see; false when it is not theirs or not running. */
export async function clickOffer(db: D1Database, tenantId: number, id: number, now = Date.now()): Promise<boolean> {
  const o = await first<OfferRow>(db, "SELECT * FROM offers WHERE id = ? AND active = 1 AND ends_at > ?", id, now);
  if (!o || !visibleTo(o, tenantId, await planOf(db, tenantId))) return false;
  await run(db, "UPDATE offers SET clicks = clicks + 1 WHERE id = ?", id);
  await run(db, "INSERT OR IGNORE INTO offer_events (offer_id, tenant_id, kind, created_at) VALUES (?, ?, 'click', ?)", id, tenantId, now);
  return true;
}

/** Days after an offer ends that a purchase still counts for it. */
const GRACE_MS = 3 * 86_400_000;

/**
 * One offer for the owner: how many customers it was for, who saw it, who opened it, and who paid after seeing it
 * (a card payment — plan, upgrade or message pack — or an activation code, from their first view until 3 days after
 * the offer ended).
 */
export async function offerStats(db: D1Database, id: number) {
  const o = await first<OfferRow>(db, "SELECT * FROM offers WHERE id = ?", id);
  if (!o) return null;
  const customers = await all<{ id: number; plan_id: string | null }>(db, "SELECT id, plan_id FROM tenants WHERE is_owner = 0 AND status = 'active'");
  const targeted = customers.filter((t) => visibleTo(o, t.id, t.plan_id)).length;
  const events = await all<{ tenant_id: number; name: string | null; kind: string; created_at: number }>(
    db,
    "SELECT e.tenant_id, t.name, e.kind, e.created_at FROM offer_events e LEFT JOIN tenants t ON t.id = e.tenant_id WHERE e.offer_id = ? ORDER BY e.created_at",
    id,
  );
  const people = new Map<number, { tenant_id: number; name: string; viewed_at: number | null; clicked_at: number | null; bought: Array<{ what: string; amount: number; at: number }> }>();
  for (const e of events) {
    const p = people.get(e.tenant_id) ?? { tenant_id: e.tenant_id, name: e.name ?? `#${e.tenant_id}`, viewed_at: null, clicked_at: null, bought: [] };
    if (e.kind === "view") p.viewed_at = e.created_at;
    else p.clicked_at = e.created_at;
    people.set(e.tenant_id, p);
  }
  const until = o.ends_at + GRACE_MS;
  for (const p of people.values()) {
    const from = Math.min(p.viewed_at ?? Infinity, p.clicked_at ?? Infinity);
    const pays = await all<{ amount: number; paid_at: number; upgrade_id: number | null; topup_messages: number | null; plan_name: string | null }>(
      db,
      `SELECT k.amount, k.paid_at, k.upgrade_id, k.topup_messages, pl.name AS plan_name FROM card_payments k LEFT JOIN plans pl ON pl.id = k.plan_id
        WHERE k.tenant_id = ? AND k.status = 'paid' AND k.paid_at >= ? AND k.paid_at <= ?`,
      p.tenant_id, from, until,
    );
    for (const k of pays) p.bought.push({ what: k.topup_messages ? `${k.topup_messages.toLocaleString("en-US")} رسالة إضافية` : k.upgrade_id ? `ترقية إلى ${k.plan_name ?? ""}` : `باقة ${k.plan_name ?? ""}`, amount: k.amount / 100, at: k.paid_at });
    const codes = await all<{ used_at: number; plan_name: string | null }>(
      db,
      "SELECT c.used_at, pl.name AS plan_name FROM activation_codes c LEFT JOIN plans pl ON pl.id = c.plan_id WHERE c.used_by_tenant = ? AND c.used_at >= ? AND c.used_at <= ?",
      p.tenant_id, from, until,
    );
    for (const c of codes) p.bought.push({ what: `كود تفعيل ${c.plan_name ?? ""}`, amount: 0, at: c.used_at });
  }
  const list = [...people.values()].sort((a, b) => b.bought.length - a.bought.length || (b.clicked_at ?? 0) - (a.clicked_at ?? 0));
  return {
    targeted,
    viewed: list.filter((p) => p.viewed_at).length,
    clicked: list.filter((p) => p.clicked_at).length,
    converted: list.filter((p) => p.bought.length).length,
    revenue: list.reduce((s, p) => s + p.bought.reduce((x, b) => x + b.amount, 0), 0),
    people: list,
  };
}

export async function listOffers(db: D1Database) {
  const rows = await all<OfferRow>(db, "SELECT * FROM offers ORDER BY id DESC LIMIT 100");
  return rows.map((o) => ({ ...o, active: !!o.active, tenant_ids: ids<number>(o.tenant_ids), plan_ids: ids<string>(o.plan_ids), discount_plans: o.discount_plans ? ids<string>(o.discount_plans) : [] }));
}
