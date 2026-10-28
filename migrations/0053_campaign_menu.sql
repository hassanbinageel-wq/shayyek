-- A campaign can answer a matching comment with the account's DM menu («القائمة التلقائية») instead of a content message.
ALTER TABLE campaigns ADD COLUMN send_menu INTEGER NOT NULL DEFAULT 0;
