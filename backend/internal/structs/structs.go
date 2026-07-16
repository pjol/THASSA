// Package structs holds the JSON shapes shared between the store layer and
// the HTTP handlers (snake_case tags, pointer optionals).
package structs

import (
	"math/big"
	"time"

	"github.com/google/uuid"
)

// AffiliateIDFor derives the onchain uint256 affiliatePostId from a post uuid
// (the uuid's 16 bytes interpreted as a big-endian integer).
func AffiliateIDFor(postID uuid.UUID) string {
	return new(big.Int).SetBytes(postID[:]).String()
}

// UserBrief is the compact author/member shape embedded in feed items.
type UserBrief struct {
	ID          uuid.UUID `json:"id"`
	Username    *string   `json:"username"`
	DisplayName *string   `json:"display_name"`
	AvatarURL   *string   `json:"avatar_url"`
}

// Profile is the full user page shape.
type Profile struct {
	UserBrief
	Bio              *string   `json:"bio"`
	Links            []Link    `json:"links"`
	WalletAddress    *string   `json:"wallet_address"`
	IsPrivate        bool      `json:"is_private"`
	TradesVisibility string    `json:"trades_visibility"`
	FollowerCount    int       `json:"follower_count"`
	FollowingCount   int       `json:"following_count"`
	PostCount        int       `json:"post_count"`
	// FollowStatus is the caller's relationship: "", "pending", or "accepted".
	FollowStatus string    `json:"follow_status"`
	IsMe         bool      `json:"is_me"`
	CreatedAt    time.Time `json:"created_at"`
}

// Link is a profile link entry.
type Link struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// Media is an uploaded photo/video attached to a post (or standalone while
// uploading/processing).
type Media struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"` // image | video
	URL        string    `json:"url"`
	VariantURL *string   `json:"variant_url,omitempty"` // feed-size image
	HLSURL     *string   `json:"hls_url,omitempty"`     // hls/{id}/master.m3u8
	Width      *int      `json:"width"`
	Height     *int      `json:"height"`
	DurationMS *int      `json:"duration_ms"`
	Status     string    `json:"status"` // uploading | processing | ready | failed
	Position   int       `json:"position"`
}

// MarketSummary is the market card attached to posts and list rows.
type MarketSummary struct {
	ID            uuid.UUID `json:"id"`
	ChainMarketID *int64    `json:"chain_market_id"`
	Title         string    `json:"title"`
	Question      string    `json:"question"`
	Status        string    `json:"status"` // PENDING OPEN MATCHED SETTLING SETTLED VOID
	Direction     *bool     `json:"direction"`
	YesPriceCents *int      `json:"yes_price_cents"`
	NoPriceCents  *int      `json:"no_price_cents"`
	Volume        int64     `json:"volume"`
	CreatedAt     time.Time `json:"created_at"`
}

// SourceRef is one disclosed resolution source (spec §6.5b).
type SourceRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// Market is the detail shape (settlement query is always public and always
// discloses its parsed resolution sources + rule).
type Market struct {
	MarketSummary
	SettlementQuery   string      `json:"settlement_query"`
	Category          string      `json:"category"`
	Rule              string      `json:"rule"` // single | majority
	Sources           []SourceRef `json:"sources"`
	Creator           UserBrief `json:"creator"`
	CreatorFeeAccrued int64     `json:"creator_fee_accrued"`
	CommentCount      int       `json:"comment_count"`
	LikeCount         int       `json:"like_count"`
	LikedByMe         bool      `json:"liked_by_me"`
	MyPosition        *Position `json:"my_position,omitempty"`
}

// PositionBadge is the compact holder position shown on post cards.
type PositionBadge struct {
	Side          string  `json:"side"` // yes | no
	Shares        int64   `json:"shares"`
	AvgPriceCents float64 `json:"avg_price_cents"`
	RealizedPnl   *int64  `json:"realized_pnl,omitempty"` // set when SETTLED
}

// Post is the feed/detail post card.
type Post struct {
	ID      uuid.UUID `json:"id"`
	Author  UserBrief `json:"author"`
	Caption *string   `json:"caption"`
	Kind    string    `json:"kind"` // photo | video | reel
	Media   []Media   `json:"media"`
	// AffiliateID is the onchain uint256 affiliatePostId (= uint256 of the
	// post uuid bytes), decimal-encoded (uint256 exceeds JSON number range).
	AffiliateID string `json:"affiliate_id"`
	LikeCount    int            `json:"like_count"`
	CommentCount int            `json:"comment_count"`
	LikedByMe    bool           `json:"liked_by_me"`
	Market       *MarketSummary `json:"market,omitempty"`
	// AuthorPosition/AuthorPnl follow the trades-visibility rule: shown only
	// to the author or when the author's trades are public.
	AuthorPosition *PositionBadge `json:"author_position,omitempty"`
	AuthorPnl      *int64         `json:"author_pnl,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
}

// Story is a 24h ephemeral media item.
type Story struct {
	ID         uuid.UUID `json:"id"`
	Author     UserBrief `json:"author"`
	Kind       string    `json:"kind"`
	URL        string    `json:"url"`
	HLSURL     *string   `json:"hls_url,omitempty"`
	ViewCount  int       `json:"view_count"`
	ViewedByMe bool      `json:"viewed_by_me"`
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// Comment attaches to a post OR a market; replies via parent_id.
type Comment struct {
	ID        uuid.UUID  `json:"id"`
	PostID    *uuid.UUID `json:"post_id"`
	MarketID  *uuid.UUID `json:"market_id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	Author    UserBrief  `json:"author"`
	Body      string     `json:"body"`
	LikeCount int        `json:"like_count"`
	LikedByMe bool       `json:"liked_by_me"`
	CreatedAt time.Time  `json:"created_at"`
}

// Message is a DM message (text and/or one media attachment).
type Message struct {
	ID             uuid.UUID  `json:"id"`
	ConversationID uuid.UUID  `json:"conversation_id"`
	Sender         UserBrief  `json:"sender"`
	Body           *string    `json:"body"`
	MediaKind      *string    `json:"media_kind"`
	MediaURL       *string    `json:"media_url"`
	HLSURL         *string    `json:"hls_url,omitempty"`
	ReplyToID      *uuid.UUID `json:"reply_to_id"`
	Reactions      map[string]int `json:"reactions"`
	CreatedAt      time.Time  `json:"created_at"`
}

// ConversationMember is a thread member with their read state (drives
// read receipts in both frontends).
type ConversationMember struct {
	UserBrief
	LastReadAt *time.Time `json:"last_read_at"`
}

// Conversation is a DM/group thread; list responses inline the most recent
// messages of the top conversations so the client can pre-fetch threads.
type Conversation struct {
	ID             uuid.UUID            `json:"id"`
	Kind           string               `json:"kind"` // dm | group
	Members        []ConversationMember `json:"members"`
	LastMessage    *Message             `json:"last_message"`
	Unread         int                  `json:"unread"`
	RecentMessages []Message            `json:"recent_messages,omitempty"`
	CreatedAt      time.Time            `json:"created_at"`
}

// Order uses the one-word state vocabulary verbatim.
type Order struct {
	ID           uuid.UUID  `json:"id"`
	MarketID     uuid.UUID  `json:"market_id"`
	Side         string     `json:"side"` // yes | no
	PriceCents   int        `json:"price_cents"`
	Shares       int64      `json:"shares"`
	FilledShares int64      `json:"filled_shares"`
	Status       string     `json:"status"` // SIGNING QUEUED RESTING PARTIAL FILLED CANCELED
	ChainOrderID *int64     `json:"chain_order_id"`
	MaxCost      int64      `json:"max_cost"`
	CreatedAt    time.Time  `json:"created_at"`
	Market       *MarketSummary `json:"market,omitempty"`
}

// Position is a holder's per-market/side position (indexer-maintained).
type Position struct {
	MarketID      uuid.UUID      `json:"market_id"`
	Side          string         `json:"side"`
	Shares        int64          `json:"shares"`
	AvgPriceCents float64        `json:"avg_price_cents"`
	RealizedPnl   int64          `json:"realized_pnl"`
	Market        *MarketSummary `json:"market,omitempty"`
}

// Trade is a user-facing fill row for GET /v1/users/{username}/trades.
type Trade struct {
	MarketID    uuid.UUID `json:"market_id"`
	Question    string    `json:"question"`
	Status      string    `json:"status"`
	Direction   *bool     `json:"direction"`
	Side        string    `json:"side"`
	Taker       bool      `json:"taker"`
	PriceCents  int       `json:"price_cents"`
	Shares      int64     `json:"shares"`
	Fee         int64     `json:"fee"`
	RealizedPnl *int64    `json:"realized_pnl,omitempty"` // settled markets only
	CreatedAt   time.Time `json:"created_at"`
}

// BookLevel is one aggregated price level of the order book.
type BookLevel struct {
	PriceCents int   `json:"price_cents"`
	Shares     int64 `json:"shares"`
}

// Book is the order-book snapshot for a market.
type Book struct {
	MarketID uuid.UUID   `json:"market_id"`
	Yes      []BookLevel `json:"yes"`
	No       []BookLevel `json:"no"`
	Trades   []BookTrade `json:"trades"`
}

// BookTrade is a recent match shown under the book.
type BookTrade struct {
	PriceCents int       `json:"price_cents"`
	Shares     int64     `json:"shares"`
	CreatedAt  time.Time `json:"created_at"`
}

// Notification is an in-app notification row.
type Notification struct {
	ID        uuid.UUID      `json:"id"`
	Kind      string         `json:"kind"`
	Payload   map[string]any `json:"payload"`
	ReadAt    *time.Time     `json:"read_at"`
	CreatedAt time.Time      `json:"created_at"`
}

// FollowRequest is a pending follow of a private account.
type FollowRequest struct {
	ID        uuid.UUID `json:"id"`
	Follower  UserBrief `json:"follower"`
	CreatedAt time.Time `json:"created_at"`
}

// TransferActivity is a wallet activity row from indexed transfers.
type TransferActivity struct {
	TxHash      string    `json:"tx_hash"`
	From        string    `json:"from"`
	To          string    `json:"to"`
	Amount      int64     `json:"amount"`
	Direction   string    `json:"direction"` // in | out
	BlockNumber int64     `json:"block_number"`
	CreatedAt   time.Time `json:"created_at"`
}

// MarketCandidate is one LLM-generated market draft. SettlementQuery is the
// structured JSON string (§6.5b) that will be stored onchain; category, rule
// and sources are its parsed disclosure for the picker UI.
type MarketCandidate struct {
	Title              string      `json:"title"`
	Question           string      `json:"question"`
	SettlementQuery    string      `json:"settlement_query"`
	Category           string      `json:"category"`
	Rule               string      `json:"rule"`
	Sources            []SourceRef `json:"sources"`
	SuggestedCloseNote string      `json:"suggested_close_note,omitempty"`
	// ExistingMarketID is set when the candidate duplicated an existing
	// market's settlement outcome and was mapped to it instead.
	ExistingMarketID *uuid.UUID `json:"existing_market_id,omitempty"`
}
