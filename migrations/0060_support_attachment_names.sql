-- The original file name of a ticket attachment (shown and used when downloading; email attachments keep their name).
ALTER TABLE support_messages ADD COLUMN att_name TEXT;
