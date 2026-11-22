import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b64url, fromB64 } from "../src/worker/lib/crypto";
import { allowedEndpoint, encryptWebPush, pushToTenant, saveSubscription, setPushFetch } from "../src/worker/services/push";
import { notify } from "../src/worker/services/notify";
import { DB, resetDb, TEST_ENV } from "./helpers";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const call = (path: string, init?: RequestInit) => SELF.fetch(new Request(BASE + path, init));
const enc = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) (o.set(x, i), (i += x.length));
  return o;
};

/** A browser's side: its keys, and decryption as RFC 8291 describes (independent of the server code). */
async function browser() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const decrypt = async (body: Uint8Array) => {
    const salt = body.slice(0, 16);
    const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const ct = body.slice(21 + idlen);
    expect(rs).toBe(4096);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, keys.privateKey, 256));
    const prkKey = await hmac(auth, ecdh);
    const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), pub, asPublic, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
    expect(pt[pt.length - 1]).toBe(2); // last-record delimiter
    return new TextDecoder().decode(pt.slice(0, -1));
  };
  return { p256dh: b64url(pub), auth: b64url(auth), decrypt };
}

async function tenantWithUser(name: string) {
  const now = Date.now();
  const t = await DB.prepare("INSERT INTO tenants (name, is_owner, status, created_at, updated_at) VALUES (?, 0, 'active', ?, ?) RETURNING id").bind(name, now, now).first<any>();
  const u = await DB.prepare("INSERT INTO admin_users (username, password_hash, tenant_id, created_at, updated_at) VALUES (?, 'x', ?, ?, ?) RETURNING id").bind(name, t.id, now, now).first<any>();
  return { tenantId: t.id as number, userId: u.id as number };
}

let sent: { url: string; init: RequestInit }[] = [];
let status = 201;
beforeEach(async () => {
  await resetDb();
  sent = [];
  status = 201;
  setPushFetch(async (input, init) => {
    sent.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status });
  });
});
afterEach(() => setPushFetch(null));

describe("push notifications", () => {
  it("encrypts a payload that the browser can decrypt (RFC 8291)", async () => {
    const b = await browser();
    const body = await encryptWebPush(enc.encode('{"title":"مرحبا"}'), b.p256dh, b.auth);
    expect(await b.decrypt(body)).toBe('{"title":"مرحبا"}');
  });

  it("only accepts real push services as endpoints", () => {
    expect(allowedEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(allowedEndpoint("https://web.push.apple.com/QW1")).toBe(true);
    expect(allowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(allowedEndpoint("https://evil.example/hook")).toBe(false);
    expect(allowedEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(allowedEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
  });

  it("sends a customer's notification only to that customer's devices", async () => {
    const a = await tenantWithUser("store_a");
    const b = await tenantWithUser("store_b");
    const ba = await browser();
    const bb = await browser();
    await saveSubscription(TEST_ENV, { tenantId: a.tenantId, userId: a.userId, kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/device-a", ...ba });
    await saveSubscription(TEST_ENV, { tenantId: b.tenantId, userId: b.userId, kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/device-b", ...bb });
    await notify(TEST_ENV, a.tenantId, "expiry", "⏰ اشتراكك ينتهي بعد 3 أيام\nجدّد عشان ما تتوقف الردود.");
    expect(sent.map((s) => s.url)).toEqual(["https://fcm.googleapis.com/fcm/send/device-a"]);
    const req = sent[0].init;
    expect((req.headers as any)["Content-Encoding"]).toBe("aes128gcm");
    expect((req.headers as any).Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const msg = JSON.parse(await ba.decrypt(new Uint8Array(req.body as ArrayBuffer)));
    expect(msg).toEqual({ title: "⏰ اشتراكك ينتهي بعد 3 أيام", body: "جدّد عشان ما تتوقف الردود.", link: "/subscription" });
  });

  it("frequent kinds (new follower) do not push", async () => {
    const a = await tenantWithUser("store_a");
    await saveSubscription(TEST_ENV, { tenantId: a.tenantId, userId: a.userId, kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/d", ...(await browser()) });
    await notify(TEST_ENV, a.tenantId, "new_follower", "متابع جديد");
    expect(sent).toHaveLength(0);
  });

  it("forgets a device the push service says is gone", async () => {
    const a = await tenantWithUser("store_a");
    await saveSubscription(TEST_ENV, { tenantId: a.tenantId, userId: a.userId, kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/gone", ...(await browser()) });
    status = 410;
    expect(await pushToTenant(TEST_ENV, a.tenantId, { title: "x", body: null, link: "/" })).toBe(0);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<any>();
    expect(n.n).toBe(0);
  });

  it("sends to the Android app through FCM with the service account", async () => {
    const a = await tenantWithUser("store_a");
    const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", rsa.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
    const env = { ...TEST_ENV, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "shayyek-test", client_email: "push@shayyek-test.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" }) };
    setPushFetch(async (input, init) => {
      sent.push({ url: String(input), init: init ?? {} });
      if (String(input).includes("oauth2")) return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      return Response.json({ name: "projects/shayyek-test/messages/1" });
    });
    await saveSubscription(env, { tenantId: a.tenantId, userId: a.userId, kind: "fcm", endpoint: "fcm-device-token-123" });
    expect(await pushToTenant(env, a.tenantId, { title: "رسالة جديدة", body: "من الإدارة", link: "/" })).toBe(1);
    expect(sent[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(sent[1].url).toBe("https://fcm.googleapis.com/v1/projects/shayyek-test/messages:send");
    expect((sent[1].init.headers as any).Authorization).toBe("Bearer ya29.test");
    const body = JSON.parse(String(sent[1].init.body));
    expect(body.message.token).toBe("fcm-device-token-123");
    expect(body.message.data.link).toBe("/");
    const row = await DB.prepare("SELECT last_status, last_error, last_sent_at FROM push_subscriptions").first<any>();
    expect(row.last_status).toBe(200);
    expect(row.last_error).toBeNull();
    expect(row.last_sent_at).toBeGreaterThan(0);
  });

  it("subscribes through the API, refuses foreign endpoints, and unsubscribes", async () => {
    await call("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }) });
    const r = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "a-very-strong-password" }) });
    const csrf = ((await r.json()) as any).csrf_token;
    const cookie = (r.headers.get("Set-Cookie") ?? "").split(";")[0];
    const h = { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf };
    const cfg = (await (await call("/api/push/config", { headers: h })).json()) as any;
    expect(fromB64(cfg.vapid_public_key)).toHaveLength(65);
    const again = (await (await call("/api/push/config", { headers: h })).json()) as any;
    expect(again.vapid_public_key).toBe(cfg.vapid_public_key); // made once
    const b = await browser();
    const bad = await call("/api/push/subscribe", { method: "POST", headers: h, body: JSON.stringify({ kind: "web", endpoint: "https://evil.example/x", ...b, decrypt: undefined }) });
    expect(bad.status).toBe(422);
    const ok = await call("/api/push/subscribe", { method: "POST", headers: h, body: JSON.stringify({ kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/mine", p256dh: b.p256dh, auth: b.auth }) });
    expect(ok.status).toBe(200);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<any>()).n).toBe(1);
    await call("/api/push/unsubscribe", { method: "POST", headers: h, body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/mine" }) });
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<any>()).n).toBe(0);
  });
});
