import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emailText, handleInboundEmail, parseAddress, replySubject, sendSupportReply, setInboundFetch, verifySvix } from "../src/worker/services/inbound-email";
import { DB, resetDb, TEST_ENV } from "./helpers";

const env = { ...TEST_ENV, RESEND_API_KEY: "re_test" };
let calls: { url: string; init: RequestInit }[] = [];
let mail: any;
beforeEach(async () => {
  await resetDb();
  await DB.prepare("DELETE FROM support_email_in").run();
  await DB.prepare("DELETE FROM support_threads").run();
  calls = [];
  mail = { from: "Ahmad Ali <Ahmad@Example.com>", to: ["support@shayyek.sa"], subject: "استفسار عن الباقات", text: "السلام عليكم\nكم سعر الباقة؟\n\nOn Mon, someone wrote:\n> old", html: null, message_id: "<abc@mail.example.com>", attachments: [] };
  setInboundFetch(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (String(input).includes("/emails/receiving/")) return Response.json(mail);
    return Response.json({ id: "sent_1" });
  });
});
afterEach(() => setInboundFetch(null));

async function sign(secretB64: string, id: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return btoa(String.fromCharCode(...mac));
}
const ev = (id = "em_123456") => ({ type: "email.received", created_at: "2026-11-22T00:00:00Z", data: { email_id: id, from: "x@y.z", subject: "s" } });

describe("support email (Resend inbound)", () => {
  it("verifies Svix signatures and rejects bad or stale ones", async () => {
    const secret = btoa("super-secret-key-bytes-123456789");
    const body = JSON.stringify(ev());
    const now = Math.floor(Date.now() / 1000);
    const sig = await sign(secret, "msg_1", String(now), body);
    expect(await verifySvix(`whsec_${secret}`, "msg_1", String(now), `v1,${sig}`, body)).toBe(true);
    expect(await verifySvix(`whsec_${secret}`, "msg_1", String(now), `v1,bad v1,${sig}`, body)).toBe(true);
    expect(await verifySvix(`whsec_${secret}`, "msg_1", String(now), `v1,${sig}`, body + " ")).toBe(false);
    expect(await verifySvix(`whsec_${secret}`, "msg_1", String(now - 600), `v1,${await sign(secret, "msg_1", String(now - 600), body)}`, body)).toBe(false);
    expect(await verifySvix(`whsec_${secret}`, null, String(now), `v1,${sig}`, body)).toBe(false);
  });

  it("parses senders and keeps only the new part of the message", () => {
    expect(parseAddress("Ahmad Ali <Ahmad@Example.com>")).toEqual({ email: "ahmad@example.com", name: "Ahmad Ali" });
    expect(parseAddress("plain@x.io")).toEqual({ email: "plain@x.io", name: null });
    expect(parseAddress("not an email")).toBeNull();
    expect(emailText("hi\n\nOn Mon, X wrote:\n> old", null)).toBe("hi");
    expect(emailText(null, "<p>سلام</p><br><b>تجربة</b>")).toBe("سلام\n\nتجربة");
    expect(replySubject("استفسار", 5)).toBe("Re: استفسار [#1005]");
  });

  it("turns an email into a ticket, threads the reply, and ignores duplicates", async () => {
    const id = await handleInboundEmail(env, ev());
    expect(id).toBeGreaterThan(0);
    const t = await DB.prepare("SELECT * FROM support_threads WHERE id = ?").bind(id).first<any>();
    expect(t.channel).toBe("email");
    expect(t.email_from).toBe("ahmad@example.com");
    expect(t.tenant_id).toBe(1);
    const m = await DB.prepare("SELECT body FROM support_messages WHERE thread_id = ?").bind(id).first<any>();
    expect(m.body).toBe("السلام عليكم\nكم سعر الباقة؟");
    expect(calls[0].url).toBe("https://api.resend.com/emails/receiving/em_123456");
    // Same webhook again: nothing new.
    expect(await handleInboundEmail(env, ev())).toBeNull();
    // A reply with our ticket tag lands on the same ticket.
    mail = { ...mail, subject: `Re: استفسار عن الباقات [#${1000 + id!}]`, text: "شكرًا", message_id: "<def@mail.example.com>" };
    expect(await handleInboundEmail(env, ev("em_999999"))).toBe(id);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE thread_id = ?").bind(id).first<any>();
    expect(n.n).toBe(2);
    // The owner gets a notification.
    const bell = await DB.prepare("SELECT COUNT(*) AS n FROM app_notifications WHERE tenant_id = 1 AND title LIKE '📧%'").first<any>();
    expect(bell.n).toBe(2);
  });

  it("a ticket tag of someone else's ticket does not attach to it", async () => {
    const id = await handleInboundEmail(env, ev());
    mail = { ...mail, from: "attacker@evil.example", subject: `Re: x [#${1000 + id!}]` };
    const other = await handleInboundEmail(env, ev("em_777777"));
    expect(other).not.toBe(id);
  });

  it("does not open tickets for our own or no-reply senders", async () => {
    mail = { ...mail, from: "no-reply@shayyek.sa" };
    expect(await handleInboundEmail(env, ev())).toBeNull();
    mail = { ...mail, from: "mailer-daemon@google.com" };
    expect(await handleInboundEmail(env, ev("em_222222"))).toBeNull();
  });

  it("sends the reply by email in the same thread", async () => {
    const r = await sendSupportReply(env, { id: 7, subject: "استفسار", email_from: "ahmad@example.com", email_last_message_id: "<abc@mail.example.com>" }, "أهلًا <أحمد>");
    expect(r.ok).toBe(true);
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.to).toEqual(["ahmad@example.com"]);
    expect(sent.subject).toBe("Re: استفسار [#1007]");
    expect(sent.headers["In-Reply-To"]).toBe("<abc@mail.example.com>");
    expect(sent.html).toContain("&lt;أحمد&gt;");
  });
});
