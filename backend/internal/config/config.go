package config

import (
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config holds all runtime configuration, loaded from environment.
type Config struct {
	Port        string
	Env         string
	Region      string // surfaced in /health (spec §6.7)
	CORSOrigins []string
	// PublicAPIURL is this instance's externally-reachable base URL (used for
	// dev local-upload URLs and webhook return links).
	PublicAPIURL string
	PublicWebURL string

	DatabaseURL string

	// Realtime bus (spec §6.7): pg = Postgres LISTEN/NOTIFY, redis = go-redis.
	BusDriver string
	RedisURL  string

	// Privy auth (Signet later — the verifier is pluggable behind auth.Verifier).
	PrivyAppID string
	// PrivyVerificationKey is the app's ES256 public verification key (PEM,
	// from the Privy dashboard). Set ⇒ tokens verify fully locally with no
	// network callout; unset ⇒ JWKS fallback (dev convenience).
	PrivyVerificationKey string
	// PrivyAppSecret enables the Privy server API (auth.privy.io) so a user's
	// verified email can be resolved by DID when it is not in the access token.
	// This is the concrete production use for the app secret (spec §7c.1).
	// Empty ⇒ email is taken from the token claim only.
	PrivyAppSecret string

	// Admin & warp (spec §7c). AdminEmails is the lowercased set of admin
	// email addresses. is_admin = email_verified (or AdminTrustUnverifiedEmail)
	// AND lower(email) ∈ AdminEmails.
	AdminEmails               map[string]bool
	AdminTrustUnverifiedEmail bool

	// S3 / MinIO object storage.
	S3Endpoint       string
	S3Region         string
	S3Bucket         string
	S3AccessKey      string
	S3SecretKey      string
	S3PublicURL      string
	S3ForcePathStyle bool

	// When false (default), uploads are stored on the local filesystem under
	// LocalUploadDir and served by this server — dev needs no cloud.
	InProduction   bool
	LocalUploadDir string

	// LLM market-generation agent.
	OpenAIAPIKey string
	LLMModel     string

	// Bearer token remote oracle nodes use to call the MCP endpoint.
	MCPNodeToken string

	// Chain.
	ChainRPCURL           string
	ChainID               int64
	PaymentTokenAddress   string
	MarketsContractAddr   string
	HubAddress            string
	RelayerPrivateKey     string
	RelayerBatchMS        int
	RelayerBatchMax       int

	// Relayer gas-sponsorship limits (spec §6.6/§8).
	MaxOrderCost    int64 // token units; per signed order
	OrderRatePerMin int   // per-user relayed orders per minute

	// Onramp: fiat = Stripe checkout rail; crypto = home-chain deposits +
	// bridge-aggregator (LI.FI-style) quotes.
	StripeSecretKey     string
	StripeWebhookSecret string
	BridgeAPIURL        string
	BridgeAPIKey        string
	OnrampReturnURL     string
}

// Load reads .env (if present) and the process environment.
func Load() *Config {
	_ = godotenv.Load()

	port := get("PORT", "8080")
	c := &Config{
		Port:         port,
		Env:          get("ENV", "development"),
		Region:       get("REGION", "local"),
		CORSOrigins:  splitList(get("CORS_ORIGINS", "http://localhost:3000")),
		PublicAPIURL: get("PUBLIC_API_URL", "http://localhost:"+port),
		PublicWebURL: get("PUBLIC_WEB_URL", "http://localhost:3000"),

		DatabaseURL: must("DATABASE_URL"),

		BusDriver: get("BUS_DRIVER", "pg"),
		RedisURL:  get("REDIS_URL", "redis://localhost:6379/0"),

		PrivyAppID:           must("PRIVY_APP_ID"),
		PrivyVerificationKey: os.Getenv("PRIVY_VERIFICATION_KEY"),
		PrivyAppSecret:       os.Getenv("PRIVY_APP_SECRET"),

		AdminEmails:               lowerSet(splitList(os.Getenv("ADMIN_EMAILS"))),
		AdminTrustUnverifiedEmail: get("ADMIN_TRUST_UNVERIFIED_EMAIL", "false") == "true",

		S3Endpoint:       os.Getenv("S3_ENDPOINT"),
		S3Region:         get("S3_REGION", "us-east-1"),
		S3Bucket:         get("S3_BUCKET", "thassa-assets"),
		S3AccessKey:      os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:      os.Getenv("S3_SECRET_KEY"),
		S3PublicURL:      os.Getenv("S3_PUBLIC_URL"),
		S3ForcePathStyle: get("S3_FORCE_PATH_STYLE", "true") == "true",

		InProduction:   get("IN_PRODUCTION", "false") == "true",
		LocalUploadDir: get("LOCAL_UPLOAD_DIR", "uploads"),

		OpenAIAPIKey: os.Getenv("OPENAI_API_KEY"),
		LLMModel:     get("LLM_MODEL", "gpt-5.4"),

		MCPNodeToken: os.Getenv("MCP_NODE_TOKEN"),

		ChainRPCURL:         get("CHAIN_RPC_URL", "http://localhost:8545"),
		ChainID:             getInt64("CHAIN_ID", 31337),
		PaymentTokenAddress: os.Getenv("PAYMENT_TOKEN_ADDRESS"),
		MarketsContractAddr: os.Getenv("MARKETS_CONTRACT_ADDRESS"),
		HubAddress:          os.Getenv("HUB_ADDRESS"),
		RelayerPrivateKey:   os.Getenv("RELAYER_PRIVATE_KEY"),
		RelayerBatchMS:      getInt("RELAYER_BATCH_MS", 2000),
		RelayerBatchMax:     getInt("RELAYER_BATCH_MAX", 25),

		MaxOrderCost:    getInt64("MAX_ORDER_COST", 1000_000_000), // $1000 @ 6dp
		OrderRatePerMin: getInt("ORDER_RATE_PER_MIN", 30),

		StripeSecretKey:     os.Getenv("STRIPE_SECRET_KEY"),
		StripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"),
		BridgeAPIURL:        get("BRIDGE_API_URL", "https://li.quest"),
		BridgeAPIKey:        os.Getenv("BRIDGE_API_KEY"),
		OnrampReturnURL:     get("ONRAMP_RETURN_URL", "http://localhost:3000/wallet"),
	}
	return c
}

// ChainEnabled reports whether the chain services (relayer/indexer/settlement)
// can run: they need the contract addresses and a funded relayer key.
func (c *Config) ChainEnabled() bool {
	return c.PaymentTokenAddress != "" && c.MarketsContractAddr != "" && c.RelayerPrivateKey != ""
}

func get(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("config: required env var %s is not set", k)
	}
	return v
}

func getInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getInt64(k string, def int64) int64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

// EmailIsAdmin reports whether the given email grants admin. The email must be
// verified (spec §7c: a spoofed client email can never grant admin) unless the
// dev escape hatch AdminTrustUnverifiedEmail is set. Matching is
// case-insensitive against ADMIN_EMAILS.
func (c *Config) EmailIsAdmin(email string, verified bool) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	if !verified && !c.AdminTrustUnverifiedEmail {
		return false
	}
	return c.AdminEmails[email]
}

// lowerSet builds a lowercased membership set from a list.
func lowerSet(items []string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, it := range items {
		if it = strings.ToLower(strings.TrimSpace(it)); it != "" {
			m[it] = true
		}
	}
	return m
}

func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
