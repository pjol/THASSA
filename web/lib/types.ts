// Shared DTOs mirroring the Go backend (spec §6.2/§6.3) plus the one-word
// state vocabulary (spec §5) as string-literal unions. snake_case fields
// mirror the JSON wire format.

// ---------------------------------------------------------------- vocabulary

export type MarketStatus =
  | "PENDING"
  | "OPEN"
  | "MATCHED"
  | "SETTLING"
  | "SETTLED"
  | "VOID";

export type OrderStatus =
  | "SIGNING"
  | "QUEUED"
  | "RESTING"
  | "PARTIAL"
  | "FILLED"
  | "CANCELED";

export type ChipState = MarketStatus | OrderStatus;

export type Side = "yes" | "no";

// --------------------------------------------------------------------- users

export interface UserLite {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

// Follower/following list rows (spec §7d.3). The pinned contract guarantees
// the UserLite fields; the backend may additionally include viewer-relative
// follow state, which — when present — drives an inline follow button.
export interface UserBrief extends UserLite {
  is_following?: boolean;
  follow_requested?: boolean;
  private?: boolean;
}

export interface User extends UserLite {
  bio: string | null;
  links: string[];
  private: boolean;
  trades_public: boolean;
  follower_count: number;
  following_count: number;
  post_count: number;
  // Viewer-relative:
  is_following: boolean;
  follow_requested: boolean;
  is_self: boolean;
  wallet_address: string | null;
}

// Active-warp descriptor (spec §7c.2): present on /v1/me ONLY while an admin is
// warped. `me` itself is then the effective (target) user; `warp.viewing` names
// that target and `warp.admin_email` the real admin behind the impersonation.
export interface WarpInfo {
  active: boolean;
  admin_email: string;
  viewing: {
    id: string;
    username: string;
    email: string;
  };
}

export interface Me extends User {
  privy_did: string;
  onboarded: boolean;
  // True for the REAL user when their verified email is an admin (spec §7c.1).
  // When warped, /v1/me returns the target user and this reflects the target
  // (typically absent/false) — real-admin gating uses `warp` being absent.
  is_admin?: boolean;
  // Present only while warped; drives the persistent warp banner.
  warp?: WarpInfo | null;
}

// Admin user-search result (spec §7c.2, GET /v1/admin/users).
export interface AdminUser {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
}

// Username whitelist row (spec §7c, GET/POST /v1/admin/username-reservations):
// the email permitted to claim `username`.
export interface UsernameReservation {
  username: string;
  email: string;
  created_at: string;
}

// --------------------------------------------------------------------- media

export type MediaKind = "image" | "video";
export type MediaStatus = "uploading" | "processing" | "ready" | "failed";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  url: string; // image URL or video poster/original
  hls_url: string | null; // master.m3u8 for videos
  width: number;
  height: number;
  duration_ms: number | null;
  status: MediaStatus;
  alt?: string | null;
}

// ------------------------------------------------------------------- markets

// Structured settlement details (spec §6.5b): every market resolves through a
// named rule + explicit disclosed sources, surfaced verbatim in the UI for
// transparency. The legacy `settlement_query` string remains authoritative and
// onchain; `settlement`, when present, powers the richer "how it settles" copy.
export type SettlementRule = "single" | "majority";
export interface SettlementSource {
  id: string;
  name: string;
  url: string;
}
export interface Settlement {
  question: string;
  category?: string | null;
  rule: SettlementRule;
  sources: SettlementSource[];
}

export interface Market {
  id: string; // backend uuid
  chain_market_id: number; // onchain id (signing target)
  creator: UserLite;
  question: string;
  settlement_query: string; // always public (spec §4.2)
  settlement?: Settlement | null; // structured resolution details (spec §6.5b)
  status: MarketStatus;
  direction: boolean | null; // SETTLED: true = YES
  yes_price_cents: number; // current best YES price (probability)
  no_price_cents: number;
  volume: string; // token units as decimal string (dollars-ish, formatted client-side)
  created_at: string;
  // The viewer's own position in this market, when the backend attaches it.
  my_position?: Position | null;
}

export interface Position {
  market_id: string;
  market?: Market;
  side: Side;
  shares: number;
  avg_price_cents: number;
  realized_pnl: string; // token units, signed decimal string
  unrealized_pnl?: string | null;
}

// Market as embedded in a post card: includes the poster's position (omitted
// by the server when the poster's trades are private).
export interface PostMarket extends Market {
  poster_position?: Position | null;
  poster_pnl?: string | null; // settled PnL in token units
}

export interface BookLevel {
  price_cents: number;
  shares: number;
}

export interface OrderBook {
  market_id: string;
  yes: BookLevel[]; // resting buy-YES bids, best first
  no: BookLevel[]; // resting buy-NO bids, best first
  last_trade_price_cents: number | null;
}

export interface Order {
  id: string;
  market_id: string;
  market?: Market;
  side: Side;
  price_cents: number;
  shares: number;
  filled_shares: number;
  status: OrderStatus;
  affiliate_post_id: string | null;
  created_at: string;
}

export interface Trade {
  id: string;
  market_id: string;
  market_question: string;
  market_status: MarketStatus;
  direction: boolean | null;
  side: Side;
  price_cents: number;
  shares: number;
  status: OrderStatus;
  pnl: string | null; // settled PnL, token units
  created_at: string;
}

export interface MarketCandidate {
  title: string;
  question: string;
  settlement_query: string;
  suggested_close_note: string | null;
  // Structured resolution preview (spec §6.5b), when the generator supplies it,
  // so a poster can review exactly how a not-yet-created market would settle.
  category?: string | null;
  rule?: SettlementRule;
  sources?: SettlementSource[];
  // If the generator mapped the query onto an existing market instead.
  existing_market?: Market | null;
}

// --------------------------------------------------------------------- posts

export type PostKind = "photo" | "video" | "reel";

export interface Comment {
  id: string;
  post_id: string | null;
  market_id: string | null;
  parent_id: string | null;
  author: UserLite;
  body: string;
  like_count: number;
  liked: boolean;
  reply_count: number;
  created_at: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

// @-mentions (spec §7d.2). Stored by user id (rename-safe). The wire format the
// client SENDS with a caption is just character offsets into the caption:
export interface MentionInput {
  user_id: string;
  start: number; // char offset of the "@" in the caption
  len: number; // length of the "@name" token
}

// …and what the API RETURNS additionally resolves each id to the CURRENT
// profile, so a rendered mention always shows the mentioned user's up-to-date
// username/avatar and links to them even after a rename.
export interface Mention extends MentionInput {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface Post {
  id: string;
  // Numeric onchain affiliate id registered for this post (0/null = none).
  // Orders placed from this post's market widget carry it (spec §4.2 fees).
  affiliate_id: number | null;
  author: UserLite;
  kind: PostKind;
  caption: string | null;
  // Resolved @-mentions in the caption (spec §7d.2), each a [start,len) slice.
  mentions: Mention[];
  media: MediaItem[];
  market: PostMarket | null;
  like_count: number;
  comment_count: number;
  liked: boolean;
  reactions: ReactionSummary[];
  top_comments: Comment[];
  created_at: string;
}

export interface Story {
  id: string;
  kind: MediaKind;
  url: string;
  hls_url: string | null;
  duration_ms: number | null;
  viewed: boolean;
  created_at: string;
  expires_at: string;
}

export interface StoryGroup {
  user: UserLite;
  stories: Story[];
  all_viewed: boolean;
}

// ------------------------------------------------------------------ messages

export interface MessageReaction {
  emoji: string;
  user_id: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender: UserLite;
  body: string | null;
  media: MediaItem | null;
  reply_to_id: string | null;
  reactions: MessageReaction[];
  created_at: string;
}

export interface Conversation {
  id: string;
  kind: "dm" | "group";
  members: UserLite[];
  recent_messages: Message[]; // inlined for instant open (spec §6.3)
  unread_count: number;
  last_read_at: string | null;
  updated_at: string;
}

// ------------------------------------------------------------- notifications

export type NotificationKind =
  | "market.matched"
  | "market.settled"
  | "order.filled"
  | "dm.message"
  | "post.liked"
  | "post.commented"
  | "post.mention"
  | "position.swing"
  | "following.large_entry"
  | "follow"
  | "follow.new"
  | "follow.request";

export interface Notification {
  id: string;
  kind: NotificationKind;
  payload: {
    actor?: UserLite;
    post_id?: string;
    market_id?: string;
    market_question?: string;
    conversation_id?: string;
    order_id?: string;
    text?: string;
    [k: string]: unknown;
  };
  read_at: string | null;
  created_at: string;
}

export interface FollowRequest {
  id: string;
  requester: UserLite;
  created_at: string;
}

// ----------------------------------------------------------------- developer

export type ApiKeyScope = "read" | "trade";

export interface ApiKey {
  id: string;
  name: string;
  scope: ApiKeyScope;
  prefix: string; // first characters of the secret, for identification
  created_at: string;
  last_used_at: string | null;
}

// Creation response additionally includes the FULL secret — shown exactly
// once in the UI and never retrievable again.
export interface ApiKeyCreated extends ApiKey {
  secret: string;
}

// -------------------------------------------------------------------- wallet

export interface Wallet {
  address: string;
  balance: string; // token units, decimal string
  decimals: number;
  symbol: string;
  order_nonce: number; // next EIP-712 order nonce for this maker
}

export interface WalletActivity {
  id: string;
  kind: "send" | "receive" | "escrow" | "redeem" | "fee" | "deposit" | "fill";
  amount: string; // token units, signed decimal string
  counterparty: string | null;
  description: string | null;
  tx_hash: string | null;
  created_at: string;
}

export interface OnrampSession {
  id: string;
  kind: "fiat" | "crypto";
  status: string;
  checkout_url: string | null; // fiat: provider-hosted checkout
  deposit_address: string | null; // crypto: cross-chain deposit address
  instructions: string | null;
}

// ----------------------------------------------------------------- envelopes
// The backend returns named-key envelopes, never bare arrays (spec §10.2),
// with next_cursor for paginated lists.

export interface Page<K extends string, T> {
  next_cursor: string | null;
}
export type PostsPage = { posts: Post[]; next_cursor: string | null };
export type CommentsPage = { comments: Comment[]; next_cursor: string | null };
export type MarketsPage = { markets: Market[]; next_cursor: string | null };
export type TradesPage = { trades: Trade[]; next_cursor: string | null };
export type MessagesPage = { messages: Message[]; next_cursor: string | null };
export type NotificationsPage = {
  notifications: Notification[];
  next_cursor: string | null;
};
export type ActivityPage = {
  activity: WalletActivity[];
  next_cursor: string | null;
};

// ------------------------------------------------------------------ WS types
// Frames are {type, channel, payload} (spec §6.4).

export type WsFrame =
  | { type: "message.new"; channel: string; payload: Message }
  | { type: "typing.start"; channel: string; payload: { user_id: string } }
  | { type: "typing.stop"; channel: string; payload: { user_id: string } }
  | { type: "read"; channel: string; payload: { user_id: string; at: string } }
  | { type: "book"; channel: string; payload: OrderBook }
  | {
      type: "trade";
      channel: string;
      payload: { price_cents: number; shares: number; side: Side };
    }
  | { type: "notification"; channel: string; payload: Notification }
  | { type: "order.update"; channel: string; payload: Order }
  | {
      type: "market.update";
      channel: string;
      payload: { market_id: string; status: MarketStatus; direction?: boolean | null };
    }
  | { type: string; channel: string; payload: any };
