package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/bus"
	"github.com/pjol/THASSA/backend/internal/chain"
	"github.com/pjol/THASSA/backend/internal/config"
	"github.com/pjol/THASSA/backend/internal/marketsvc"
	"github.com/pjol/THASSA/backend/internal/mcp"
	"github.com/pjol/THASSA/backend/internal/onramp"
	"github.com/pjol/THASSA/backend/internal/respond"
	"github.com/pjol/THASSA/backend/internal/sources"
	"github.com/pjol/THASSA/backend/internal/storage"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/ws"
)

// Server wires the router to its dependencies. The API tier is fully
// stateless (spec §6.7): all cross-request state lives in Postgres/S3/bus.
type Server struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	verifier auth.Verifier
	db       *store.Store    // query/repository layer
	assets   storage.Store   // S3 (prod) or local-dir (dev) object storage
	hub      *ws.Hub         // this instance's websocket connections
	fanout   *bus.Fanout     // cross-instance realtime fanout
	chain    *chain.Client   // RPC reads (balance, nonces); nil when disabled
	gate     *chain.Gate     // relayer gas-sponsorship gate (validation here too)
	markets  *marketsvc.Service
	registry *sources.Registry
	mcp      *mcp.Server
	onramp   *onramp.Service
	local    *storage.LocalStore // non-nil in dev for PUT /v1/uploads/local

	// Per-instance protective limiters for the developer API (§6.9);
	// correctness-relevant limits (order rates) live in the database.
	ipLimiter  *rateLimiter
	keyLimiter *rateLimiter
}

// Deps carries the constructor dependencies.
type Deps struct {
	Cfg      *config.Config
	Pool     *pgxpool.Pool
	Verifier auth.Verifier
	DB       *store.Store
	Assets   storage.Store
	Hub      *ws.Hub
	Fanout   *bus.Fanout
	Chain    *chain.Client
	Gate     *chain.Gate
	Markets  *marketsvc.Service
	Registry *sources.Registry
	MCP      *mcp.Server
	Onramp   *onramp.Service
	Local    *storage.LocalStore
}

// New constructs a Server.
func New(d Deps) *Server {
	s := &Server{
		cfg:      d.Cfg,
		pool:     d.Pool,
		verifier: d.Verifier,
		db:       d.DB,
		assets:   d.Assets,
		hub:      d.Hub,
		fanout:   d.Fanout,
		chain:    d.Chain,
		gate:     d.Gate,
		markets:  d.Markets,
		registry: d.Registry,
		mcp:      d.MCP,
		onramp:   d.Onramp,
		local:    d.Local,

		ipLimiter:  newRateLimiter(120, time.Minute), // public market data per IP
		keyLimiter: newRateLimiter(300, time.Minute), // keyed requests per key
	}
	// WS per-channel authorization (§8.1: re-checked server-side with the
	// connection's authenticated user).
	s.hub.CanJoin = s.canJoinChannel
	return s
}

// Router builds the HTTP handler.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   s.cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "Idempotency-Key"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health reports the serving region (spec §6.7).
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		respond.JSON(w, http.StatusOK, map[string]any{"status": "ok", "region": s.cfg.Region})
	})

	// Public source registry (spec §6.5b).
	r.Get("/v1/sources", s.handleListSources)

	// Stripe webhooks: signature-verified, no user auth, raw body.
	r.Post("/v1/webhooks/stripe", s.handleStripeWebhook)

	// MCP endpoint for remote oracle nodes (bearer MCP_NODE_TOKEN inside the
	// handler) and the in-process generation agent.
	r.Handle("/v1/mcp", s.mcp)

	// Dev-only local file storage (IN_PRODUCTION=false): unauthenticated PUT
	// to an unguessable key + static serving, mirroring an S3 presigned-PUT +
	// public URL.
	if !s.cfg.InProduction && s.local != nil {
		r.Put("/v1/uploads/local/*", s.handleLocalUpload)
		r.Handle("/uploads/*", http.StripPrefix("/uploads/",
			http.FileServer(http.Dir(s.local.Dir()))))
	}

	// Authenticated API.
	r.Group(func(r chi.Router) {
		r.Use(s.privyAuth)        // verify the Privy access token (ES256/JWKS)
		r.Use(s.resolveIdentity)  // lazily provision the users row, attach Identity
		r.Use(s.idempotency)      // Idempotency-Key replay/conflict handling (§6.7)

		// Self / settings / follow requests.
		r.Get("/v1/me", s.handleGetMe)
		r.Patch("/v1/me", s.handleUpdateMe)
		r.Patch("/v1/me/settings", s.handleUpdateSettings)
		r.Post("/v1/me/avatar", s.handleSetAvatar)
		r.Get("/v1/me/badges", s.handleBadges)
		r.Get("/v1/me/follow-requests", s.handleListFollowRequests)
		r.Post("/v1/follow-requests/{id}/approve", s.handleApproveFollowRequest)
		r.Post("/v1/follow-requests/{id}/deny", s.handleDenyFollowRequest)
		r.Post("/v1/me/push-token", s.handleRegisterPushToken)
		r.Delete("/v1/me/push-token", s.handleRemovePushToken)

		// Users & follows.
		r.Get("/v1/users/{username}", s.handleGetUser)
		r.Get("/v1/users/{username}/posts", s.handleUserPosts)
		r.Get("/v1/users/{username}/trades", s.handleUserTrades)
		r.Get("/v1/users/{username}/followers", s.handleFollowers)
		r.Get("/v1/users/{username}/following", s.handleFollowing)
		r.Post("/v1/users/{id}/follow", s.handleFollow)
		r.Delete("/v1/users/{id}/follow", s.handleUnfollow)

		// Media.
		r.Post("/v1/media", s.handleCreateMedia)
		r.Post("/v1/media/{id}/complete", s.handleCompleteMedia)
		r.Get("/v1/media/{id}", s.handleGetMedia)

		// Posts & feed.
		r.Post("/v1/posts", s.handleCreatePost)
		r.Get("/v1/feed", s.handleFeed)
		r.Get("/v1/posts/{id}", s.handleGetPost)
		r.Delete("/v1/posts/{id}", s.handleDeletePost)
		r.Get("/v1/posts/{id}/comments", s.handlePostComments)
		r.Post("/v1/posts/{id}/comments", s.handleCreatePostComment)
		r.Delete("/v1/comments/{id}", s.handleDeleteComment)

		// Likes & reactions (subject_type + subject_id).
		r.Put("/v1/likes", s.handleLike)
		r.Delete("/v1/likes", s.handleUnlike)
		r.Put("/v1/reactions", s.handleReact)
		r.Delete("/v1/reactions", s.handleUnreact)

		// Stories.
		r.Post("/v1/stories", s.handleCreateStory)
		r.Get("/v1/stories", s.handleListStories)
		r.Post("/v1/stories/{id}/view", s.handleViewStory)

		// Reels & explore.
		r.Get("/v1/reels", s.handleReels)
		r.Get("/v1/explore/posts", s.handleExplorePosts)
		r.Get("/v1/explore/markets", s.handleExploreMarkets)

		// DMs.
		r.Get("/v1/conversations", s.handleListConversations)
		r.Post("/v1/conversations", s.handleCreateConversation)
		r.Get("/v1/conversations/{id}/messages", s.handleListMessages)
		r.Post("/v1/conversations/{id}/messages", s.handleSendMessage)
		r.Post("/v1/conversations/{id}/read", s.handleMarkConversationRead)

		// Markets.
		r.Get("/v1/markets/search", s.handleSearchMarkets)
		r.Post("/v1/markets/generate", s.handleGenerateMarkets)
		r.Post("/v1/markets", s.handleCreateMarket)
		r.Get("/v1/markets/{id}", s.handleGetMarket)
		r.Get("/v1/markets/{id}/book", s.handleMarketBook)
		r.Get("/v1/markets/{id}/posts", s.handleMarketPosts)
		r.Get("/v1/markets/{id}/comments", s.handleMarketComments)
		r.Post("/v1/markets/{id}/comments", s.handleCreateMarketComment)
		r.Post("/v1/markets/{id}/settle", s.handleSettleMarket)
		r.Post("/v1/markets/{id}/redeem", s.handleRedeemMarket)

		// Orders & positions.
		r.Post("/v1/orders", s.handleCreateOrder)
		r.Delete("/v1/orders/{id}", s.handleCancelOrder)
		r.Get("/v1/orders", s.handleListOrders)
		r.Get("/v1/positions", s.handleListPositions)

		// Wallet & onramp.
		r.Get("/v1/wallet", s.handleGetWallet)
		r.Post("/v1/wallet/send", s.handleWalletSend)
		r.Get("/v1/wallet/activity", s.handleWalletActivity)
		r.Post("/v1/onramp/sessions", s.handleCreateOnrampSession)

		// Notifications.
		r.Get("/v1/notifications", s.handleListNotifications)
		r.Post("/v1/notifications/read", s.handleMarkNotificationsRead)

		// Developer API key management (spec §6.9).
		r.Post("/v1/developer/keys", s.handleCreateAPIKey)
		r.Get("/v1/developer/keys", s.handleListAPIKeys)
		r.Delete("/v1/developer/keys/{id}", s.handleRevokeAPIKey)

		// Realtime socket (Privy bearer/?token=, or an API key via
		// X-Thassa-Key/?key= for book:{marketId} subscriptions).
		r.Get("/v1/ws", s.handleWS)
	})

	// Public developer trade API (spec §6.9): Kalshi-style, same envelopes.
	r.Route("/trade-api/v1", func(r chi.Router) {
		// Market data: no auth, IP rate-limited.
		r.Group(func(r chi.Router) {
			r.Use(s.ipRateLimit)
			r.Get("/markets", s.handleTradeMarkets)
			r.Get("/markets/{id}", s.handleTradeMarket)
			r.Get("/markets/{id}/book", s.handleMarketBook)
			r.Get("/markets/{id}/trades", s.handleTradeMarketTrades)
			r.Get("/markets/{id}/sources", s.handleTradeMarketSources)
		})
		// Read scope: account data.
		r.Group(func(r chi.Router) {
			r.Use(s.apiKeyAuth("read"))
			r.Get("/orders", s.handleListOrders)
			r.Get("/positions", s.handleListPositions)
			r.Get("/fills", s.handleTradeFills)
			r.Get("/balance", s.handleGetWallet)
		})
		// Trade scope: mutations — same non-custodial payloads, same relayer
		// gate, same idempotency semantics as /v1.
		r.Group(func(r chi.Router) {
			r.Use(s.apiKeyAuth("trade"))
			r.Use(s.idempotency)
			r.Post("/orders", s.handleCreateOrder)
			r.Delete("/orders/{id}", s.handleCancelOrder)
		})
	})

	return r
}
