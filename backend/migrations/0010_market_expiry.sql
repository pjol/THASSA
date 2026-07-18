-- Market expiration: unsettled markets past expires_at are auto-resolved
-- 50/50 (each matched share redeems at 50¢, both sides). resolved_fifty marks
-- that outcome so clients render "50/50" instead of a YES/NO direction.
ALTER TABLE markets ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN resolved_fifty BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_markets_expiry ON markets (expires_at)
    WHERE expires_at IS NOT NULL AND status IN ('OPEN','MATCHED','SETTLING');
