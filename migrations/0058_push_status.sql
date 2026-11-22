-- The last delivery result per device, so a push that does not arrive can be diagnosed (no message text is kept).
ALTER TABLE push_subscriptions ADD COLUMN last_status INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_sent_at INTEGER;
