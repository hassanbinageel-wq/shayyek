-- An offer's discount can cover plans (purchase, renewal, upgrade), message top-ups, or both.
ALTER TABLE offers ADD COLUMN discount_scope TEXT NOT NULL DEFAULT 'plans';   -- plans | topups | both
-- Offers the system made by itself (the owner's automatic rule), e.g. "low_messages:<tenant>:<cycle>": one per cycle.
ALTER TABLE offers ADD COLUMN auto_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS offers_auto_key ON offers(auto_key) WHERE auto_key IS NOT NULL;
