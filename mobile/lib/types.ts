// Shared DTOs for the Thassa backend (spec §6.2/§6.3) and the one-word state
// vocabulary (spec §5) as string-literal unions, used verbatim in all UIs.

export type MarketState = "PENDING" | "OPEN" | "MATCHED" | "SETTLING" | "SETTLED" | "VOID";
export type OrderState = "SIGNING" | "QUEUED" | "RESTING" | "PARTIAL" | "FILLED" | "CANCELED";
export type Side = "yes" | "no";

export const MARKET_STATES: MarketState[] = ["PENDING", "OPEN", "MATCHED", "SETTLING", "SETTLED", "VOID"];
export const ORDER_STATES: OrderState[] = ["SIGNING", "QUEUED", "RESTING", "PARTIAL", "FILLED", "CANCELED"];

// Creator-side microcopy (spec §5, verbatim).
export const CREATOR_MICROCOPY: Partial<Record<MarketState, string>> = {
  OPEN: "You're committed. Waiting for someone to take your bet.",
  MATCHED: "Your bet was taken.",
};

// Cursor pagination envelope. The backend returns pluralized named keys with
// next_cursor (ASSEMBLY convention, e.g. {"posts": [...], "next_cursor": c});
// tolerate {items}/{nextCursor} shapes too so both clients stay compatible.
export interface Paged<T> {
  items?: T[];
  next_cursor?: string | null;
  nextCursor?: string | null;
  [key: string]: unknown;
}
export function pageItems<T>(p: Paged<T> | null | undefined): T[] {
  if (!p) return [];
  if (Array.isArray(p.items)) return p.items;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}
export function nextCursorOf<T>(p: Paged<T>): string | null {
  return p.next_cursor ?? p.nextCursor ?? null;
}

export type TradesVisibility = "public" | "private";

// Warp (admin impersonation) context returned by GET /v1/me while warped
// (spec §7c.2): the object itself is the EFFECTIVE (target) user, plus this.
export interface WarpInfo {
  active: boolean;
  admin_email: string;
  viewing: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

export interface Me {
  id: string;
  privy_did?: string;
  wallet_address: string | null;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  links: string[] | null;
  is_private: boolean;
  trades_visibility: TradesVisibility;
  // Per-category notification toggles (missing key = enabled). Categories:
  // likes, comments, mentions, follows, messages, markets, trading.
  notification_prefs?: Record<string, boolean>;
  // Trade API route 2: the user let the platform sign API orders through
  // their delegated wallet, so plain API keys can trade.
  server_signing_enabled?: boolean;
  onboarded?: boolean;
  // True for the REAL user when their verified email is an admin (spec §7c.1).
  is_admin?: boolean;
  // Present only while warped; see WarpInfo.
  warp?: WarpInfo | null;
}

// A user row from the admin search (spec §7c.2 GET /v1/admin/users).
export interface AdminUser {
  id: string;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
}

// A lightweight user row (mention autocomplete GET /v1/users/search, follower /
// following lists). The backend returns {id, username, display_name, avatar_url}.
export interface UserBrief {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

// A resolved @-mention on a post/comment (spec §7d.2). Stored by user id; the
// backend echoes the CURRENT username/profile per id so renames propagate.
// start/len are character offsets of the `@name` token into the caption text.
export interface Mention {
  user_id: string;
  start: number;
  len: number;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface UserProfile {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  links: string[] | null;
  is_private: boolean;
  trades_visibility?: TradesVisibility;
  post_count: number;
  follower_count: number;
  following_count: number;
  // Relationship from the viewer's perspective.
  is_following?: boolean;
  follow_requested?: boolean;
  follows_you?: boolean;
  is_me?: boolean;
  // Whether the viewer may see this account's content (public or accepted follower).
  can_view?: boolean;
  // Whether the viewer may see this account's trades tab / position badges.
  can_view_trades?: boolean;
}

export type MediaKind = "image" | "video";
// A single downscaled image rendition (backend multi-quality variants). Images
// carry one per size; video always ships an empty `variants` array.
export interface MediaVariant {
  width: number;
  height: number;
  url: string;
  format: string;
}
export interface Media {
  id: string;
  kind: MediaKind;
  url: string;
  hls_url?: string | null;
  // Downscaled image renditions; pick with lib/media.bestImageUrl. Optional /
  // possibly empty for older media and video.
  variants?: MediaVariant[] | null;
  // Still image for a video (poster / placeholder).
  poster_url?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  status?: "uploading" | "processing" | "ready" | "failed";
}

export type PostKind = "photo" | "video" | "reel";
export interface Post {
  id: string;
  // Numeric onchain affiliate id, alongside the uuid (orders send both).
  affiliate_id?: number | null;
  author: UserProfile;
  kind: PostKind;
  caption: string | null;
  // Resolved @-mentions in the caption (spec §7d.2), current-username per id.
  mentions?: Mention[];
  media: Media[];
  market: Market | null;
  // The poster's position in the attached market, if visible (spec §7:
  // omitted server-side when the author's trades are private).
  author_position?: Position | null;
  author_pnl?: number | null; // settled PnL in dollars for the badge
  like_count: number;
  comment_count: number;
  liked_by_me: boolean;
  reactions?: Record<string, number>;
  my_reaction?: string | null;
  top_comments?: Comment[];
  created_at: string;
}

export interface Story {
  id: string;
  author: UserProfile;
  media: Media;
  created_at: string;
  expires_at: string;
  viewed: boolean;
}
export interface StoryGroup {
  user: UserProfile;
  stories: Story[];
  all_viewed: boolean;
}

export interface Comment {
  id: string;
  post_id?: string | null;
  market_id?: string | null;
  author: UserProfile;
  parent_id: string | null;
  body: string;
  // Resolved @-mentions in the comment body (spec §7d.2), same shape as posts.
  mentions?: Mention[];
  like_count: number;
  liked_by_me: boolean;
  reactions?: Record<string, number>;
  replies?: Comment[];
  reply_count?: number;
  created_at: string;
}

// Structured settlement query (spec §6.5b): every market resolves through a
// named rule + explicit sources, surfaced verbatim in the UI for transparency.
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
  id: string;
  chain_market_id: number;
  creator: UserProfile;
  // Terse display title (e.g. "Lakers to win Friday"); question is the full
  // resolution-grade phrasing shown when a card is expanded.
  title?: string;
  question: string;
  settlement_query: string;
  // Structured resolution details (spec §6.5b), as FLAT fields — this is what
  // the backend actually sends (category/rule/sources denormalized at market
  // creation). The legacy settlement_query string remains the onchain-stored
  // instruction.
  category?: string | null;
  rule?: SettlementRule | "" | null;
  sources?: SettlementSource[];
  // Optional pre-assembled shape (older payloads); prefer the flat fields.
  settlement?: Settlement | null;
  status: MarketState;
  direction: boolean | null; // SETTLED: true = YES
  yes_price_cents: number | null; // best ask for YES (cents)
  no_price_cents: number | null;
  volume: number; // dollars
  // Expiration: unsettled markets auto-resolve 50/50 at expires_at;
  // resolved_fifty marks that outcome (SETTLED, no winning direction).
  expires_at?: string | null;
  resolved_fifty?: boolean;
  created_at: string;
  post_count?: number;
  comment_count?: number;
  my_position?: Position | null;
}

export interface BookLevel {
  price_cents: number;
  shares: number;
}
export interface OrderBookSummary {
  market_id: string;
  yes: BookLevel[]; // resting YES buys, best (highest) first
  no: BookLevel[]; // resting NO buys, best (highest) first
  last_trade_price_cents?: number | null;
}

export interface Order {
  id: string;
  market_id: string;
  market?: Market;
  user_id: string;
  side: Side;
  price_cents: number;
  shares: number;
  filled_shares: number;
  status: OrderState;
  affiliate_post_id?: string | null;
  created_at: string;
}

export interface Position {
  market_id: string;
  market?: Market;
  side: Side;
  shares: number;
  avg_price_cents: number;
  realized_pnl: number; // dollars
  unrealized_pnl?: number | null;
}

// A fill from the user's trade history (spec §7 Trades tab).
export interface Trade {
  id: string;
  market_id: string;
  market_question: string;
  market_status: MarketState;
  market_direction?: boolean | null;
  side: Side;
  price_cents: number;
  shares: number;
  fee: number; // dollars
  pnl?: number | null; // dollars, present when settled
  created_at: string;
}

export interface MarketCandidate {
  title: string;
  question: string;
  settlementQuery?: string;
  settlement_query?: string;
  suggestedCloseNote?: string;
  suggested_close_note?: string;
  // Structured resolution preview (spec §6.5b), when the generator supplies it,
  // so a poster can review exactly how a not-yet-created market would settle.
  category?: string | null;
  rule?: SettlementRule;
  sources?: SettlementSource[];
  // When the generator maps a candidate onto an existing market.
  existing_market?: Market | null;
}
export function candidateSettlementQuery(c: MarketCandidate): string {
  return c.settlement_query ?? c.settlementQuery ?? "";
}

// Conversation members carry read state (last_read_at) — read receipts derive
// from it rather than per-message flags.
export type ConversationMember = UserProfile & { last_read_at?: string | null };

export interface Conversation {
  id: string;
  kind: "dm" | "group";
  members: ConversationMember[];
  recent_messages: Message[];
  unread_count: number;
  updated_at: string;
}

// Compact preview of a post shared into a DM (message.shared_post).
export interface SharedPost {
  id: string;
  author: UserBrief;
  caption: string | null;
  thumb_url: string | null;
  market_title?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender: UserProfile;
  body: string | null;
  media?: Media | null;
  reply_to_id?: string | null;
  // A post shared into the thread; shared_post is nil if the post was deleted.
  post_id?: string | null;
  shared_post?: SharedPost | null;
  reactions?: Record<string, number>;
  my_reaction?: string | null;
  created_at: string;
  read_by?: string[]; // user ids that have read up to here
  // Client-side optimistic flag.
  pending?: boolean;
}

export type NotificationKind =
  | "market.matched"
  | "order.filled"
  | "dm.message"
  | "post.liked"
  | "post.commented"
  // Social-graph kinds (spec §7d.4).
  | "post.mention" // tagged in a post/comment
  | "follow.new" // new follower
  | "follow"
  | "follow.request"
  | "follow.accepted"
  | "position.swing" // own held position swung >50%
  | "following.large_entry" // a followed user placed a large entry
  | string;

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  payload: {
    title?: string;
    body?: string;
    user?: UserProfile;
    post_id?: string;
    market_id?: string;
    conversation_id?: string;
    order_id?: string;
    follow_request_id?: string;
    [k: string]: unknown;
  };
  read_at: string | null;
  created_at: string;
}

export interface FollowRequest {
  id: string;
  user: UserProfile;
  created_at: string;
}

export interface WalletInfo {
  address: string;
  balance: number; // dollars
  token_symbol: string;
  token_address: string;
  token_decimals: number;
  token_name?: string;
  token_version?: string;
  // Next EIP-712 maker nonce — fetched fresh before signing every order.
  order_nonce: number;
}

export interface WalletActivityItem {
  id: string;
  kind: "send" | "receive" | "order" | "redeem" | "fee" | "deposit" | string;
  amount: number; // dollars, signed
  counterparty?: string | null;
  description?: string | null;
  tx_hash?: string | null;
  created_at: string;
}

export interface OnrampSession {
  id: string;
  kind: "fiat" | "crypto";
  status: string;
  // fiat: provider-hosted checkout URL.
  checkout_url?: string | null;
  // crypto: cross-chain deposit instructions.
  deposit_address?: string | null;
  deposit_chain?: string | null;
  deposit_note?: string | null;
}
