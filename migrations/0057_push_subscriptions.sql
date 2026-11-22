-- Phone/desktop push notifications: one row per device (a browser's Web Push endpoint or the Android app's FCM token).
-- A device belongs to one signed-in user; signing in with another account on it moves the row to that account.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'fcm')),
  endpoint TEXT NOT NULL UNIQUE,   -- Web Push endpoint URL, or the FCM registration token
  p256dh TEXT,                     -- Web Push only: the browser's public key
  auth TEXT,                       -- Web Push only: the browser's auth secret
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_tenant ON push_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
