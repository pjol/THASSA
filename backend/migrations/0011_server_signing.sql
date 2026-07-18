-- Server-side signing opt-in (trade API route 2): with this enabled, API-key
-- requests may submit UNSIGNED orders and the platform signs them through the
-- user's delegated Privy wallet. Off by default; the default API path stays
-- fully non-custodial (client-side signing).
ALTER TABLE users ADD COLUMN server_signing_enabled BOOLEAN NOT NULL DEFAULT false;
