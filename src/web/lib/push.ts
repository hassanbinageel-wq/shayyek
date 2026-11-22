/**
 * Phone/desktop push notifications for this device: Web Push in the browser/PWA, Firebase (FCM) in the Android app.
 * The server only ever gets this device's push address; turning it off removes it.
 */
import { api } from "../api";
import { APP_TARGET, isNative } from "../platform";

const NATIVE_TOKEN = "hsn_push_token";
type Config = { vapid_public_key: string; fcm: boolean };

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const webCapable = () => APP_TARGET === "web" && typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Whether this device can get push notifications at all (and, for the app, whether the server is set up for it). */
export async function pushAvailable(): Promise<boolean> {
  if (isNative) return (await api<Config>("/api/push/config").catch(() => null))?.fcm === true;
  return webCapable();
}

/** iPhone/iPad Safari only allows web push once the site is added to the Home Screen. */
export const needsHomeScreen = () =>
  APP_TARGET === "web" && /iPhone|iPad|iPod/.test(navigator.userAgent) && !(window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone);

export function pushBlocked(): boolean {
  return webCapable() && Notification.permission === "denied";
}

export async function pushEnabled(): Promise<boolean> {
  if (isNative) return !!store.get(NATIVE_TOKEN);
  if (!webCapable() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}

function keyBytes(b64url: string): Uint8Array {
  const s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function nativeToken(): Promise<string> {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      void ok.then((h) => h.remove());
      void bad.then((h) => h.remove());
      fn();
    };
    const ok = PushNotifications.addListener("registration", (t) => finish(() => resolve(t.value)));
    const bad = PushNotifications.addListener("registrationError", (e) => finish(() => reject(new Error(e.error))));
    PushNotifications.register().catch((e) => finish(() => reject(e)));
    setTimeout(() => finish(() => reject(new Error("timeout"))), 20_000);
  });
}

/** Turns push on for this device. Returns false if the person refused the permission. */
export async function enablePush(): Promise<boolean> {
  if (isNative) {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return false;
    const token = await nativeToken();
    await api("/api/push/subscribe", { method: "POST", body: { kind: "fcm", endpoint: token } });
    store.set(NATIVE_TOKEN, token);
    return true;
  }
  if ((await Notification.requestPermission()) !== "granted") return false;
  const cfg = await api<Config>("/api/push/config");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.vapid_public_key) as BufferSource }));
  const j = sub.toJSON();
  await api("/api/push/subscribe", { method: "POST", body: { kind: "web", endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth } });
  return true;
}

/** Turns push off for this device (also on sign-out, so the next person on this device doesn't get them). */
export async function disablePush(): Promise<void> {
  if (isNative) {
    const token = store.get(NATIVE_TOKEN);
    store.set(NATIVE_TOKEN, null);
    if (token) await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: token } }).catch(() => undefined);
    return;
  }
  if (!webCapable()) return;
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** App start (Android): a tap on a notification opens its page; a renewed device token is sent again. */
const ASKED = "hsn_push_asked";

/**
 * Right after the first sign-in on a device, offer notifications once: the app shows the phone's own permission
 * dialog; the website (which needs a tap first) shows a small banner. A "no" is never asked again — Settings can still turn it on.
 */
export async function autoAskNative(): Promise<void> {
  if (!isNative || store.get(ASKED)) return;
  store.set(ASKED, "1");
  if ((await pushEnabled()) || !(await pushAvailable())) return;
  await enablePush().catch(() => undefined);
}
export async function shouldOfferWeb(): Promise<boolean> {
  if (!webCapable() || needsHomeScreen() || store.get(ASKED) || Notification.permission !== "default") return false;
  return !(await pushEnabled());
}
export function markAsked(): void {
  store.set(ASKED, "1");
}

let started = false;
export async function initNativePush(): Promise<void> {
  if (!isNative || started) return;
  started = true;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
    const link = (a.notification.data as { link?: string } | undefined)?.link;
    if (typeof link === "string" && link.startsWith("/")) location.hash = `#${link}`;
  });
  if (!store.get(NATIVE_TOKEN)) return;
  try {
    const token = await nativeToken();
    if (token !== store.get(NATIVE_TOKEN)) {
      await api("/api/push/subscribe", { method: "POST", body: { kind: "fcm", endpoint: token } });
      store.set(NATIVE_TOKEN, token);
    }
  } catch {
    /* offline or signed out: tried again next start */
  }
}
