-- «قائمة تفاعلية»: each menu campaign keeps its own tree (JSON of the root node), separate from the inbox menu.
ALTER TABLE campaigns ADD COLUMN menu_root TEXT;
