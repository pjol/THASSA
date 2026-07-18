-- Admin identity + warp (spec §7c). Email capture on the users row drives
-- email-based admin matching: is_admin = email_verified AND lower(email) ∈
-- ADMIN_EMAILS (verified-email-only so a spoofed client email cannot grant
-- admin). Email is also the admin user-search key.
--
-- SHARD KEY: id (user_id) — extends the users table (spec §6.7).

ALTER TABLE users
    ADD COLUMN email          CITEXT,
    ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Case-insensitive equality lookup for the admin-membership probe. citext
-- already folds case, but a lower(email) btree keeps the probe index-backed.
CREATE INDEX idx_users_email        ON users (email);
CREATE INDEX idx_users_email_lower  ON users (lower(email::text));

-- Trigram indexes for admin user search (email OR username, ILIKE).
CREATE INDEX idx_users_email_trgm    ON users USING GIN (lower(email::text) gin_trgm_ops);
CREATE INDEX idx_users_username_trgm ON users USING GIN (lower(username::text) gin_trgm_ops);
