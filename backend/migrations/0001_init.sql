-- Thassa platform schema. Social graph + prediction markets.
--
-- Money columns are BIGINT token base units (payment token, 6 decimals assumed
-- but read from chain); prices are integer cents (1..99). One-word state
-- vocabularies from the platform spec are stored verbatim.
--
-- SHARDABILITY (spec §6.7): every table below documents its shard key. Social
-- tables shard by user_id (the owning user), market tables by market_id. No
-- transaction in the codebase spans two different shard keys; fan-out (feeds,
-- notifications) is computed at read time or via idempotent jobs. All primary
-- keys are UUIDv7 (time-ordered) for index locality.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- UUIDv7 generator (RFC 9562 layout: 48-bit unix-ms timestamp + random),
-- built on pgcrypto's gen_random_uuid until PG ships uuidv7() natively.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
	SELECT encode(
		set_bit(
			set_bit(
				overlay(uuid_send(gen_random_uuid())
					placing substring(int8send((extract(epoch FROM clock_timestamp())*1000)::bigint) FROM 3)
					FROM 1 FOR 6),
				52, 1),
			53, 1),
		'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

-- ---------------------------------------------------------------------------
-- Users (Privy-authenticated; embedded/linked wallet captured at login)
-- SHARD KEY: id (user_id)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    privy_did          TEXT UNIQUE NOT NULL,
    wallet_address     TEXT,
    username           CITEXT UNIQUE,
    display_name       TEXT,
    bio                TEXT,
    avatar_url         TEXT,
    links              JSONB NOT NULL DEFAULT '[]',
    is_private         BOOLEAN NOT NULL DEFAULT FALSE,
    trades_visibility  TEXT NOT NULL DEFAULT 'public' CHECK (trades_visibility IN ('public','private')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_wallet ON users(wallet_address);

-- Follows. Following a private account creates a 'pending' row (a follow
-- request); the followee approves/denies. Private-account content is visible
-- only to 'accepted' followers — enforced at the query layer.
-- SHARD KEY: followee_id (requests/approval live with the followed user).
CREATE TABLE follows (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending','accepted')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id, status);

-- ---------------------------------------------------------------------------
-- Idempotency (spec §6.7): every mutating endpoint may carry Idempotency-Key.
-- Replays return the stored response; same key + different request hash → 409.
-- SHARD KEY: user_id
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    key             TEXT NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method_path     TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_status INT,            -- NULL while the first request is in flight
    response_body   BYTEA,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key, user_id)
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);

-- ---------------------------------------------------------------------------
-- Posts & media
-- SHARD KEY: author_id / owner_id (user)
-- ---------------------------------------------------------------------------
CREATE TABLE posts (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    author_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption       TEXT,
    kind          TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','video','reel')),
    market_id     UUID,          -- soft reference across shard keys (no FK cascade semantics needed)
    -- The onchain uint256 affiliatePostId is uint256(post uuid bytes); the
    -- relayer registers post → payee before relaying affiliate-routed orders.
    affiliate_registered_at TIMESTAMPTZ,
    like_count    INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX idx_posts_created ON posts(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_posts_market ON posts(market_id);

-- Uploaded media. Rows are created at presign time (post_id NULL) and attached
-- to a post on creation. The ffmpeg worker fills hls_key and flips status.
-- SHARD KEY: owner_id (user)
CREATE TABLE post_media (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id     UUID REFERENCES posts(id) ON DELETE CASCADE,
    position    INT NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL CHECK (kind IN ('image','video')),
    s3_key      TEXT NOT NULL,
    hls_key     TEXT,          -- hls/{mediaId}/master.m3u8 once transcoded
    variant_key TEXT,          -- feed-size image variant
    width       INT,
    height      INT,
    duration_ms INT,
    status      TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','ready','failed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_post_media_post ON post_media(post_id, position);

-- ffmpeg job queue (claimed with FOR UPDATE SKIP LOCKED; N-worker safe).
-- SHARD KEY: media owner (via post_media.owner_id)
CREATE TABLE media_jobs (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    media_id   UUID NOT NULL REFERENCES post_media(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed')),
    error      TEXT,
    attempts   INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_jobs_status ON media_jobs(status, created_at);

-- Stories: 24h ephemeral media (post_media-like columns inline).
-- SHARD KEY: author_id (user)
CREATE TABLE stories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    author_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('image','video')),
    s3_key      TEXT NOT NULL,
    hls_key     TEXT,
    width       INT,
    height      INT,
    duration_ms INT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX idx_stories_author ON stories(author_id, expires_at);

-- SHARD KEY: story author (via story_id)
CREATE TABLE story_views (
    story_id   UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (story_id, viewer_id)
);

-- ---------------------------------------------------------------------------
-- Markets & trading
-- SHARD KEY: id (market_id) for markets/orders/fills/positions
-- ---------------------------------------------------------------------------
CREATE TABLE markets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    chain_market_id     BIGINT UNIQUE,
    creator_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title               TEXT NOT NULL DEFAULT '',
    question            TEXT NOT NULL,
    -- Structured settlement query JSON (spec §6.5b):
    -- {"question","category","rule","sources":[{"id","name","url"}]}.
    -- Stored verbatim (it is what goes onchain) and denormalized below.
    settlement_query    TEXT NOT NULL,   -- always public
    category            TEXT NOT NULL DEFAULT 'general'
                        CHECK (category IN ('sports','news','weather','price','general')),
    rule                TEXT NOT NULL DEFAULT 'single' CHECK (rule IN ('single','majority')),
    sources             JSONB NOT NULL DEFAULT '[]',
    status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','OPEN','MATCHED','SETTLING','SETTLED','VOID')),
    direction           BOOLEAN,         -- SETTLED outcome: true = YES
    yes_price_cents     INT,             -- best-price mirror (indexer-maintained)
    no_price_cents      INT,
    volume              BIGINT NOT NULL DEFAULT 0,   -- matched volume, token units
    creator_fee_accrued BIGINT NOT NULL DEFAULT 0,
    pending_bid_id      BIGINT,
    settle_requested_by UUID REFERENCES users(id),
    settle_auth         JSONB,           -- EIP-3009 payload funding the 5c fee
    settle_claimed_at   TIMESTAMPTZ,     -- worker claim marker (SKIP LOCKED queue)
    search              TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', question)) STORED,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_markets_search ON markets USING GIN (search);
CREATE INDEX idx_markets_question_trgm ON markets USING GIN (question gin_trgm_ops);
CREATE INDEX idx_markets_status ON markets(status, created_at DESC);
CREATE INDEX idx_markets_volume ON markets(volume DESC);

-- Relayer batches (queue bookkeeping; singleton batcher via advisory lock).
-- SHARD KEY: n/a (chain-worker bookkeeping, one logical shard per chain)
CREATE TABLE relayer_batches (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    status      TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','submitting','confirmed','failed')),
    tx_hash     TEXT,
    order_count INT NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relayer tx nonce ledger: nonce management survives failover (recovered from
-- max(chain pending nonce, max recorded nonce+1) on leadership acquisition).
-- SHARD KEY: n/a (one row-set per relayer key / chain)
CREATE TABLE relayer_txs (
    nonce      BIGINT PRIMARY KEY,
    kind       TEXT NOT NULL,       -- batch | create_market | cancel | settle_fee | settle | register_affiliate | send
    tx_hash    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generic relayed-call queue (wallet sends, redeems): claimed with FOR UPDATE
-- SKIP LOCKED by the relayer leader. SHARD KEY: user_id.
CREATE TABLE relayer_jobs (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    kind       TEXT NOT NULL CHECK (kind IN ('send','redeem')),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload    JSONB NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitted','confirmed','failed')),
    tx_hash    TEXT,
    error      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_relayer_jobs_status ON relayer_jobs(status, created_at);

-- SHARD KEY: market_id
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    market_id           UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side                TEXT NOT NULL CHECK (side IN ('yes','no')),
    price_cents         INT NOT NULL CHECK (price_cents BETWEEN 1 AND 99),
    shares              BIGINT NOT NULL CHECK (shares > 0),
    filled_shares       BIGINT NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'QUEUED'
                        CHECK (status IN ('SIGNING','QUEUED','RESTING','PARTIAL','FILLED','CANCELED')),
    chain_order_id      BIGINT,
    affiliate_post_id   UUID,           -- uint256(affiliate post uuid) in the signed order
    batch_id            UUID REFERENCES relayer_batches(id),
    -- Signed order fields (EIP-712) + funding auth (EIP-3009).
    maker_address       TEXT NOT NULL,
    max_cost            BIGINT NOT NULL DEFAULT 0,   -- token units authorized
    expiry              BIGINT NOT NULL DEFAULT 0,   -- unix seconds
    nonce               BIGINT NOT NULL DEFAULT 0,   -- per-maker sequential
    -- Signature carriage (spec §9): SignedOrder has no signature fields; the
    -- EIP-3009 auth's nonce equals the order's EIP-712 digest. The digest is
    -- the canonical onchain order identity.
    order_digest        TEXT UNIQUE,
    auth3009            JSONB,                       -- receiveWithAuthorization payload
    is_market_create    BOOLEAN NOT NULL DEFAULT FALSE, -- creator's opening order
    cancel_requested_at TIMESTAMPTZ,
    idempotency_key     TEXT UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_market ON orders(market_id, created_at DESC);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status) WHERE status IN ('QUEUED','RESTING','PARTIAL');
CREATE UNIQUE INDEX idx_orders_chain ON orders(market_id, chain_order_id) WHERE chain_order_id IS NOT NULL;

-- SHARD KEY: market_id. Unique (tx_hash, log_index) keeps indexer re-scans
-- harmless (ON CONFLICT DO NOTHING).
CREATE TABLE fills (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    market_id            UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    taker_order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,
    maker_order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,
    taker_chain_order_id BIGINT,
    maker_chain_order_id BIGINT,
    price_cents          INT NOT NULL,
    shares               BIGINT NOT NULL,
    fee                  BIGINT NOT NULL DEFAULT 0,
    tx_hash              TEXT,
    log_index            INT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX idx_fills_market ON fills(market_id, created_at DESC);

-- Maintained exclusively by the chain indexer. SHARD KEY: market_id.
CREATE TABLE positions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    market_id       UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side            TEXT NOT NULL CHECK (side IN ('yes','no')),
    shares          BIGINT NOT NULL DEFAULT 0,
    avg_price_cents NUMERIC(8,4) NOT NULL DEFAULT 0,
    realized_pnl    BIGINT NOT NULL DEFAULT 0,   -- token units, set at settlement
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (market_id, user_id, side)
);
CREATE INDEX idx_positions_user ON positions(user_id);

-- Every processed contract log, keyed (tx_hash, log_index): the indexer skips
-- logs already recorded, making overlapping backfills exactly-once.
-- SHARD KEY: n/a (per-chain bookkeeping)
CREATE TABLE chain_events (
    tx_hash    TEXT NOT NULL,
    log_index  INT NOT NULL,
    name       TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tx_hash, log_index)
);

-- Indexed payment-token transfers (wallet activity). SHARD KEY: n/a (chain).
CREATE TABLE transfers (
    tx_hash      TEXT NOT NULL,
    log_index    INT NOT NULL,
    from_addr    TEXT NOT NULL,
    to_addr      TEXT NOT NULL,
    amount       BIGINT NOT NULL,
    block_number BIGINT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX idx_transfers_from ON transfers(from_addr, block_number DESC);
CREATE INDEX idx_transfers_to ON transfers(to_addr, block_number DESC);

-- Indexer backfill cursor(s), stored in DB per spec §6.7.
CREATE TABLE chain_cursors (
    name         TEXT PRIMARY KEY,
    block_number BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Comments / likes / reactions (comments attach to a post OR a market)
-- SHARD KEY: post author for post comments, market_id for market comments;
-- likes/reactions shard with their subject.
-- ---------------------------------------------------------------------------
CREATE TABLE comments (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
    market_id  UUID REFERENCES markets(id) ON DELETE CASCADE,
    author_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  UUID REFERENCES comments(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    like_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((post_id IS NOT NULL)::int + (market_id IS NOT NULL)::int = 1)
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);
CREATE INDEX idx_comments_market ON comments(market_id, created_at);

-- Counter maintenance is idempotent: like_count increments only when the
-- unique likes insert actually adds a row.
CREATE TABLE likes (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('post','comment','market')),
    subject_id   UUID NOT NULL,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_type, subject_id, user_id)
);
CREATE INDEX idx_likes_subject ON likes(subject_type, subject_id);

CREATE TABLE reactions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('post','comment','market','message')),
    subject_id   UUID NOT NULL,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_type, subject_id, user_id)
);
CREATE INDEX idx_reactions_subject ON reactions(subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- Messaging. SHARD KEY: conversation_id (all rows of a thread colocate).
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    kind       TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm','group')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT,
    media_kind      TEXT CHECK (media_kind IN ('image','video')),
    s3_key          TEXT,
    hls_key         TEXT,
    reply_to_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications / push. SHARD KEY: user_id.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,               -- market.matched | order.filled | dm.message | post.liked | market.settled | follow.request | ...
    payload    JSONB NOT NULL DEFAULT '{}',
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE push_tokens (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL,
    platform   TEXT NOT NULL DEFAULT 'expo',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (token)
);

-- ---------------------------------------------------------------------------
-- Developer API keys (spec §6.9, Kalshi-style trade API). Only the SHA-256
-- hash is stored; the secret is shown once at creation. SHARD KEY: user_id.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,               -- display prefix (tsk_live_ab12…)
    key_hash     TEXT UNIQUE NOT NULL,        -- sha256 hex of the full secret
    scope        TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read','trade')),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- ---------------------------------------------------------------------------
-- Market generation (LLM agent) audit log + onramp sessions. SHARD: user_id.
-- ---------------------------------------------------------------------------
CREATE TABLE market_generation_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    raw_input       TEXT NOT NULL,
    sanitized_input TEXT NOT NULL,
    candidates      JSONB NOT NULL DEFAULT '[]',
    flagged         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE onramp_sessions (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('fiat','crypto')),
    status     TEXT NOT NULL DEFAULT 'created',
    payload    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
