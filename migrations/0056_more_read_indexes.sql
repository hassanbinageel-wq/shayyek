-- More indexes for the most-read queries (D1 free tier: 5M rows read per day).
-- Comments set aside unanswered (subscription ended / messages ran out), re-queued after renewal: only ignored
-- comments are indexed, so the search no longer walks every ignored comment of the account.
CREATE INDEX IF NOT EXISTS webhook_events_held ON webhook_events(account_ig_id, reason, event_time) WHERE status = 'ignored' AND event_type = 'comment';
-- The unread badge: only conversations where the person wrote after the last read are in this index.
CREATE INDEX IF NOT EXISTS participants_unread ON participants(account_id, last_user_message_at) WHERE last_user_message_at > COALESCE(inbox_read_at, 0);
