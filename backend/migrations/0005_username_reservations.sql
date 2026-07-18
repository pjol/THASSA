-- Username reservations (spec §7c admin, §7d.1 username changes). Two layers of
-- protection over the username-claim path:
--   1. IMPLICIT: every 1–4 character username is reserved by default (enforced
--      by a length check in the claim path, not stored here) — non-admins get
--      the same "username taken" 409 they'd see for an in-use name, so a
--      reserved short name is indistinguishable from a taken one. Admins are
--      exempt.
--   2. EXPLICIT: an admin can whitelist a specific email for a specific
--      username (this table). Once a row exists, ONLY a claimer whose verified
--      account email matches may take that username — everyone else (admins
--      excepted) gets "username taken". A whitelist row for a 1–4 char name is
--      how that reserved short name becomes claimable, by exactly that email.
--
-- username is CITEXT so the match is case-insensitive (mirrors users.username);
-- email is CITEXT so the verified-email comparison is case-insensitive too.
--
-- SHARD KEY: username (the PK) — a small global control table (spec §6.7).

CREATE TABLE username_reservations (
    username   CITEXT PRIMARY KEY,
    email      CITEXT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reverse lookup: which usernames are whitelisted to an email.
CREATE INDEX idx_username_reservations_email ON username_reservations (email);
