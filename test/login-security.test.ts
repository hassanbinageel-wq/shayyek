import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb } from "./helpers";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const post = (path: string, body: unknown) =>
  SELF.fetch(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const setup = () => post("/api/auth/setup", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });

beforeEach(async () => {
  await resetDb();
});

describe("login security", () => {
  it("lists missing server secrets only before the first-time setup", async () => {
    await setup();
    const r = await SELF.fetch(new Request(BASE + "/api/auth/status"));
    expect(((await r.json()) as any).missing_secrets).toEqual([]);
  });

  it("audits failed sign-ins and alerts when the account locks", async () => {
    await setup();
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/login", { username: "admin", password: "wrong-password-123" })).status).toBe(401);
    const rows = await DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'auth.%' ORDER BY id").all<any>();
    const actions = rows.results.map((r: any) => r.action);
    expect(actions.filter((a: string) => a === "auth.login_failed")).toHaveLength(4);
    expect(actions).toContain("auth.locked");
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM app_notifications WHERE title LIKE '%انقفل%'").first<any>();
    expect(n.n).toBe(1);
    // Locked: even the right password waits.
    expect((await post("/api/auth/login", { username: "admin", password: "a-very-strong-password" })).status).toBe(429);
  });

  it("an unknown name gets the same answer and is audited without the typed name", async () => {
    await setup();
    const r = await post("/api/auth/login", { username: "nobody-here", password: "wrong-password-123" });
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error.code).toBe("invalid_credentials");
    const row = await DB.prepare("SELECT actor, details FROM audit_logs WHERE action = 'auth.login_failed'").first<any>();
    expect(row.actor).toBe("system");
    expect(String(row.details)).not.toContain("nobody-here");
  });
});
