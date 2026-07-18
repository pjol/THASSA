# Thassa Platform Specification

Last updated: 2026-07-16. This document is the single source of truth for the Thassa platform build.
All components (contracts, backend, web, mobile) must conform to the interfaces, vocabulary, and
conventions defined here.

## 1. Strategic pivot

Thassa is moving from a zkTLS/Noir-proof oracle **protocol** to a **platform**:

1. **Settlement pivot (proof-of-authority)**: We no longer depend on a zkTLS attestor. The canonical
   settlement path is our own centralized node signing response blobs, verified onchain by a
   proof-of-authority verifier module (`ThassaPoAVerifier`, an owner-managed signer set that
   generalizes the existing `ThassaSignatureVerifier`). The zk paths (`rust_node/`, SP1, Noir)
   are retained as legacy/experimental and are no longer the target trust anchor.
2. **Product pivot**: On top of that settlement mechanism we build a social platform — an
   Instagram-style app (posts, stories, reels, DMs) with a Kalshi-style prediction market twist:
   users can attach a prediction market to any post, markets settle through the Thassa oracle
   (PoA node → hub → market contract callback).

## 2. Repository layout

```
THASSA/
  contracts/        Solidity (existing hub/oracle/verifiers + NEW markets contracts)
  node/             Go oracle fulfiller node (existing; resynced to ProofUpdateV2 envelope)
  backend/          NEW: Go platform backend (chi, Postgres, S3, WS, relayer, LLM market agent)
  web/              NEW: Next.js web app
  mobile/           NEW: Expo mobile app
  frontend/         legacy weather demo (unchanged, kept for oracle demo)
  rust_node/        legacy zk path (kept, not part of the platform)
  docs/             this spec + architecture docs
  docker-compose.yml  dev infra: postgres, minio (S3), anvil
```

Model app structure & conventions after `../ASSEMBLY` (go-chi backend, Next.js web, Expo mobile).

## 3. Chain & money

- **Chain**: Tempo (stablecoin L1). Dev: local Anvil. All chain params via env
  (`CHAIN_RPC_URL`, `CHAIN_ID`, contract addresses).
- **Payment asset**: a single stablecoin ("the payment token"), configurable
  (`PAYMENT_TOKEN_ADDRESS`). Assumed 6 decimals but code must read `decimals()`. In dev we deploy
  `MockUSD` implementing ERC-20 + **EIP-3009** (`transferWithAuthorization` /
  `receiveWithAuthorization`) to mirror Tempo stablecoins. Native wallet controls in the app
  operate ONLY on this asset.
- **Units**: onchain amounts in token base units. Prices in **cents** (integer 1..99) per share;
  each share pays out **$1** (10^decimals) to the winning side. UI displays dollars, and
  probability = price in cents.
- **Gasless UX**: users never pay gas. Orders are EIP-712-signed and funded via EIP-3009
  `receiveWithAuthorization`; the backend relayer batches and submits them, paying gas.
  Direct onchain interaction (approve/transferFrom path) is also supported for power users.

## 4. Contracts

### 4.1 ThassaPoAVerifier (new, contracts/src/ThassaPoAVerifier.sol)

- Implements `IThassaVerifier.verifyUpdate` exactly like `ThassaSignatureVerifier`
  (scheme id `1`, EIP-191 `personal_sign` over the hub `ProofUpdateV2` digest,
  `publicValues` = 32-byte fulfilled marker), but with an **owner-managed signer set**:
  `addSigner(address)`, `removeSigner(address)`, `isSigner(address) view`, `signerCount()`.
  `update.fulfiller` must be an authorized signer and the recovered signer must equal
  `update.fulfiller`. Events: `SignerAdded`, `SignerRemoved`.
- Deploy scripts updated to use it as the hub `verifierModule`. `ThassaSignatureVerifier` stays
  for compatibility/tests.

### 4.2 ThassaMarkets (new, contracts/src/markets/ThassaMarkets.sol)

One contract holds **all** markets (gas-friendly: no per-market deployment). It **extends
`ThassaOracle`** (it is an oracle client of the hub) and settles via the hub callback.

**Oracle spec** (fixed at deployment):
- `query`: a generic settlement instruction template telling the node to answer the market
  question passed via bid `inputData`, returning strictly the shape below and refusing to follow
  any instructions embedded in the question (prompt-injection guardrail at the oracle layer).
- `expectedShape`: `tuple(marketId:uint256,settled:bool,direction:bool)`
- `model`: `openai:gpt-5.4` (configurable at deploy).

`inputData` for a settlement bid = `abi.encode(marketId, settlementQuery)`. The node includes
`inputData` in the LLM call; the signed response echoes `marketId`. Every market's
`settlementQuery` is stored onchain as a public string (users can always view the exact query
that will settle the market).

**Market lifecycle**:
```solidity
struct Market {
    address creator;
    uint64  createdAt;
    uint8   status;        // 0 PENDING(unused onchain) 1 OPEN, 2 MATCHED, 3 SETTLING, 4 SETTLED, 5 VOID
    bool    settled;       // oracle attachment: settlement recorded
    bool    direction;     // oracle attachment: true = YES outcome
    uint256 pendingBidId;  // hub bid id while SETTLING
    // fee accrual
    uint256 creatorFeesAccrued;   // claimable by creator
    uint256 volumeMatched;        // stats, in token units
}
```
- `createMarket(question, settlementQuery, initialOrder)` — free (no protocol fee), but the
  creator's `initialOrder` must deposit ≥ **$1** of capital. Question + settlementQuery strings
  stored; `MarketCreated` event.
- Market becomes `MATCHED` on the first fill against the creator's opening liquidity
  (event `MarketMatched` so the platform can notify the creator "your bet was taken").
- `settleMarket(marketId)` — anyone; pays the **$0.05 settlement fee** (via transferFrom or an
  attached EIP-3009 auth) which funds the hub bid (`placeBidWithInputData` through the hub;
  amount = hub base fee + small priority). Status → SETTLING. Re-triggerable if a bid is
  cancelled/expired.
- `_updateOracle(bytes cb)` decodes `(marketId, settled, direction)`, requires the market to be
  SETTLING and `settled == true`, records outcome, status → SETTLED. `MarketSettled` event.
- `voidMarket(marketId)` — owner-only escape hatch → VOID; all deposits refundable.

**Order book (gas-friendly)**:
- Binary YES/NO. An order is always "buy `side` at limit price `p` cents for `amount` shares".
  Buy YES @ p matches resting buy NO @ ≥ 100−p (and vice versa). YES buyer escrows `p×shares`,
  NO buyer escrows `(100−p)×shares` (in token units); a matched pair fully collateralizes $1/share.
- Storage: per market & side, a `uint128` price-level bitmap (bit p set ⇔ liquidity at p) for
  O(1) best-price discovery, and per price level a FIFO queue of packed orders
  (`address maker` (160b) + `uint80 sharesRemaining` + flags — one slot per order where possible).
- Matching happens at order placement (take best crossing levels, rest remainder as maker).
  Price-time priority. Execution at the **maker's** price.
- Entry points:
  - `placeOrder(marketId, side, price, shares, affiliatePostId)` — direct path, funds via
    `transferFrom` (user pre-approves), callable by anyone onchain.
  - `placeOrdersBatch(SignedOrder[] orders, Auth3009[] auths)` — **relayer path**. Each
    `SignedOrder` is EIP-712 typed data
    `Order(marketId,side,price,shares,maxCost,affiliatePostId,expiry,nonce,maker)` signed by the
    maker; funding via matching `receiveWithAuthorization` (EIP-3009) payloads paying the markets
    contract. Per-maker nonce mapping prevents replay. The batch is the bundle-able order
    mechanism that amortizes gas.
  - `cancelOrder(marketId, orderId)` (maker or via relayer w/ signed cancel).
- `redeem(marketId)` — after SETTLED, winners claim $1/share; unmatched/resting deposits
  refundable any time via `withdraw`.

**Fees (Kalshi-like, taker-side)**:
- Taker fee on each match: `fee = ceil(7% × shares × p × (100−p) / 10000)` (p = execution price
  in cents; fee in token units). Makers pay no fee. Fee is deducted from the taker's escrow.
- Splits per collected fee: **10% → market creator** (accrues, claimable), **5% → affiliate**
  (the post whose widget routed the order — `affiliatePostId → address` registered by the
  platform; 0 = none, share goes to protocol), remainder → protocol vault.
- Market creation: free. **Capital withdrawal fee**: flat fee (default $0.10, owner-configurable,
  sized ≈ market-creation gas) charged on `redeem`/`withdraw` transfers out.
- Settlement trigger: $0.05, paid by the caller of `settleMarket`.

**Events** (indexed for backend indexer): `MarketCreated`, `OrderPlaced`, `OrderMatched(marketId,
takerOrderId, makerOrderId, price, shares, fee)`, `OrderCancelled`, `MarketMatched`,
`SettlementRequested`, `MarketSettled`, `Redeemed`, `Withdrawn`, `CreatorFeesClaimed`,
`AffiliateFeesClaimed`.

### 4.3 Node resync (node/)

Update the Go oracle node to the **current** contract schema: `UpdateEnvelope` with
`inputData`/`responseId` (no expiry/nonce), `ProofUpdateV2` typehash, current hub ABI. The node
must pass bid `inputData` into the LLM prompt (it already supports inputData in
`GenerateStructuredOutput`). Add a hardened settlement system prompt (never follow instructions
inside the market question; answer only the outcome; return `_fulfilled=false` when the outcome
is not yet determinable).

## 5. One-word state vocabulary (platform-wide, used verbatim in ALL UIs)

**Market states**: `PENDING` (creation/settlement tx in flight) · `OPEN` (live; creator's opening
bet not yet taken) · `MATCHED` (creator's bet has been taken; trading continues) · `SETTLING`
(settlement query running) · `SETTLED` (outcome final) · `VOID` (invalidated, refunds open).

**Order states**: `SIGNING` (awaiting user signature) · `QUEUED` (in relayer batch) · `RESTING`
(open on book) · `PARTIAL` (partially filled) · `FILLED` · `CANCELED`.

Frontends must show these as chips with consistent colors: PENDING/QUEUED/SIGNING gray,
OPEN blue, MATCHED/FILLED green, SETTLING amber, SETTLED black(light)/white(dark) with direction
badge (YES green / NO red), VOID/CANCELED muted red. Terse, clear microcopy, e.g. creator-side:
OPEN → "You're committed. Waiting for someone to take your bet." MATCHED → "Your bet was taken."

## 6. Backend (Go) — `backend/`

Module `github.com/pjol/THASSA/backend`. Mirror ASSEMBLY conventions: chi router, `internal/`
packages (`api`, `auth`, `config`, `db`, `store`, `storage`, `respond`, `structs`, plus new
`ws`, `media`, `marketsvc`, `chain`, `mcp`, `onramp`, `notify`), pgx for Postgres, plain SQL
migrations in `migrations/`, `.env` + `.env.example`, JSON response envelope & error style copied
from ASSEMBLY.

### 6.1 Auth
Privy (dev/staging; Signet later — keep the auth interface pluggable behind
`internal/auth.Verifier`). Middleware verifies the Privy access token (ES256 via Privy JWKS,
audience = `PRIVY_APP_ID`), upserts the user, injects user into context. Embedded/linked wallet
address captured from the Privy token/claims at login.

### 6.2 Data model (Postgres)
Tables (all `id uuid pk default gen_random_uuid()`, `created_at/updated_at timestamptz`):
- `users` (privy_did unique, wallet_address, username unique citext, display_name, bio, avatar_url,
  links jsonb, is_private bool default false, trades_visibility text default 'public')
- `follows` (follower_id, followee_id, status `pending|accepted` — pending only for private
  accounts; unique pair). Private-account enforcement + trades-visibility enforcement happen at
  the query layer (posts/stories/reels/trades of a private account visible only to accepted
  followers; trades additionally gated by trades_visibility; position badges on posts follow the
  same rule). `GET /v1/users/{username}/trades` returns the user's fills + settled PnL.
- `posts` (author_id, caption, kind text: `photo|video|reel`, market_id nullable, like_count,
  comment_count, deleted_at)
- `post_media` (post_id, position, kind image|video, s3_key, hls_key nullable, width, height,
  duration_ms, status uploading|processing|ready|failed)
- `stories` (author_id, media as post_media-like columns, expires_at = created_at + 24h)
- `story_views` (story_id, viewer_id)
- `comments` (post_id nullable, market_id nullable, author_id, parent_id nullable for replies,
  body, like_count) — a comment attaches to a post OR a market (check constraint)
- `likes` (subject_type post|comment|market, subject_id, user_id, unique triple)
- `reactions` (subject_type post|comment|market|message, subject_id, user_id, emoji, unique)
- `conversations` (kind dm|group), `conversation_members` (conversation_id, user_id, last_read_at),
  `messages` (conversation_id, sender_id, body, media s3/hls fields, reply_to_id)
- `markets` (chain_market_id bigint unique, creator_id, question, settlement_query, status
  (vocabulary above), direction nullable bool, yes_price_cents current best, volume, creator_fee_accrued,
  search tsvector + pg_trgm index)
- `orders` (market_id, user_id, side yes|no, price_cents, shares, filled_shares, status
  (vocabulary above), chain_order_id, affiliate_post_id, batch_id, sig fields, nonce)
- `fills` (market_id, taker_order_id, maker_order_id, price_cents, shares, fee, tx_hash)
- `positions` (market_id, user_id, side, shares, avg_price_cents, realized_pnl) — maintained by indexer
- `relayer_batches` (status building|submitting|confirmed|failed, tx_hash, order_count)
- `notifications` (user_id, kind, payload jsonb, read_at)
- `market_generation_logs` (user_id, raw_input, sanitized_input, candidates jsonb, flagged bool)
- `onramp_sessions` (user_id, provider, kind fiat|crypto, status, payload jsonb)

### 6.3 API (REST, `/v1`, JSON; cursor pagination `?cursor=&limit=` returning `{items, nextCursor}`)
- Auth/me: `GET /v1/me`, `PATCH /v1/me` (username, bio, links, avatar), `POST /v1/me/avatar`
- Users: `GET /v1/users/{username}`, `GET .../posts`, `POST/DELETE /v1/users/{id}/follow`,
  followers/following lists
- Media: `POST /v1/media` → presigned S3 PUT (+ server-side type/size validation);
  `POST /v1/media/{id}/complete` → enqueue ffmpeg HLS job for videos (segmented storage:
  `hls/{mediaId}/master.m3u8` + `.ts` segments in bucket); `GET /v1/media/{id}` status.
- Posts: `POST /v1/posts` (caption, media ids, optional attach-market payload), `GET /v1/feed`
  (followed + suggested, cursor), `GET /v1/posts/{id}`, `DELETE`, comments CRUD
  (`/v1/posts/{id}/comments`, replies via parent_id), likes/reactions
  (`PUT/DELETE /v1/likes`, `PUT/DELETE /v1/reactions` with subject_type/subject_id)
- Stories: `POST /v1/stories`, `GET /v1/stories` (followed users' active), view tracking
- Reels: `GET /v1/reels` (cursor feed of kind=reel posts)
- Explore: `GET /v1/explore/posts`, `GET /v1/explore/markets` (two tabs; markets ranked by volume/recency)
- DMs: `GET /v1/conversations` (with N most recent messages inlined for pre-fetch),
  `POST /v1/conversations`, `GET /v1/conversations/{id}/messages` (cursor),
  `POST /v1/conversations/{id}/messages` (text and/or media)
- Markets: `GET /v1/markets/search?q=` (existing markets, trigram+fts, top N),
  `POST /v1/markets/generate` (LLM candidates; see 6.5), `POST /v1/markets` (create via relayer,
  with initial signed order ≥ $1), `GET /v1/markets/{id}` (incl. public settlement query,
  status, order book summary), `GET /v1/markets/{id}/book`, `GET /v1/markets/{id}/posts`
  (top posts referencing it), `GET /v1/markets/{id}/comments` etc.,
  `POST /v1/markets/{id}/settle` (charges 5¢, triggers settlement)
- Orders: `POST /v1/orders` (EIP-712 signed order + EIP-3009 auth → relayer queue; response
  includes order id + `QUEUED`), `DELETE /v1/orders/{id}` (signed cancel),
  `GET /v1/orders?market=`, `GET /v1/positions`
- Wallet: `GET /v1/wallet` (balance of payment token, address), `POST /v1/wallet/send`
  (EIP-3009 auth relayed — payment token only), `GET /v1/wallet/activity`,
  `POST /v1/onramp/sessions` (kind fiat|crypto). **No stubs**: fiat = a fully implemented
  Stripe onramp/checkout provider (real API integration, keys via env; requests fail with a
  clear configuration error when keys are absent — no mock responses). Crypto = fully
  implemented cross-chain funding: direct deposit of the payment token on the home chain
  (unique deposit reference + chain watcher crediting arrival), plus cross-chain quotes/routes
  via a real bridge-aggregator API integration (LI.FI-style, keys/URL via env). Provider
  interface stays pluggable, but every shipped implementation must be real.
- Notifications: `GET /v1/notifications`, `POST /v1/notifications/read`

### 6.4 WebSocket (`/v1/ws`)

Auth is header-only (never a query param): mobile sets `Authorization: Bearer <token>`;
browsers, which can't set WebSocket headers, send the token via the `Sec-WebSocket-Protocol`
header as `["thassa-bearer", <token>]` (dev API keys: `["thassa-key", <key>]`). The server echoes
only the sentinel subprotocol back.

Single connection, JSON frames `{type, channel, payload}`; client subscribes/unsubscribes to:
- `dm:{conversationId}` — `message.new`, `typing.start/stop` (typing bubbles), `read`
- `book:{marketId}` — order-book deltas + trades (drives live order book UI)
- `user:{me}` — notifications (`market.matched` → "your bet was taken", `order.filled`,
  `dm.message`, `post.liked`, …), wallet/order state changes.

### 6.5 Market generation agent (LLM + MCP + guardrails)
- Input: free-text "attach market" query. Pipeline: (1) sanitize (length ≤ 200, strip control
  chars/URLs, reject empty); (2) FIRST search existing markets (`markets/search`) and return top
  matches; (3) on explicit "generate": LLM call (OpenAI structured output) that drafts up to 3
  candidate markets `{title, question, settlementQuery, suggestedCloseNote}`.
- The agent runs with an **MCP connection**: backend exposes an internal MCP server
  (`internal/mcp`) with a `search_markets(query)` tool over existing markets; the generation
  agent must call it and may only propose markets whose settlement outcome differs from every
  existing market (distinct-outcome constraint enforced both in the prompt and by a post-check
  that compares candidate settlement queries against near-duplicate existing ones; duplicates are
  dropped or mapped to the existing market).
- Prompt-injection guardrails: user text is enclosed in delimited data blocks and never
  interpolated into instructions; system prompt forbids following user-embedded instructions;
  output strictly schema-validated; settlement queries must be objective/verifiable statements
  with resolution source + date; a moderation/regex pass rejects attempts to reference
  system prompts, tools, or payouts-to-self conditions. Log to `market_generation_logs`.

### 6.5b Authoritative resolution sources (registry + MCP, consumed by the oracle nodes)

Market settlement must resolve against **known authoritative sources**, not open-ended LLM web
search. The backend hosts the source registry and exposes it to our oracle nodes over MCP; the
nodes fetch the sources **themselves** during the update process, separately from the LLM query.

- **Registry** (`internal/sources`, seeded via config/migration, publicly readable):
  categories with per-category resolution rules:
  - `sports` — ESPN (single primary source, rule `single`).
  - `news` — boolean "did X happen" questions; rule `majority`: a panel of sources (NYT, WSJ,
    Reuters, AP, BBC — configurable list) of which a **majority must concur** or no update is
    produced.
  - `weather` — numeric; rule `single`; exactly one allowed authoritative source
    (default: NWS/NOAA api.weather.gov).
  - `price` — asset pricing, numeric; rule `single`; exactly one allowed source per asset class
    (default: Coinbase spot for crypto, configurable per deployment).
  - `general` — fallback for uncategorized questions (LLM adjudication, clearly labeled).
  Rule of thumb encoded in the registry: **numeric data ⇒ exactly one publicly-disclosed
  source; boolean data ⇒ multi-source majority concurrence.**
- **Public disclosure**: settlement queries are structured JSON stored onchain and rendered in
  the UI: `{"question": "...", "category": "...", "rule": "single|majority",
  "sources": [{"id": "espn", "name": "ESPN", "url": "..."}]}`. Every resolution query involving
  single-source numeric data publicly names that source. `GET /v1/sources` lists the registry;
  market detail responses include the parsed sources.
- **MCP tools** (added to the backend MCP server, used by the market-generation agent AND by the
  oracle nodes): `list_sources(category?)`, `resolve_sources(question)` → suggested category +
  bound sources + rule. The generation agent must categorize each candidate market and bind its
  sources at generation time; candidates without a resolvable category fall back to `general`.
- **Node-side resolution** (node/): during fulfillment the node parses the structured settlement
  query from bid `inputData`, then **fetches the bound sources directly** (per-source HTTP
  adapters: ESPN endpoints, news RSS/APIs, NWS, pricing APIs) — this fetch happens in the node
  process, separate from and prior to any LLM call. The LLM adjudicates **only from the fetched
  evidence** (no web search) per source. For `majority` rules the node computes concurrence in
  code: each source yields an independent verdict; majority required, else `_fulfilled=false`
  (no update). For `single` rules the one bound source decides. Source unavailability ⇒
  `_fulfilled=false`, retry later. The node discovers/refreshes the registry via the backend MCP
  connection (`NODE_MCP_URL`), and caches it.

### 6.6 Chain services (`internal/chain`)
- **Relayer**: holds a funded key; queues signed orders; batches every `RELAYER_BATCH_MS` (default
  2000ms) or `RELAYER_BATCH_MAX` (default 25) into `placeOrdersBatch`. **Gas-sponsorship gating**:
  the relayer only ever signs/submits transactions to the allowlisted platform contracts
  (`ThassaMarkets`, hub) and only the whitelisted methods; every EIP-3009 auth is validated
  server-side to pay **to** the markets contract (or recipient for wallet sends) before relaying;
  per-user rate limits + max order size. Never relays arbitrary calldata.
- **Indexer**: subscribes to contract events (poll + backfill), maintains `orders/fills/positions/
  markets` tables and pushes WS deltas.
- **Settlement runner**: on `settle` request, collects 5¢ (from user's balance via EIP-3009 auth),
  calls `settleMarket`; monitors hub `AutoUpdateSubmitted`/`MarketSettled` to flip status and
  notify.

### 6.7 Scale: idempotency & shardability (production = region-based distributed setup, 1M+ users)

The backend must run correctly as N stateless instances across regions. Requirements:

- **Stateless API tier**: no in-memory session or cross-request state in handlers; anything an
  instance remembers must live in Postgres/S3/broker. Any instance can serve any request.
- **Idempotent mutations**: every mutating endpoint accepts an `Idempotency-Key` header
  (client-generated UUID). `idempotency_keys` table (key, user_id, method+path, request_hash,
  response_status, response_body, created_at, unique(key, user_id)); replays return the stored
  response; conflicting reuse (same key, different request_hash) → 409. Orders, posts, messages,
  market creation, sends, and settle requests MUST be idempotent end-to-end (double-submit never
  double-spends or double-posts).
- **Idempotent workers**: job queues (media transcode, relayer queue, settlement) are DB tables
  claimed with `SELECT ... FOR UPDATE SKIP LOCKED` + status transitions, safe under N concurrent
  workers; jobs are retryable without side-effect duplication.
- **Idempotent indexer**: chain events keyed by unique `(tx_hash, log_index)`; all event
  processing is upsert (`ON CONFLICT`), so re-scans and overlapping backfills are harmless;
  per-shard scan cursor stored in DB.
- **Singleton chain workers via leader election**: exactly one active relayer batcher and one
  settlement submitter per chain across the whole fleet — Postgres advisory locks
  (`pg_try_advisory_lock`) with the rest hot-standby; leadership loss handled gracefully.
  Relayer nonce management must survive failover (nonce from chain + pending table, not memory).
- **WS fanout across instances**: real-time delivery goes through a pub/sub broker abstraction
  (`internal/bus`): `Publish(topic, event)` / `Subscribe(topic)`. Dev implementation: in-process
  + Postgres LISTEN/NOTIFY; prod implementation: a **fully implemented** Redis pub/sub driver
  behind the same interface (env `BUS_DRIVER=pg|redis`, `REDIS_URL`). A WS connection on
  instance A must receive events produced on instance B. No placeholder drivers.
- **Shardable data model**: all IDs UUIDs (prefer UUIDv7 for index locality); no cross-entity
  serial dependencies; social tables partitionable by user_id and market tables by market_id
  (document the shard key per table in a comment atop the migration); avoid multi-shard-key
  transactions (fan-out writes like feed delivery are computed at read time or via idempotent
  jobs, never cross-shard txs). Counters (like_count etc.) maintained by idempotent increments
  keyed on the likes row insert success.
- **Region awareness**: config exposes `REGION`; health endpoint reports it; media served via
  bucket-per-region-capable config (S3 endpoint per instance env).

### 6.8 Storage & media
S3-style bucket (MinIO dev, `S3_*` env). Images stored original + resized variants. Videos:
raw upload → ffmpeg → HLS (H.264, 3 renditions where source allows, 4s segments) → bucket →
served via presigned/public-read URLs. Posts, stories, reels, and DM attachments all support
both photos and videos.

### 6.9 Developer API (Kalshi-style public trading API)

Programmatic access to markets, sharing the SAME user base as the app (one account, app +
API):

- **API keys**: managed by authenticated app users — `POST /v1/developer/keys` (name, scope
  `read`|`trade`; returns the secret ONCE), `GET /v1/developer/keys`, `DELETE /v1/developer/keys/{id}`.
  Secrets stored hashed (SHA-256), prefix shown for identification. Keys inherit the user's
  identity: §8.1 gating applies identically (the key's user_id is the OAuth-equivalent
  identifier).
- **Public market data** (no auth, rate-limited by IP): `GET /trade-api/v1/markets` (list/search,
  status, prices, volume), `GET /trade-api/v1/markets/{id}`, `.../book` (price levels),
  `.../trades` (fills), `.../sources` (resolution transparency).
- **Authenticated** (header `X-Thassa-Key: <key>`; scope `trade` for mutations, rate-limited per
  key): `POST /trade-api/v1/orders` — accepts the same non-custodial payload as the app
  (order fields + EIP-3009 auth with authNonce = order digest); `order.maker` must equal the
  key user's registered wallet. `DELETE /trade-api/v1/orders/{id}`, `GET .../orders`,
  `GET .../positions`, `GET .../fills`, `GET .../balance`. Same relayer gate + idempotency
  semantics as the app path.
- **WS market data**: the existing `/v1/ws` accepts `X-Thassa-Key` (or, in browsers, the
  `Sec-WebSocket-Protocol` header `["thassa-key", <key>]`) auth for `book:{marketId}`
  subscriptions. Never a query parameter.
- Errors/envelopes follow the same conventions as `/v1`.

## 7. Web (Next.js, `web/`) & Mobile (Expo, `mobile/`)

Both full-featured; share API client shapes and the state vocabulary. Model provider setup,
routing, and conventions on ASSEMBLY's `web/` and `mobile/`.

**Auth**: Privy (`@privy-io/react-auth` web, `@privy-io/expo` mobile) with embedded wallets;
EIP-712/EIP-3009 signing through the Privy wallet. Keep provider wrapper thin for later Signet swap.

**Design system**: Instagram-inspired, modern/slick, Thassa-branded.
- Colors: brand blue `#307CDE` (constant across themes); light mode: white bg `#FFFFFF`, near-black
  text `#0A0A0A`; **dark mode inverts black↔white** (bg `#0A0A0A`, text white), blue stays.
  YES `#12B76A`, NO `#F04438`, amber `#F59E0B` for SETTLING. Black used for highlights/accents in
  light mode, white in dark mode.
- Typography: Inter/system. Rounded-2xl cards, subtle borders, IG-like density.

**Screens (both platforms)**:
- Tabs: Home (feed), Explore, Create (+), Reels, Profile. DMs from home header. Stories rail atop feed.
- Feed: infinite scroll with **just-in-time prefetch** (fetch next page when ~3 posts from the end;
  media for the next few posts prefetched). Post card: media carousel, caption, like/comment/react,
  and the **market card** when attached: title, one-word state chip, YES/NO prices, quick-buy
  buttons, poster's position badge if they hold one, affiliate attribution built in. Settled
  markets show direction + poster's PnL on the same card.
- Create post: media picker → caption → **Attach market** field: typeahead search of existing
  markets (top matches) → pick one (simple $ amount input + "Advanced" dropdown: limit price,
  order book view) OR **Generate market** button → up to 3 LLM candidates → pick → set spend
  amount + **sliding scale for bet percentage** (maker price, i.e. what they'd pay) → Post:
  creates market (≥$1 initial capital) + posts order + publishes post atomically from the user's
  perspective, with clear PENDING → OPEN progression and later MATCHED notification.
- Market detail: prices/chart, order book (live via WS), positions, top posts tab, comments/likes/
  reactions, "Advanced" section exposing the **public settlement query**, and a **Settle market**
  button (5¢, confirmation sheet) when eligible; SETTLING/SETTLED states rendered per vocabulary.
- Explore: two tabs — Posts (grid) and Markets (list w/ state chips, volume, prices). Posts↔markets
  cross-linked both ways.
- DMs: conversation list (first pages pre-fetched for instant open), thread with WS typing
  bubbles, photo/video attachments, reactions.
- Reels: vertical swipe short-form video (HLS), infinite.
- Profile: avatar, username, bio, links, grid; tabs on every profile: **Posts** (grid), **Reels**,
  and **Trades** — the user's trade history (fills: market question, side, price, shares, state
  chip, PnL when settled) shown like any other social surface, respecting visibility settings.
  **Wallet tab** (own profile only): balance, receive (address/QR), send (payment token only),
  fund (fiat onramp + cross-chain crypto), activity, positions summary.
- Privacy settings (own profile → settings): **private account** toggle (IG-style: non-followers
  see only the profile header; following a private account creates a follow *request* the owner
  approves/denies) and **trades visibility** toggle (`public` | `private`; private hides the
  Trades tab and position badges on posts from everyone but the owner). Backend enforces both
  server-side (`users.is_private`, `users.trades_visibility`; `follows.status pending|accepted`;
  `GET /v1/users/{username}/trades` 403s when hidden; feed/post position badges omitted when
  trades are private). API: `PATCH /v1/me/settings`, follow-request endpoints
  (`GET /v1/me/follow-requests`, `POST /v1/follow-requests/{id}/approve|deny`).
- Notifications: in-app list + toasts; creator flow: OPEN "You're committed — waiting for a
  taker" → push/WS notify on MATCHED.

## 7b. Website (`website/`) — public home + developer docs

Separate Next.js site (static-export friendly) — the user-facing front door and developer hub.
Thassa-branded, sleek/modern, same design tokens as the apps (blue `#307CDE`, black/white
inversion dark mode). Model the scrolling behavior on `../ASSEMBLY/webpage` — full-viewport
scroll-snapped sections on the landing page.

- **Home** (`/`): scroll-snap hero + feature sections (social feed with markets, gasless
  trading, PoA-settled oracles, authoritative sources), product screenshots, CTAs to the web app
  and download page.
- **Download** (`/download`): App Store / Google Play badges (env-configurable URLs) + web app
  link.
- **Developer docs** (`/docs`): fully fleshed out —
  - Getting started: one account across app + API; create API keys in the web app
    (Settings → Developer); auth headers; rate limits; environments.
  - Protocol: PoA settlement architecture (hub, verifier, node, callback), markets contract
    (order book model, cent pricing, fees incl. taker formula + creator/affiliate splits,
    settlement lifecycle + state vocabulary, authoritative sources & majority rules),
    gasless orders (EIP-712 digest as EIP-3009 nonce), direct onchain usage.
  - API reference: every §6.9 endpoint with request/response examples (curl + TypeScript +
    Python), WS subscription protocol, error envelope, idempotency keys, pagination.
- Docs content must match §6.9/§9 exactly — no invented endpoints.

## 7c. Admin & warp (impersonation)

Email-based admin accounts with a **warp** capability: an admin can "prank ownership" of any
user (searchable by email) to view the app AS that user. First iteration is view-oriented;
more admin functionality comes later.

### 7c.1 Admin identity (backend)
- Config `ADMIN_EMAILS` (CSV, compared case-insensitively).
- **Email source**, in priority order, resolved at identity resolution and stored on the user:
  1. an `email` claim in the Privy access token, if present (parsed like the wallet claim);
  2. Privy's server API by DID when `PRIVY_APP_SECRET` is set — fetch the user, take the verified
     email linked account. (This is the concrete use for the app secret; add
     `internal/auth` Privy API client, cached.)
  3. otherwise unknown.
- `users` gains `email citext` (nullable, indexed) and `email_verified bool`. Sources (1)/(2)
  set `email_verified=true`. A client-supplied email (via `PATCH /v1/me`) may set `email` for
  display/search but leaves `email_verified=false`.
- **`is_admin = email_verified AND lower(email) ∈ ADMIN_EMAILS`** — verified email only, so a
  spoofed client email can never grant admin. Dev escape hatch `ADMIN_TRUST_UNVERIFIED_EMAIL`
  (default false; local dev only, documented insecure) lets unverified email satisfy the match
  when no app secret is configured.
- `GET /v1/me` returns `is_admin` for the real user.

### 7c.2 Warp mechanism (backend)
- Header `X-Thassa-Warp: <targetUserId>` on any request. Middleware, AFTER resolving the real
  identity: if the header is present AND the real user `is_admin` AND the target user exists →
  the **effective identity** for §8.1-gated data access becomes the target user; the real admin
  id is retained in context for audit. Header present but real user not admin → 403.
- **Read-only impersonation**: while a warp header is active, mutating requests
  (POST/PUT/PATCH/DELETE, except the warp/admin endpoints themselves) are rejected 403
  "read-only while warped". Warp changes *whose data you see*, never lets an admin act as a user.
  (Wallet-signing is impossible anyway — the admin lacks the target's embedded-wallet keys.)
- All §8.1 store calls use the effective id; admin-only endpoints always use the REAL admin id
  (warp can't escalate, even into another admin).
- `GET /v1/me` while warped returns the **effective (target) user** plus a
  `warp: { active:true, admin_email, viewing:{ id, username, email } }` object so the UI can
  render the target's app and show a warp bar.
- Admin endpoints (real-admin-gated, never warp-affected):
  - `GET /v1/admin/users?q=<email-or-username>` → search, returns `{id, username, email, avatar_url}`.
  - `POST /v1/admin/warp { user_id }` → validates the target exists; returns its summary (UX
    convenience; the header is the actual mechanism). `DELETE /v1/admin/warp` is a client no-op
    (drop the header).
- Audit: log every warp (`admin_email → target_id`) via the logger; an `admin_audit` table is a
  later addition.

### 7c.3 Admin UI (web + mobile)
Admin views are the SAME as normal user views (warp simply changes whose data loads), plus:
- When `me.is_admin`, an **Admin** entry (in settings) → a user search (by email) listing results
  with a **Warp** action per user.
- Warping stores the target id (web: context + localStorage; mobile: context + secure-store) and
  the API client attaches `X-Thassa-Warp: <id>` to every request; the app refetches `/v1/me` and
  now renders entirely as the target user.
- A persistent **warp banner** across the app: "Viewing as @username — Exit warp." Exit clears
  the target + header and refetches as self. While warped the UI is read-only (mutations are
  disabled/error via toast per the backend 403); the banner makes the state unmistakable.

## 7d. Social graph, mentions, notifications & performance (batch)

### 7d.1 Username changes — once per week
- Add `users.username_changed_at timestamptz` (nullable). On `PATCH /v1/me`, when the username
  actually changes and `now() - username_changed_at < 7 days`, reject `409`
  `{"error":"you can change your username once a week — try again in N days"}` (compute N). Set
  `username_changed_at = now()` only when the username changes. First-time set (onboarding) is
  free (null → allowed).

### 7d.2 @-mentions (stored by user id, rename-safe)
- Users can @-mention others in **post captions** (and comments). Mentions are stored by **user
  id**, never by username text, so a rendered mention always shows the mentioned user's CURRENT
  username and links to their profile even after they rename.
- **Input**: as the user types `@` + chars, the client calls `GET /v1/users/search?q=` (new:
  trigram over username + display_name, returns `{users:[UserBrief]}`, public, rate-limited) and
  shows an autocomplete. Selecting a user records a mention.
- **Wire format**: the client sends, alongside `caption`, a `mentions: [{ user_id, start, len }]`
  array (character offsets into the caption identifying each `@name` token). Backend validates
  offsets/ids, stores the caption verbatim **and** the mentions.
- **Storage**: `posts.mentions jsonb default '[]'` = `[{user_id, start, len}]`; plus a
  `post_mentions(post_id, user_id, primary key(post_id,user_id))` join table (indexed on
  `user_id`) for notification + "tagged" lookups. Same pattern optionally for `comments.mentions`.
- **Read**: post responses include `mentions: [{user_id, start, len, username, display_name,
  avatar_url}]` with the **current** resolved profile per id. The client renders the caption,
  replacing each `[start,len)` slice with a link to the mentioned user showing `@<current
  username>` (so renames propagate). Non-mention text renders plain.
- **Notification**: on post create, `NotifyMany` each mentioned user (except the author) with
  kind `post.mention`.

### 7d.3 Followers — browsable lists
- The `GET /v1/users/{username}/followers` and `/following` endpoints already exist and are
  visibility-gated. Add the missing UI on both clients: make the follower/following counts on a
  profile tappable → a list screen of `UserBrief` rows (avatar, @username, display name) each
  linking to the profile, with a follow/unfollow button where applicable. Add DB index
  `follows(follower_id, status)` for the following direction.

### 7d.4 Notifications tab + push
- The in-app notifications tab exists; ensure it renders the new kinds below with clear copy and
  a tap target (deep link) each.
- **Push (new, build end-to-end)**:
  - Backend `internal/push`: send Expo push via `https://exp.host/--/api/v2/push/send` (batch,
    handle receipts/errors, prune invalid tokens `DeviceNotRegistered`). Wire it as a second leg
    of `notify.Service.Notify`/`NotifyMany` (after the WS fanout): look up the target's
    `push_tokens` and send. Add index `push_tokens(user_id)`. Title/body per kind.
  - Mobile: add `expo-notifications`; register for push on login (`getExpoPushTokenAsync` →
    `POST /v1/me/push-token`), unregister on logout (`DELETE`); handle taps → deep link to the
    relevant screen; request permission with a friendly prompt.
- **Notification kinds & triggers** (each fires WS + in-app row + push):
  - `post.mention` — tagged in a post (7d.2).
  - `dm.message` — incoming DM (exists; add push).
  - `follow.new` — new follower (exists; add push). (`follow.request`/`follow.accepted` too.)
  - `position.swing` — the recipient's OWN held position swings **>50%** in either direction.
    Computed in the indexer on position update: compare new vs previous position magnitude
    (size or unrealized value); if `|Δ| / prev > 0.50`, notify the holder.
  - `following.large_entry` — someone you follow places an entry larger than **2× the average
    entry size across everyone you follow**. See 7d.5 for the O(1)/O(log n) aggregation.

### 7d.5 Performance: indexing & aggregation (O(1) / O(log n))
Every notification-related lookup — and hot queries generally — must be O(1) (indexed
point/counter lookup) or at worst O(log n) (btree range); no O(n) scans on the read path.
- **Denormalize counters** onto `users`: `follower_count`, `following_count`, `post_count`
  (replace the three per-read `COUNT(*)` subqueries in `GetProfileByUsername`). Maintain
  incrementally on follow accept/unfollow and post create/delete (same transaction; guard against
  negatives). Profile fetch becomes a single indexed row read.
- **Running entry stats** for the large-entry trigger: `user_entry_stats(user_id primary key,
  entry_count bigint, notional_sum numeric)` — O(1) upsert per entry; a user's average entry =
  `notional_sum/entry_count`. Per-follower aggregate `follow_entry_agg(follower_id primary key,
  following_notional_sum numeric, following_entry_count bigint)` maintained on follow/unfollow
  (add/subtract the followee's current stats) and on a followee entry (increment the followee's
  followers' aggs — a bounded async fan-out in a worker). The threshold check for a follower is
  then O(1): `entrySize > 2 * (following_notional_sum/following_entry_count)`. Document the
  fan-out bound; do it in the indexer/worker, not the request path.
- **Indexes to add**: `follows(follower_id, status)`; `push_tokens(user_id)`;
  `post_mentions(user_id)`; partial `notifications(user_id) where read_at is null` (fast unread
  count/badge); `user_entry_stats(user_id)` (PK); `follow_entry_agg(follower_id)` (PK). Audit all
  new queries have a supporting index.
- New migration file(s) for all schema above; keep existing migrations untouched.

## 8. Security priorities

### 8.1 Identity gating (SFLuv pattern — mandatory)

All queries for user-related data are **implicitly gated by the OAuth identifier**, following
github.com/SFLuv/app:

- The verified token's subject (Privy DID) is the ONLY source of identity. Middleware extracts
  it; handlers obtain it from context as their first act and 401/403 when absent.
- **Store-layer functions for user-owned data are keyed by the authenticated user id** — the
  DID/user_id parameter comes from the token, never from a path/query/body value
  (`...ByUser(ctx, userID, ...)`, `WHERE user_id = $1`). Owned-data reads and writes
  (wallet, orders, positions, DMs, notifications, settings, idempotency keys, follow requests,
  onramp sessions, media ownership) have no code path accepting a client-supplied user id.
- Client-supplied bodies never override identity: after decoding a request struct, the server
  overwrites any id/owner field with the token-derived id before it reaches the store.
- Where another user's id legitimately appears (viewing profiles, following), it selects the
  *subject*, and the *viewer's* token id is still passed for visibility gating (private
  accounts, trades visibility, DM membership) inside the query.
- WS channel subscriptions re-check the same ownership/membership rules server-side.

### 8.2 General priorities

Monetary system — non-negotiables: relayer contract/method allowlist (no arbitrary calldata,
EIP-3009 recipient checks); EIP-712 domain separation + per-user nonces + expiries on all signed
orders; server never holds user keys; strict input validation everywhere; S3 uploads
content-type/size-validated, keys unguessable; WS auth on connect + per-channel authz (DM
membership checks); rate limits on auth, orders, generation, uploads; LLM guardrails per 6.5;
idempotency keys on order/create endpoints; contracts: checks-effects-interactions, reentrancy
guards on token flows, pull-payments for claims, SafeERC20, explicit rounding in fee math
(round fees up, payouts down), replay protection via hub digests, owner functions behind
timelock-able owner; secrets only in env; no PII in logs.

## 9. Pinned contract interface (all components code against THIS)

ThassaMarkets external surface (final — backend/web/mobile must match exactly):

```solidity
enum Side { YES, NO } // 0 = YES, 1 = NO

struct SignedOrder {
    uint256 marketId;
    uint8   side;            // Side
    uint8   price;           // cents, 1..99 (limit price the maker pays per share)
    uint80  shares;          // number of $1 shares
    uint256 maxCost;         // token units the signer authorizes at most (escrow + fee headroom)
    uint256 affiliatePostId; // 0 = none
    uint64  expiry;          // unix seconds
    uint256 nonce;           // per-maker sequential
    address maker;
}
// EIP-712: domain {name:"ThassaMarkets", version:"1", chainId, verifyingContract}
// Order(uint256 marketId,uint8 side,uint8 price,uint80 shares,uint256 maxCost,uint256 affiliatePostId,uint64 expiry,uint256 nonce,address maker)

struct Auth3009 { // receiveWithAuthorization payload, from = order.maker, to = markets contract
    uint256 value; uint256 validAfter; uint256 validBefore; bytes32 authNonce;
    uint8 v; bytes32 r; bytes32 s;
}
// SIGNATURE CARRIAGE (final convention): SignedOrder carries no signature fields. For order
// placement, auth.authNonce MUST equal orderDigest(order) — the maker's EIP-712 typed-data
// digest (domain {ThassaMarkets, 1, chainId, contract}) — so the single EIP-3009 signature
// commits to both the payment and the order. Clients sign ONE thing: the ReceiveWithAuthorization
// typed data whose nonce is the order digest. `orderDigest(SignedOrder) view` is exposed onchain;
// the relayer must recompute and validate the binding before batching. For settlement auths
// (settleMarketWithAuth) the nonce is a random 32 bytes; only value >= settlementFee is required.
// New-market opening orders are signed with marketId = 0 and bound to the assigned id on creation.

function createMarket(string calldata question, string calldata settlementQuery,
    SignedOrder calldata initialOrder, Auth3009 calldata auth) external returns (uint256 marketId); // relayer path
function createMarketDirect(string calldata question, string calldata settlementQuery,
    uint8 side, uint8 price, uint80 shares) external returns (uint256 marketId);                    // transferFrom path
function placeOrdersBatch(SignedOrder[] calldata orders, Auth3009[] calldata auths) external;      // relayer bundle
function placeOrder(uint256 marketId, uint8 side, uint8 price, uint80 shares,
    uint256 affiliatePostId) external returns (uint256 orderId);                                    // direct path
function cancelOrder(uint256 marketId, uint256 orderId) external;
function settleMarket(uint256 marketId) external;              // pulls $0.05 via transferFrom
function redeem(uint256 marketId) external;                    // winner claims, minus withdrawal fee
function withdraw(uint256 amount) external;                    // free balance out, minus withdrawal fee
function claimCreatorFees(uint256 marketId) external;
function claimAffiliateFees(uint256 postId) external;
function registerAffiliatePost(uint256 postId, address payee) external; // platform role
function getMarket(uint256 marketId) external view returns (Market memory);
function bestPrices(uint256 marketId) external view returns (uint8 bestYes, uint8 bestNo);
function nonces(address maker) external view returns (uint256);

event MarketCreated(uint256 indexed marketId, address indexed creator, string question, string settlementQuery);
event OrderPlaced(uint256 indexed marketId, uint256 indexed orderId, address indexed maker, uint8 side, uint8 price, uint80 shares);
event OrderMatched(uint256 indexed marketId, uint256 takerOrderId, uint256 makerOrderId, uint8 price, uint80 shares, uint256 fee);
event OrderCancelled(uint256 indexed marketId, uint256 indexed orderId);
event MarketMatched(uint256 indexed marketId);                 // first fill vs creator's opening order
event SettlementRequested(uint256 indexed marketId, uint256 bidId, address indexed caller);
event MarketSettled(uint256 indexed marketId, bool direction);
```

Fee constants (owner-settable): `takerFeeBps = 700` (applied to `shares × p × (100−p) / 10000` dollars),
`creatorFeeShareBps = 1000`, `affiliateFeeShareBps = 500`, `withdrawalFlatFee` (default $0.10),
`settlementFee` (default $0.05).

## 10. Conventions inherited from ../ASSEMBLY (imitate precisely)

Auth vendor differs (we use **Privy**, needed for embedded wallets; ASSEMBLY uses Clerk) but the
structure is identical: thin JWT-verify middleware → `resolveIdentity` middleware (lazy user
provisioning, `Identity` on context via typed key) → route-scoped guards.

1. Layering: handlers contain zero SQL; all queries in `internal/store` grouped by domain.
2. Response envelope: success `respond.JSON(w, status, map[string]any{"posts": items, "next_cursor": c})`
   (named keys, never bare arrays); errors `respond.Error(w, status, "lowercase message")` → `{"error": msg}`.
3. Handler shape: `func (s *Server) handleXxx(w, r)`; `uuid.Parse(chiParam(r,"id"))` → 400 on bad ids;
   `respond.Decode` (5MiB cap, DisallowUnknownFields) into local `xxxRequest` structs (snake_case
   tags, pointer optionals); 500 `"failed to ..."`.
4. Router: chi with RequestID/RealIP/Logger/Recoverer/Timeout(30s)/CORS; `/health`; versioned `/v1`;
   authed `r.Group` with auth middlewares; `/v1/ws` inside the authed group.
5. Config: `must()` for required secrets, `get(k, default)`; `IN_PRODUCTION=false` → local-filesystem
   uploads via `PUT /v1/uploads/local/*` + static file serving (dev needs no cloud).
6. Migrations: numbered `NNNN_name.sql`, `//go:embed`, applied lexically on boot in per-file txs
   against `schema_migrations`.
7. Uploads: presigned-PUT, key `{scope}/{userID}/{unixnano}-{uuid}{ext}`, client persists public URL.
8. WS: gorilla, single app socket per client, per-user conn map + per-subject subscription maps,
   write/read pumps with ping/pong (50s/60s), non-blocking best-effort sends.
9. Frontend API client: shared `Api` class shape (web + mobile), token via auth SDK `getToken`
   per-request, `ApiError(status, body)` reading `body.error`; mobile adds retry/backoff + disk
   cache + friendly `errorMessage()`; upload helper = presign → PUT.
10. Mobile: expo-router, root `_layout.tsx` provider stack (Privy → Session → Theme → Stack),
    staged entry gate in `index.tsx` (loading → sign-in → onboarding → tabs), `lib/session.tsx`
    context loading `/v1/me` + config, single shared WS in `lib/ws.ts` with typed event union,
    custom bottom tab bar with raised center Create button.

## 11. Dev environment

`docker-compose.yml`: postgres:17, minio, anvil. `build.sh`-style scripts per ASSEMBLY. Seed
script creates demo users/posts/markets. Contracts deployed to anvil with `MockUSD` (EIP-3009),
hub + ThassaPoAVerifier + ThassaMarkets; node/ runs as the PoA fulfiller; backend relayer funded
with an anvil key.

### 11.1 boot.sh (single-command dev environment)

Repo-root `boot.sh` brings up the entire stack hooked together against a **local fork of Tempo**:

1. Loads `.env.boot` (from `.env.boot.example`). Key vars:
   - `TEMPO_FORK_RPC_URL` — upstream Tempo RPC to fork (empty ⇒ plain local anvil chain);
     `CHAIN_ID` (defaults to Tempo's id when forking).
   - `PAYMENT_TOKEN_ADDRESS` — existing token on the fork (empty ⇒ deploy `MockUSD`).
   - `PAYMENT_TOKEN_WHALE` — optional funded holder on the fork to impersonate for token funding.
   - `FUND_ADDRESSES` — CSV of env-configurable addresses (dev wallets, relayer, node signer,
     deployer) automatically funded on boot.
   - `FUND_ETH_AMOUNT` (gas), `FUND_TOKEN_AMOUNT` (payment tokens).
2. Starts infra (`docker compose up -d` postgres+minio), then `anvil --fork-url ...` (or plain).
3. **Funding via pranks** on the local chain: `anvil_setBalance` for gas on every
   `FUND_ADDRESSES` entry; payment tokens via `anvil_impersonateAccount` of
   `PAYMENT_TOKEN_WHALE` + `cast send --unlocked transfer(...)` per address (forked real token),
   or `mint(...)` when MockUSD was deployed.
4. Deploys hub + ThassaPoAVerifier + ThassaMarkets (skipping token deploy when forked token is
   configured), registers the node signer in the PoA verifier, and captures deployed addresses
   from the deploy script's machine-readable output.
5. Writes/updates a generated env block (contract addresses, RPC URL, chain id) into
   `backend/.env`, `node/.env`, `web/.env.local`, `mobile/.env`.
6. Starts backend (`go run ./cmd/server`), oracle node (`go run ./cmd/server`), web
   (`npm run dev`), and mobile (`npx expo start`) — logs to `logs/*.log`, PIDs tracked, single
   ctrl-C teardown (children + anvil; compose left running).
