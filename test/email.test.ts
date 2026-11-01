import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastEmailError, sendEmail } from "../src/worker/services/email";
import { resetDb } from "./helpers";

const MAIL = { to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" };
const E = (over: Record<string, string>) => ({ ...(env as any), RESEND_API_KEY: "re_test", ...over });

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("email sender", () => {
  it("sends from EMAIL_FROM only; a failure is recorded and the owner is told once an hour", async () => {
    const froms: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => {
      if (String(u).includes("resend")) froms.push(JSON.parse(String(init.body)).from as string);
      return new Response('{"message":"domain not verified"}', { status: 403 });
    }));
    const r = await sendEmail(E({ EMAIL_FROM: "X <no-reply@new.example>" }), MAIL);
    expect(r.ok).toBe(false);
    expect(froms).toEqual(["X <no-reply@new.example>"]);
    expect((await lastEmailError(env as any))?.error).toContain("403");
    const bell = async () => (await (env as any).DB.prepare("SELECT title FROM app_notifications WHERE tenant_id = 1 AND kind = 'system'").all()).results as Array<{ title: string }>;
    expect((await bell()).map((n) => n.title)).toEqual(["📧 فشل إرسال إيميل من no-reply@new.example"]);
    await sendEmail(E({ EMAIL_FROM: "X <no-reply@new.example>" }), MAIL);
    expect(await bell()).toHaveLength(1); // not again within the hour
  });

  it("success: one request, no error recorded", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect((await sendEmail(E({ EMAIL_FROM: "X <a@new.example>" }), MAIL)).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await lastEmailError(env as any)).toBeNull();
  });
});
