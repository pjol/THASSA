-- Social-graph batch (spec §7d): username-change throttle, @-mentions,
-- denormalized profile counters, push-token indexing, and the running
-- aggregates that make the position.swing / following.large_entry
-- notification triggers O(1) on the read/check path.
--
-- SHARD KEY: user_id for every table/column below (they extend the social
-- graph, all keyed by the owning user), matching spec §6.7.

-- ---------------------------------------------------------------------------
-- 7d.1 Username changes — once per week.
-- Nullable: first set (onboarding) is free (NULL ⇒ allowed).
-- 7d.5 Denormalized profile counters (replace the three COUNT(*) subqueries in
-- GetProfileByUsername). Maintained incrementally on follow accept/unfollow and
-- post create/delete; backfilled below.
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN username_changed_at TIMESTAMPTZ,
    ADD COLUMN follower_count      INT NOT NULL DEFAULT 0,
    ADD COLUMN following_count     INT NOT NULL DEFAULT 0,
    ADD COLUMN post_count          INT NOT NULL DEFAULT 0;

-- @-mention autocomplete (GET /v1/users/search) trigrams over display_name;
-- username already has idx_users_username_trgm from 0002.
CREATE INDEX idx_users_display_name_trgm ON users USING GIN (lower(display_name) gin_trgm_ops);

UPDATE users u SET
    follower_count  = (SELECT count(*) FROM follows f WHERE f.followee_id = u.id AND f.status = 'accepted'),
    following_count = (SELECT count(*) FROM follows f WHERE f.follower_id = u.id AND f.status = 'accepted'),
    post_count      = (SELECT count(*) FROM posts p WHERE p.author_id = u.id AND p.deleted_at IS NULL);

-- ---------------------------------------------------------------------------
-- 7d.2 @-mentions (stored by user id, rename-safe).
-- posts.mentions is the verbatim [{user_id,start,len}] wire payload (character
-- offsets into the caption). post_mentions is the normalized join used for
-- notification + "tagged" lookups, indexed on user_id.
-- ---------------------------------------------------------------------------
ALTER TABLE posts ADD COLUMN mentions JSONB NOT NULL DEFAULT '[]';

CREATE TABLE post_mentions (
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_post_mentions_user ON post_mentions(user_id);

-- ---------------------------------------------------------------------------
-- 7d.4/7d.5 Running entry stats for the large-entry trigger.
--   user_entry_stats: a user's own entry count + summed notional (O(1) upsert
--     per entry). A user's average entry = notional_sum / entry_count.
--   follow_entry_agg: per-follower rollup of everyone they follow (O(1) check).
-- NOTIONAL UNIT: shares × effective-price-in-cents (cents·shares). The trigger
-- is a ratio (size vs 2×average) so the unit cancels; this keeps it token-unit
-- agnostic and SQL-backfillable.
-- ---------------------------------------------------------------------------
CREATE TABLE user_entry_stats (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    entry_count  BIGINT  NOT NULL DEFAULT 0,
    notional_sum NUMERIC NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE follow_entry_agg (
    follower_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    following_notional_sum NUMERIC NOT NULL DEFAULT 0,
    following_entry_count  BIGINT  NOT NULL DEFAULT 0,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill user_entry_stats from existing orders (entry = order placement).
INSERT INTO user_entry_stats (user_id, entry_count, notional_sum)
SELECT o.user_id, count(*),
       COALESCE(SUM(o.shares * (CASE WHEN o.side = 'yes' THEN o.price_cents ELSE 100 - o.price_cents END)), 0)
FROM orders o
GROUP BY o.user_id
ON CONFLICT (user_id) DO NOTHING;

-- Backfill follow_entry_agg: each follower rolls up its accepted followees'
-- current stats.
INSERT INTO follow_entry_agg (follower_id, following_notional_sum, following_entry_count)
SELECT f.follower_id,
       COALESCE(SUM(ues.notional_sum), 0),
       COALESCE(SUM(ues.entry_count), 0)
FROM follows f
LEFT JOIN user_entry_stats ues ON ues.user_id = f.followee_id
WHERE f.status = 'accepted'
GROUP BY f.follower_id
ON CONFLICT (follower_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7d.5 Indexing: every new query has a supporting index; no O(n) read scans.
-- ---------------------------------------------------------------------------
-- Following-direction lookups + the followee-fanout (follows(followee_id,...)
-- already exists as idx_follows_followee from 0001).
CREATE INDEX idx_follows_follower ON follows(follower_id, status);
-- Push-token lookup by target user (notify push leg).
CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);
-- Fast unread-count / badge probe.
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
