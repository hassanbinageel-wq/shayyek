-- Email to support@shayyek.sa becomes a support ticket (received through Resend), and replies go back by email.
ALTER TABLE support_threads ADD COLUMN channel TEXT NOT NULL DEFAULT 'app';   -- app | email
ALTER TABLE support_threads ADD COLUMN email_from TEXT;                     -- the sender's address (email tickets)
ALTER TABLE support_threads ADD COLUMN email_name TEXT;                     -- the sender's display name
ALTER TABLE support_threads ADD COLUMN email_last_message_id TEXT;          -- for In-Reply-To / References on our reply
-- Each received email is handled once (Resend may deliver a webhook more than once).
CREATE TABLE IF NOT EXISTS support_email_in (
  email_id TEXT PRIMARY KEY,
  thread_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_threads_email ON support_threads(email_from, updated_at DESC) WHERE email_from IS NOT NULL;
