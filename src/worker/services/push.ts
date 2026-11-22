/**
 * Push notifications to phones and desktops, outside the app:
 *  - Web Push (RFC 8030/8291/8292) for the website/PWA — VAPID key made once and kept encrypted in the database.
 *  - Firebase Cloud Messaging (HTTP v1) for the Android app — service account in the FCM_SERVICE_ACCOUNT_JSON secret.
 * Never throws: a failed push never blocks the notification it accompanies.
 */
import type { Env } from "../env";
import { all, first, OWNER_TENANT, run, settingKey } from "../lib/db";
import { b64url, decryptSecret, encryptSecret, fromB64 } from "../lib/crypto";

type Fetch = typeof fetch;
let fetchImpl: Fetch = (i, init) => fetch(i, init);
/** Tests replace the network. */
export function setPushFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}

const enc = new TextEncoder();
const VAPID_SETTING = "vapid_key";
const VAPID_AAD = "vapid-key";
const MAX_DEVICES_PER_USER = 10;

/** Push services a browser may hand us (anything else is refused, so the server never posts to arbitrary hosts). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export function allowedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface PushMessage {
  title: string;
  body: string | null;
  link: string;
}

// ---------------------------------------------------------------- VAPID key (made once, stored encrypted)

type VapidKey = { publicKey: string; jwk: JsonWebKey };

async function vapidKey(env: Env): Promise<VapidKey> {
  const key = settingKey(OWNER_TENANT, VAPID_SETTING);
  const read = async () => {
    const row = await first<{ value: string }>(env.DB, "SELECT value FROM app_settings WHERE key = ?", key);
    if (!row) return null;
    const v = JSON.parse(row.value) as { publicKey: string; ciphertext: string; iv: string };
    return { publicKey: v.publicKey, jwk: JSON.parse(await decryptSecret(v.ciphertext, v.iv, env.TOKEN_ENC_KEY, VAPID_AAD)) } as VapidKey;
  };
  const existing = await read();
  if (existing) return existing;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const sealed = await encryptSecret(JSON.stringify(jwk), env.TOKEN_ENC_KEY, VAPID_AAD);
  // First writer wins (two requests at once must not end up with two different keys).
  await run(env.DB, "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", key, JSON.stringify({ publicKey: b64url(pub), ...sealed }), Date.now());
  return (await read())!;
}

/** The public key browsers need to subscribe. */
export async function vapidPublicKey(env: Env): Promise<string> {
  return (await vapidKey(env)).publicKey;
}

async function vapidAuth(env: Env, endpoint: string, now: number): Promise<string> {
  const k = await vapidKey(env);
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: "mailto:support@shayyek.sa" })));
  const priv = await crypto.subtle.importKey("jwk", k.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${k.publicKey}`;
}

// ---------------------------------------------------------------- Web Push payload encryption (RFC 8291, aes128gcm)

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

/** Encrypts a payload for one browser. `salt` and `serverKeys` are only passed by tests. */
export async function encryptWebPush(payload: Uint8Array, p256dh: string, authSecret: string, salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys?: CryptoKeyPair): Promise<Uint8Array> {
  const uaPublic = fromB64(p256dh);
  const as = serverKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, as.privateKey, 256));
  const prkKey = await hmac(fromB64(authSecret), ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

// ---------------------------------------------------------------- Firebase Cloud Messaging (Android app)

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
let fcmToken: { token: string; exp: number; email: string } | null = null;

function serviceAccount(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return null;
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    return sa.project_id && sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}
export function fcmConfigured(env: Env): boolean {
  return !!serviceAccount(env);
}

async function fcmAccessToken(sa: ServiceAccount, now: number): Promise<string | null> {
  if (fcmToken && fcmToken.email === sa.client_email && fcmToken.exp > now + 60_000) return fcmToken.token;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", fromB64(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat, exp: iat + 3600 })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  const r = await fetchImpl(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${body}.${b64url(sig)}` }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  fcmToken = { token: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000, email: sa.client_email };
  return j.access_token;
}

// ---------------------------------------------------------------- Subscriptions

export async function saveSubscription(env: Env, s: { tenantId: number; userId: number; kind: "web" | "fcm"; endpoint: string; p256dh?: string | null; auth?: string | null }, now = Date.now()): Promise<boolean> {
  if (s.kind === "web" && (!allowedEndpoint(s.endpoint) || !s.p256dh || !s.auth)) return false;
  await run(
    env.DB,
    `INSERT INTO push_subscriptions (tenant_id, user_id, kind, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET tenant_id = excluded.tenant_id, user_id = excluded.user_id, kind = excluded.kind, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`,
    s.tenantId, s.userId, s.kind, s.endpoint, s.p256dh ?? null, s.auth ?? null, now, now,
  );
  // Keep each user's newest devices only.
  await run(
    env.DB,
    "DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)",
    s.userId, s.userId, MAX_DEVICES_PER_USER,
  );
  return true;
}

/** Removes one device of this user (only theirs). */
export async function removeSubscription(env: Env, userId: number, endpoint: string): Promise<void> {
  await run(env.DB, "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?", userId, endpoint);
}

// ---------------------------------------------------------------- Sending

/** Sends one notification to every device of a customer (tenant). Returns how many devices accepted it. */
export async function pushToTenant(env: Env, tenantId: number, msg: PushMessage, now = Date.now()): Promise<number> {
  try {
    const subs = await all<{ id: number; kind: string; endpoint: string; p256dh: string | null; auth: string | null }>(
      env.DB,
      "SELECT id, kind, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = ? ORDER BY id LIMIT 50",
      tenantId,
    );
    if (!subs.length) return 0;
    const payload = { title: msg.title.slice(0, 120), body: (msg.body ?? "").slice(0, 300), link: msg.link };
    const sa = serviceAccount(env);
    let sent = 0;
    const dead: number[] = [];
    for (const s of subs) {
      try {
        if (s.kind === "web" && s.p256dh && s.auth) {
          const body = await encryptWebPush(enc.encode(JSON.stringify(payload)), s.p256dh, s.auth);
          const r = await fetchImpl(s.endpoint, {
            method: "POST",
            headers: { Authorization: await vapidAuth(env, s.endpoint, now), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" },
            body,
          });
          if (r.ok) sent++;
          else if (r.status === 404 || r.status === 410) dead.push(s.id);
        } else if (s.kind === "fcm" && sa) {
          const token = await fcmAccessToken(sa, now);
          if (!token) continue;
          const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              message: {
                token: s.endpoint,
                notification: { title: payload.title, body: payload.body || undefined },
                data: { link: payload.link },
                android: { priority: "HIGH", notification: { sound: "default" } },
              },
            }),
          });
          if (r.ok) sent++;
          else if (r.status === 404 || (r.status === 400 && /UNREGISTERED|registration token/i.test(await r.text()))) dead.push(s.id);
        }
      } catch (e) {
        console.error("push failed", String(e).slice(0, 200));
      }
    }
    if (dead.length) await run(env.DB, `DELETE FROM push_subscriptions WHERE id IN (${dead.map(() => "?").join(",")})`, ...dead);
    return sent;
  } catch (e) {
    console.error("push failed", String(e).slice(0, 200));
    return 0;
  }
}
