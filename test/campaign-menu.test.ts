import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, MockMeta, commentPayload, deliver, messagePayload, resetDb, seedAccount, seedCampaign } from "./helpers";
import { campaignInputSchema } from "../src/shared/schemas";
import type { DmMenu, MenuNode } from "../src/shared/menu";

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

// The campaign's own tree; the inbox menu stays separate (switched off here).
const ROOT: MenuNode = {
  key: "root0001",
  label: "",
  text: "أهلًا 👋 اختر:",
  link: null,
  style: "buttons",
  children: [
    { key: "price001", label: "الأسعار", text: "السعر 110", link: null, style: "buttons", children: [] },
    { key: "areas001", label: "التغطية", text: "تريم", link: null, style: "buttons", children: [] },
  ],
};
const INBOX_MENU: DmMenu = { enabled: false, trigger: "daily", pause_hours: 12, root: { ...ROOT, key: "inbox001", text: "قائمة الرسائل", children: [] } };
const setInboxMenu = (m: DmMenu) =>
  DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('dm_menu', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(m)).run();
const menuCampaign = async (root: MenuNode | null = ROOT) => {
  const id = await seedCampaign({ keywords: [{ keyword: "قائمة" }], public_reply_enabled: false });
  await DB.prepare("UPDATE campaigns SET send_menu = 1, menu_root = ? WHERE id = ?").bind(root ? JSON.stringify(root) : null, id).run();
  return id;
};

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("«قائمة تفاعلية»: a campaign's own menu from a comment", () => {
  it("answers the comment with the campaign's tree as the single private reply; each tap gets its option's reply", async () => {
    await setInboxMenu(INBOX_MENU);
    const id = await menuCampaign();
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "أبغى القائمة", commentId: "c_menu" }), meta);
    const pr = meta.calls.filter((c) => c.kind === "private_reply");
    expect(pr).toHaveLength(1);
    expect(pr[0].target).toBe("c_menu");
    expect(pr[0].msg!.text).toBe("أهلًا 👋 اختر:");
    expect(pr[0].msg!.menu).toMatchObject({ style: "buttons", options: [{ title: "الأسعار", payload: `hsn:cmenu:${id}:price001` }, { title: "التغطية" }] });
    expect(JSON.stringify(meta.calls)).not.toContain("secret-course");
    // the tap is answered from the campaign's tree (the inbox menu is off and different)
    await deliver(messagePayload({ postback: `hsn:cmenu:${id}:price001` }), meta);
    const dm = meta.calls.filter((c) => c.kind === "dm").at(-1)!;
    expect(dm.msg!.text).toBe("السعر 110");
    const out = (await DB.prepare("SELECT kind, text FROM messages WHERE direction = 'out' ORDER BY id").all<any>()).results;
    expect(out[0]).toMatchObject({ kind: "private_reply" });
    expect(out[0].text).toContain("• التغطية");
    // two campaigns, two trees: the same key in another campaign answers from that campaign
    const id2 = await menuCampaign({ ...ROOT, children: [{ ...ROOT.children[0], text: "سعر الحملة الثانية" }] });
    await deliver(messagePayload({ postback: `hsn:cmenu:${id2}:price001` }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm").at(-1)!.msg!.text).toBe("سعر الحملة الثانية");
  });

  it("no tree saved → the campaign's content message", async () => {
    await menuCampaign(null);
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "قائمة", commentId: "c_empty" }), meta);
    const pr = meta.calls.filter((c) => c.kind === "private_reply");
    expect(pr).toHaveLength(1);
    expect(pr[0].msg!.menu).toBeUndefined();
    expect(JSON.stringify(pr[0].msg)).toContain("secret-course");
  });

  it("taps are ignored for another customer's campaign, a paused campaign, or a removed option", async () => {
    const id = await menuCampaign();
    const now = Date.now();
    const t2 = (await DB.prepare("INSERT INTO tenants (name, status, created_at, updated_at) VALUES ('ب', 'active', ?, ?) RETURNING id").bind(now, now).first<{ id: number }>())!.id;
    await DB.prepare("UPDATE campaigns SET tenant_id = ? WHERE id = ?").bind(t2, id).run();
    const meta = new MockMeta();
    await deliver(messagePayload({ postback: `hsn:cmenu:${id}:price001` }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm")).toHaveLength(0);
    await DB.prepare("UPDATE campaigns SET tenant_id = 1, status = 'paused' WHERE id = ?").bind(id).run();
    await deliver(messagePayload({ postback: `hsn:cmenu:${id}:areas001` }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm")).toHaveLength(0);
    await DB.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").bind(id).run();
    await deliver(messagePayload({ postback: `hsn:cmenu:${id}:gone0001` }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm")).toHaveLength(0);
    await deliver(messagePayload({ postback: `hsn:cmenu:${id}:areas001` }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm").at(-1)!.msg!.text).toBe("تريم");
  });

  it("saving: the tree is required and checked; a plan without the menu is refused", async () => {
    const base = { name: "x", type: "comment", match_all: true, keywords: [], final_text: "" };
    expect(campaignInputSchema.safeParse(base).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, send_menu: true }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, send_menu: true, menu_root: ROOT }).success).toBe(true);
    await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    const owner = await login("admin", "a-very-strong-password");
    let r = await call("/api/campaigns", owner, "POST", { ...base, send_menu: true, menu_root: { ...ROOT, children: [] } });
    expect(r.status).toBe(400);
    r = await call("/api/campaigns", owner, "POST", { ...base, send_menu: true, menu_root: { ...ROOT, children: [{ ...ROOT.children[0], label: "" }] } });
    expect(r.status).toBe(400);
    r = await call("/api/campaigns", owner, "POST", { ...base, send_menu: true, menu_root: ROOT });
    expect(r.status).toBe(200);
    const row = await DB.prepare("SELECT send_menu, menu_root FROM campaigns WHERE tenant_id = 1 ORDER BY id DESC LIMIT 1").first<any>();
    expect(row.send_menu).toBe(1);
    expect(JSON.parse(row.menu_root).children).toHaveLength(2);
    // a customer whose plan has no menu
    const plan = await DB.prepare("SELECT limits FROM plans WHERE id = 'basic'").first<any>();
    await DB.prepare("UPDATE plans SET limits = ? WHERE id = 'basic'").bind(JSON.stringify({ ...JSON.parse(plan.limits), dm_menu: false })).run();
    const code = (await call("/api/owner/codes", owner, "POST", { plan_id: "basic", days: 10, count: 1 })).body.codes[0];
    expect((await call("/api/auth/register", {}, "POST", { name: "متجر م", username: "shop_m", password: "another-strong-password", code })).status).toBe(200);
    const cust = await login("shop_m", "another-strong-password");
    r = await call("/api/campaigns", cust, "POST", { ...base, send_menu: true, menu_root: ROOT });
    expect(r.status).toBe(403);
    await DB.prepare("UPDATE plans SET limits = ? WHERE id = 'basic'").bind(plan.limits).run();
  });

  it("limits: deliveries per person are kept to 1–2, and the hourly limit is fixed at 4", async () => {
    expect(campaignInputSchema.parse({ name: "x", type: "comment", match_all: true, keywords: [], final_text: "t", max_deliveries_per_user: 0 }).max_deliveries_per_user).toBe(2);
    expect(campaignInputSchema.parse({ name: "x", type: "comment", match_all: true, keywords: [], final_text: "t", max_deliveries_per_user: 1 }).max_deliveries_per_user).toBe(1);
    expect(campaignInputSchema.parse({ name: "x", type: "comment", match_all: true, keywords: [], final_text: "t", max_deliveries_per_user: 9 }).max_deliveries_per_user).toBe(2);
    // an older campaign stored with 0 (= no limit) is treated as at most 2
    await seedCampaign({ keywords: [{ keyword: "كورس" }], max_deliveries_per_user: 0 });
    const meta = new MockMeta();
    for (let i = 0; i < 3; i++) await deliver(commentPayload({ text: "كورس", commentId: `c_lim${i}` }), meta);
    expect(meta.calls.filter((c) => c.kind === "private_reply")).toHaveLength(2);
    // the per-hour limit across campaigns is 4, whatever the old setting says
    await DB.prepare("UPDATE app_settings SET value = '100' WHERE key = 'global_user_hourly_limit'").run();
    for (let i = 0; i < 5; i++) await seedCampaign({ keywords: [{ keyword: `كلمة${i}` }] });
    for (let i = 0; i < 5; i++) await deliver(commentPayload({ text: `كلمة${i}`, commentId: `c_h${i}`, from: "igsid_user_9", username: "nine" }), meta);
    const flows = await DB.prepare("SELECT COUNT(*) AS n FROM conversation_flows f JOIN participants p ON p.id = f.participant_id WHERE p.igsid = 'igsid_user_9'").first<any>();
    expect(flows.n).toBe(4);
  });
});
