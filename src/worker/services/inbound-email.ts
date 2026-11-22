/**
 * Email to support@shayyek.sa → a support ticket. Resend receives the mail (MX) and calls /webhooks/resend
 * (Svix-signed, metadata only); the body is fetched from Resend's API. A reply on an email ticket is sent back
 * by email from the support address, in the same thread.
 */
import type { Env } from "../env";
import { first, OWNER_TENANT, run } from "../lib/db";
import { fromB64, timingSafeEqual } from "../lib/crypto";
import { ticketNo } from "../../shared/support";
import { notify } from "./notify";

type Fetch = typeof fetch;
let fetchImpl: Fetch = (i, init) => fetch(i, init);
/** Tests replace the network. */
export function setInboundFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}

const enc = new TextEncoder();
const TOLERANCE_S = 5 * 60;

/** Svix signature (Resend webhooks): base64 HMAC-SHA256 of "{id}.{timestamp}.{raw body}", key = base64 after "whsec_". */
export async function verifySvix(secret: string, id: string | null, ts: string | null, sigHeader: string | null, raw: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret || !id || !ts || !sigHeader) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey("raw", fromB64(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ts}.${raw}`)));
  let s = "";
  for (const b of mac) s += String.fromCharCode(b);
  const expected = btoa(s);
  // The header may carry several space-separated signatures: "v1,<b64> v1,<b64>".
  return sigHeader.split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    return ver === "v1" && !!sig && timingSafeEqual(sig, expected);
  });
}

/** "Name <a@b.c>" → { email, name }. */
export function parseAddress(v: unknown): { email: string; name: string | null } | null {
  const s = Array.isArray(v) ? String(v[0] ?? "") : typeof v === "object" && v ? String((v as any).email ?? (v as any).address ?? "") : String(v ?? "");
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  const email = (m ? m[2] : s).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = m ? m[1].trim() || null : null;
  return { email, name };
}

/** The new part of an email: plain text (or HTML turned to text), without the quoted earlier messages. */
export function emailText(text: string | null | undefined, html: string | null | undefined): string {
  let t = text?.trim()
    ? text
    : (html ?? "")
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
  const lines = t.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^On .+wrote:\s*$/i.test(l.trim()) || /^في .+كتب.*:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  t = (cut > 0 ? lines.slice(0, cut) : lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.slice(0, 4000) || "(رسالة بدون نص)";
}

const TAG = /\[#(\d{4,})\]/;
export const replySubject = (subject: string, id: number) => `${/^re:/i.test(subject) ? "" : "Re: "}${subject.replace(TAG, "").trim()} [#${ticketNo(id)}]`;

/** Handles one verified email.received event. Returns the ticket id (or null when skipped). */
export async function handleInboundEmail(env: Env, event: any, now = Date.now()): Promise<number | null> {
  if (event?.type !== "email.received") return null;
  const emailId = String(event?.data?.email_id ?? "");
  if (!/^[\w-]{6,100}$/.test(emailId)) return null;
  const fresh = await run(env.DB, "INSERT OR IGNORE INTO support_email_in (email_id, created_at) VALUES (?, ?)", emailId, now);
  if (!fresh.meta.changes) return null; // already handled
  if (!env.RESEND_API_KEY) return null;
  const r = await fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
  if (!r.ok) {
    // Let Resend retry later.
    await run(env.DB, "DELETE FROM support_email_in WHERE email_id = ?", emailId);
    throw new Error(`resend receiving ${r.status}`);
  }
  const mail = (await r.json()) as any;
  const from = parseAddress(mail.from ?? event.data.from);
  if (!from) return null;
  // Our own mailer never opens tickets (no loops with no-reply bounces).
  if (/@shayyek\.sa$/i.test(from.email) || /^(mailer-daemon|postmaster|no-?reply)@/i.test(from.email)) return null;
  const subject = String(mail.subject ?? event.data.subject ?? "").trim().slice(0, 200) || "(بدون عنوان)";
  let body = emailText(mail.text, mail.html);
  const atts = Array.isArray(mail.attachments ?? event.data.attachments) ? (mail.attachments ?? event.data.attachments) : [];
  if (atts.length) body += `\n\n📎 مرفقات (افتحها من لوحة Resend): ${atts.map((a: any) => String(a.filename ?? "ملف")).slice(0, 10).join("، ")}`;
  const messageId = String(mail.message_id ?? event.data.message_id ?? "").slice(0, 300) || null;

  // Same ticket: our tag in the subject, else the same sender's open email ticket with the same subject.
  const tag = TAG.exec(subject);
  const base = subject.replace(TAG, "").replace(/^(re|fwd?|رد)\s*:\s*/gi, "").trim();
  let thread = tag
    ? await first<{ id: number; tenant_id: number; state: string }>(env.DB, "SELECT id, tenant_id, state FROM support_threads WHERE id = ? AND channel = 'email' AND email_from = ?", Number(tag[1]) - 1000, from.email)
    : await first<{ id: number; tenant_id: number; state: string }>(env.DB, "SELECT id, tenant_id, state FROM support_threads WHERE channel = 'email' AND email_from = ? AND subject = ? AND state != 'resolved' ORDER BY id DESC LIMIT 1", from.email, base.slice(0, 200));
  if (!thread) {
    // A customer whose confirmed account email matches: the ticket is theirs (they see it in the app too).
    const owner = await first<{ tenant_id: number }>(env.DB, "SELECT tenant_id FROM admin_users WHERE email = ? COLLATE NOCASE AND email_verified_at IS NOT NULL LIMIT 1", from.email);
    thread = await first<{ id: number; tenant_id: number; state: string }>(
      env.DB,
      `INSERT INTO support_threads (tenant_id, subject, status, last_from, created_at, updated_at, category, state, priority, channel, email_from, email_name, email_last_message_id)
       VALUES (?, ?, 'open', 'customer', ?, ?, 'question', 'new', 'normal', 'email', ?, ?, ?) RETURNING id, tenant_id, state`,
      owner?.tenant_id ?? OWNER_TENANT, base.slice(0, 200) || subject, now, now, from.email, from.name, messageId,
    );
  } else {
    await run(
      env.DB,
      "UPDATE support_threads SET last_from = 'customer', updated_at = ?, email_last_message_id = COALESCE(?, email_last_message_id), state = CASE WHEN state = 'new' THEN 'new' ELSE 'in_progress' END, status = 'open', closed_at = NULL WHERE id = ?",
      now, messageId, thread.id,
    );
  }
  await run(env.DB, "INSERT INTO support_messages (thread_id, sender, body, created_at) VALUES (?, 'customer', ?, ?)", thread!.id, body, now);
  await run(env.DB, "UPDATE support_email_in SET thread_id = ? WHERE email_id = ?", thread!.id, emailId);
  await notify(env, OWNER_TENANT, "support", `📧 إيميل للدعم رقم ${ticketNo(thread!.id)}: ${subject}\nمن ${from.name ? `${from.name} ` : ""}<${from.email}>`);
  return thread!.id;
}

/** Sends the team's reply on an email ticket, as a reply in the sender's thread. */
export async function sendSupportReply(env: Env, t: { id: number; subject: string; email_from: string; email_last_message_id: string | null }, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: "email_not_configured" };
  const from = env.SUPPORT_EMAIL_FROM || "دعم شيّك <support@shayyek.sa>";
  const headers: Record<string, string> = {};
  if (t.email_last_message_id) {
    headers["In-Reply-To"] = t.email_last_message_id;
    headers.References = t.email_last_message_id;
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [t.email_from],
      subject: replySubject(t.subject, t.id),
      text: body,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.7;white-space:pre-wrap">${esc(body)}</div>`,
      headers,
    }),
  });
  if (!r.ok) return { ok: false, error: `resend ${r.status}` };
  return { ok: true };
}
