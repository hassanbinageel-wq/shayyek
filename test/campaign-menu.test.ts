import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, MockMeta, commentPayload, deliver, messagePayload, resetDb, seedAccount, seedCampaign } from "./helpers";
import { campaignInputSchema } from "../src/shared/schemas";
import type { DmMenu } from "../src/shared/menu";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;
async function call(path: string, h: H = {}, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function login(username: string, password: string): Promise<H> {
  const r = await call("/api/auth/login", {}, "POST", { username, password, client: "app" });
  if (!r.body?.token) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return { Authorization: `Bearer ${r.body.token}` };
}

// The DM menu switched OFF for people who write: only the campaign sends it.
const MENU: DmMenu = {
  enabled: false,
  trigger: "daily",
  pause_hours: 12,
  root: {
    key: "root0001",
    label: "",
    text: "أهلًا 👋 اختر:",
    link: null,
    style: "buttons",
    children: [
      { key: "price001", label: "الأسعار", text: "السعر 110", link: null, style: "buttons", children: [] },
      { key: "areas001", label: "التغطية", text: "تريم", link: null, style: "buttons", children: [] },
    ],
  },
};
const setMenu = (m: DmMenu | null, tenant = 1) =>
  DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(tenant === 1 ? "dm_menu" : `t${tenant}:dm_menu`, JSON.stringify(m)).run();
const menuCampaign = async () => {
  const id = await seedCampaign({ keywords: [{ keyword: "قائمة" }], public_reply_enabled: false });
  await DB.prepare("UPDATE campaigns SET send_menu = 1 WHERE id = ?").bind(id).run();
  return id;
};

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("campaign → «القائمة التلقائية» from a comment", () => {
  it("answers the comment with the menu as the single private reply, then each tap gets its option's reply", async () => {
    await setMenu(MENU);
    await menuCampaign();
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "أبغى القائمة", commentId: "c_menu" }), meta);
    const pr = meta.calls.filter((c) => c.kind === "private_reply");
    expect(pr).toHaveLength(1);
    expect(pr[0].target).toBe("c_menu");
    expect(pr[0].msg!.text).toBe("أهلًا 👋 اختر:");
    expect(pr[0].msg!.menu).toMatchObject({ style: "buttons", options: [{ title: "الأسعار", payload: "hsn:menu:price001" }, { title: "التغطية" }] });
    // the content link is never sent instead
    expect(JSON.stringify(meta.calls)).not.toContain("secret-course");
    // the tap is answered although the automatic menu for DMs is off
    await deliver(messagePayload({ postback: "hsn:menu:price001" }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm").at(-1)!.msg!.text).toBe("السعر 110");
    const out = (await DB.prepare("SELECT kind, text FROM messages WHERE direction = 'out' ORDER BY id").all<any>()).results;
    expect(out[0]).toMatchObject({ kind: "private_reply" });
    expect(out[0].text).toContain("• التغطية");
  });

  it("an empty menu falls back to the campaign's content message", async () => {
    await setMenu(null);
    await menuCampaign();
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "قائمة", commentId: "c_empty" }), meta);
    const pr = meta.calls.filter((c) => c.kind === "private_reply");
    expect(pr).toHaveLength(1);
    expect(pr[0].msg!.menu).toBeUndefined();
    expect(JSON.stringify(pr[0].msg)).toContain("secret-course");
  });

  it("taps stay ignored when no active campaign of THIS customer sends the menu (another customer's campaign does not count)", async () => {
    await setMenu(MENU);
    const id = await menuCampaign();
    const now = Date.now();
    const t2 = (await DB.prepare("INSERT INTO tenants (name, status, created_at, updated_at) VALUES ('ب', 'active', ?, ?) RETURNING id").bind(now, now).first<{ id: number }>())!.id;
    await DB.prepare("UPDATE campaigns SET tenant_id = ? WHERE id = ?").bind(t2, id).run();
    const meta = new MockMeta();
    await deliver(messagePayload({ postback: "hsn:menu:price001" }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm")).toHaveLength(0);
    // paused campaign of the same customer: also ignored
    await DB.prepare("UPDATE campaigns SET tenant_id = 1, status = 'paused' WHERE id = ?").bind(id).run();
    await deliver(messagePayload({ postback: "hsn:menu:areas001" }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm")).toHaveLength(0);
  });

  it("saving: no content text needed with the menu; a plan without the menu saves it switched off with a note", async () => {
    const base = { name: "x", type: "comment", match_all: true, keywords: [], final_text: "" };
    expect(campaignInputSchema.safeParse(base).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, send_menu: true }).success).toBe(true);
    await setMenu(MENU);
    await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    const owner = await login("admin", "a-very-strong-password");
    let r = await call("/api/campaigns", owner, "POST", { ...base, send_menu: true });
    expect(r.status).toBe(200);
    expect((await DB.prepare("SELECT send_menu FROM campaigns WHERE tenant_id = 1 ORDER BY id DESC LIMIT 1").first<any>()).send_menu).toBe(1);
    // a customer whose plan has no menu
    const plan = await DB.prepare("SELECT limits FROM plans WHERE id = 'basic'").first<any>();
    await DB.prepare("UPDATE plans SET limits = ? WHERE id = 'basic'").bind(JSON.stringify({ ...JSON.parse(plan.limits), dm_menu: false })).run();
    const code = (await call("/api/owner/codes", owner, "POST", { plan_id: "basic", days: 10, count: 1 })).body.codes[0];
    expect((await call("/api/auth/register", {}, "POST", { name: "متجر م", username: "shop_m", password: "another-strong-password", code })).status).toBe(200);
    const cust = await login("shop_m", "another-strong-password");
    r = await call("/api/campaigns", cust, "POST", { ...base, final_text: "تفضل", send_menu: true });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("القائمة التلقائية غير متاحة في باقتك");
    expect((await DB.prepare("SELECT send_menu FROM campaigns WHERE tenant_id != 1 ORDER BY id DESC LIMIT 1").first<any>()).send_menu).toBe(0);
    await DB.prepare("UPDATE plans SET limits = ? WHERE id = 'basic'").bind(plan.limits).run();
  });
});
