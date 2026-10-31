-- Indexes for the most-read queries (D1 free tier: 5M rows read per day).
-- Inbox list and unread badge: newest conversations of one account without scanning all its people.
CREATE INDEX IF NOT EXISTS participants_account_last_message ON participants(account_id, last_message_at);
CREATE INDEX IF NOT EXISTS participants_account_last_user_message ON participants(account_id, last_user_message_at);
-- Today's usage estimate counts today's insight snapshots only.
CREATE INDEX IF NOT EXISTS media_insights_captured ON media_insights(captured_at);
CREATE INDEX IF NOT EXISTS account_insights_captured ON account_insights(captured_at);
