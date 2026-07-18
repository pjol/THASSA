package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/pjol/THASSA/backend/internal/api"
	"github.com/pjol/THASSA/backend/internal/auth"
	"github.com/pjol/THASSA/backend/internal/bus"
	"github.com/pjol/THASSA/backend/internal/chain"
	"github.com/pjol/THASSA/backend/internal/config"
	"github.com/pjol/THASSA/backend/internal/db"
	"github.com/pjol/THASSA/backend/internal/llm"
	"github.com/pjol/THASSA/backend/internal/marketsvc"
	"github.com/pjol/THASSA/backend/internal/mcp"
	"github.com/pjol/THASSA/backend/internal/media"
	"github.com/pjol/THASSA/backend/internal/notify"
	"github.com/pjol/THASSA/backend/internal/onramp"
	"github.com/pjol/THASSA/backend/internal/push"
	"github.com/pjol/THASSA/backend/internal/sources"
	"github.com/pjol/THASSA/backend/internal/storage"
	"github.com/pjol/THASSA/backend/internal/store"
	"github.com/pjol/THASSA/backend/internal/ws"
)

func main() {
	cfg := config.Load()
	ctx, stopWorkers := context.WithCancel(context.Background())
	defer stopWorkers()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	// Realtime bus (spec §6.7): pg LISTEN/NOTIFY by default, redis pub/sub in
	// larger fleets. Events produced on any instance reach WS connections on
	// every instance via the bridge below.
	var eventBus bus.Bus
	switch cfg.BusDriver {
	case "redis":
		rb, err := bus.NewRedis(ctx, cfg.RedisURL)
		if err != nil {
			log.Fatalf("bus: redis: %v", err)
		}
		eventBus = rb
	case "pg":
		eventBus = bus.NewPG(pool)
	default:
		log.Fatalf("bus: unknown BUS_DRIVER %q (pg|redis)", cfg.BusDriver)
	}
	defer eventBus.Close()
	fanout := bus.NewFanout(eventBus)

	// Object storage: S3/MinIO in production, local filesystem in dev.
	var assets storage.Store
	var local *storage.LocalStore
	if cfg.InProduction {
		s3, err := storage.NewS3(ctx, cfg)
		if err != nil {
			log.Fatalf("storage: %v", err)
		}
		assets = s3
	} else {
		l, err := storage.NewLocal(cfg.LocalUploadDir, cfg.PublicAPIURL)
		if err != nil {
			log.Fatalf("local upload dir: %v", err)
		}
		assets = l
		local = l
	}

	dbStore := store.New(pool, assets)

	// Websocket hub + bus bridge.
	hub := ws.NewHub()
	if err := bus.Bridge(ctx, eventBus, hub); err != nil {
		log.Fatalf("bus subscribe: %v", err)
	}

	// Push leg (spec §7d.4): Expo delivery, best-effort and non-blocking. No
	// API key needed; shares the store for token lookup + pruning.
	pusher := push.New(dbStore)
	notifier := notify.New(dbStore, fanout, pusher)

	// Source registry + MCP server (used in-process by the generation agent
	// and remotely by oracle nodes with MCP_NODE_TOKEN).
	registry := sources.Default()
	mcpToken := cfg.MCPNodeToken
	if mcpToken == "" {
		mcpToken = uuid.NewString() // in-process only; remote access disabled
		log.Printf("mcp: MCP_NODE_TOKEN not set — remote node access disabled")
	}
	mcpServer := mcp.NewServer(dbStore, registry, mcpToken)
	mcpClient := mcp.NewInProcessClient(mcpServer, mcpToken)

	llmClient := llm.New(cfg.OpenAIAPIKey, cfg.LLMModel)
	marketSvc := marketsvc.New(dbStore, llmClient, mcpClient, registry)

	// Chain services (relayer, indexer, settlement) — enabled when the
	// contracts + relayer key are configured.
	var chainClient *chain.Client
	var gate *chain.Gate
	if cfg.ChainEnabled() {
		c, err := chain.Dial(ctx, cfg)
		if err != nil {
			log.Fatalf("chain: %v", err)
		}
		chainClient = c
		gate = chain.NewGate(c.Markets, c.Token, c.Hub, c.Relayer, cfg.ChainID, cfg.MaxOrderCost)

		relayer := chain.NewRelayer(dbStore, c, gate, fanout, cfg.RelayerBatchMS, cfg.RelayerBatchMax)
		go relayer.Run(ctx)

		indexer := chain.NewIndexer(dbStore, c, fanout, notifier)
		go indexer.Run(ctx)

		settler := chain.NewSettlementRunner(dbStore, c, gate, fanout)
		go settler.Run(ctx)

		log.Printf("chain services enabled (markets=%s relayer=%s)", c.Markets, c.Relayer)
	} else {
		log.Printf("chain services disabled (set PAYMENT_TOKEN_ADDRESS, MARKETS_CONTRACT_ADDRESS, RELAYER_PRIVATE_KEY)")
	}

	// ffmpeg media pipeline (HLS transcodes + image variants).
	media.NewProcessor(dbStore, assets).Run(ctx, 2)

	onrampSvc := onramp.New(dbStore, cfg)

	// Privy token verification. With PRIVY_VERIFICATION_KEY set, tokens are
	// verified fully locally (pinned key, no callout); otherwise the verifier
	// falls back to the auth.privy.io JWKS.
	verifier, err := auth.NewPrivyVerifier(cfg.PrivyAppID, cfg.PrivyVerificationKey)
	if err != nil {
		log.Fatalf("privy verifier: %s", err)
	}
	if cfg.PrivyVerificationKey != "" {
		log.Printf("privy auth: local verification with pinned key")
	} else {
		log.Printf("privy auth: no PRIVY_VERIFICATION_KEY set — falling back to JWKS callout (pin the key for production)")
	}

	// Privy server API client (spec §7c.1): resolves a user's verified email by
	// DID when PRIVY_APP_SECRET is set, enabling verified admin-email matching
	// in production. Inert (email from token claim only) when unset.
	privyAPI := auth.NewPrivyAPI(cfg.PrivyAppID, cfg.PrivyAppSecret)
	if privyAPI.Enabled() {
		log.Printf("privy api: enabled (verified email resolution by DID)")
	}

	srv := api.New(api.Deps{
		Cfg:      cfg,
		Pool:     pool,
		Verifier: verifier,
		PrivyAPI: privyAPI,
		DB:       dbStore,
		Assets:   assets,
		Hub:      hub,
		Fanout:   fanout,
		Push:     pusher,
		Chain:    chainClient,
		Gate:     gate,
		Markets:  marketSvc,
		Registry: registry,
		MCP:      mcpServer,
		Onramp:   onrampSvc,
		Local:    local,
	})

	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on :%s (env=%s region=%s bus=%s)", cfg.Port, cfg.Env, cfg.Region, cfg.BusDriver)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	stopWorkers() // releases advisory-lock leadership + worker loops
	log.Println("shutdown complete")
}
