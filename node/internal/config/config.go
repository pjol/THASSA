package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port string

	OpenAIAPIKey          string
	OpenAIBaseURL         string
	DefaultModel          string
	OpenAIMaxContextChars int

	NodePrivateKey string

	RequestTimeout        time.Duration
	AutoFulfillLLMTimeout time.Duration

	DefaultHubAddress    string
	DefaultChainID       uint64
	DefaultClientVersion uint64
	DefaultTTLSeconds    uint64

	RPCURL                  string
	AutoFulfillBids         bool
	BidScanInterval         time.Duration
	ABIDir                  string
	AutoFulfillInputData    map[string]any
	AutoFulfillInputDataRaw string
}

func Load() (Config, error) {
	if err := loadDotEnv(".env"); err != nil {
		return Config{}, err
	}

	openAIAPIKey, err := requireEnv("OPENAI_API_KEY")
	if err != nil {
		return Config{}, err
	}

	nodePrivateKey, err := requireEnv("NODE_PRIVATE_KEY")
	if err != nil {
		return Config{}, err
	}

	requestTimeoutSeconds, err := envUint64("REQUEST_TIMEOUT_SECONDS", 45)
	if err != nil {
		return Config{}, err
	}
	openAIMaxContextChars, err := envUint64("OPENAI_MAX_CONTEXT_CHARS", 16000)
	if err != nil {
		return Config{}, err
	}
	autoFulfillLLMTimeoutSeconds, err := envUint64("AUTO_FULFILL_LLM_TIMEOUT_SECONDS", 120)
	if err != nil {
		return Config{}, err
	}

	defaultChainID, err := envUint64("DEFAULT_CHAIN_ID", 31337)
	if err != nil {
		return Config{}, err
	}

	defaultClientVersion, err := envUint64("DEFAULT_CLIENT_VERSION", 1)
	if err != nil {
		return Config{}, err
	}

	defaultTTLSeconds, err := envUint64("DEFAULT_TTL_SECONDS", 3600)
	if err != nil {
		return Config{}, err
	}

	bidScanIntervalSeconds, err := envUint64("BID_SCAN_INTERVAL_SECONDS", 2)
	if err != nil {
		return Config{}, err
	}

	autoFulfillBids, err := envBool("AUTO_FULFILL_BIDS", true)
	if err != nil {
		return Config{}, err
	}

	autoFulfillInputDataRaw := envString("AUTO_FULFILL_INPUT_DATA_JSON", "{}")
	autoFulfillInputData, err := parseJSONMap(autoFulfillInputDataRaw)
	if err != nil {
		return Config{}, fmt.Errorf("invalid AUTO_FULFILL_INPUT_DATA_JSON: %w", err)
	}

	return Config{
		Port:                    envString("PORT", "8080"),
		OpenAIAPIKey:            openAIAPIKey,
		OpenAIBaseURL:           envString("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		DefaultModel:            envString("OPENAI_MODEL", "openai:gpt-5.4"),
		OpenAIMaxContextChars:   int(openAIMaxContextChars),
		NodePrivateKey:          nodePrivateKey,
		RequestTimeout:          time.Duration(requestTimeoutSeconds) * time.Second,
		AutoFulfillLLMTimeout:   time.Duration(autoFulfillLLMTimeoutSeconds) * time.Second,
		DefaultHubAddress:       envString("DEFAULT_THASSA_HUB", ""),
		DefaultChainID:          defaultChainID,
		DefaultClientVersion:    defaultClientVersion,
		DefaultTTLSeconds:       defaultTTLSeconds,
		RPCURL:                  envString("THASSA_RPC_URL", ""),
		AutoFulfillBids:         autoFulfillBids,
		BidScanInterval:         time.Duration(bidScanIntervalSeconds) * time.Second,
		ABIDir:                  envString("ABI_DIR", "abi"),
		AutoFulfillInputData:    autoFulfillInputData,
		AutoFulfillInputDataRaw: autoFulfillInputDataRaw,
	}, nil
}

func requireEnv(key string) (string, error) {
	value := os.Getenv(key)
	if value == "" {
		return "", fmt.Errorf("%w: %s", ErrMissingEnv, key)
	}
	return value, nil
}

func envString(key string, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func envUint64(key string, defaultValue uint64) (uint64, error) {
	raw := envString(key, "")
	if raw == "" {
		return defaultValue, nil
	}

	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", key, err)
	}
	return value, nil
}

func envBool(key string, defaultValue bool) (bool, error) {
	raw := strings.TrimSpace(envString(key, ""))
	if raw == "" {
		return defaultValue, nil
	}

	switch strings.ToLower(raw) {
	case "1", "true", "yes", "y", "on":
		return true, nil
	case "0", "false", "no", "n", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid %s: expected boolean-like value", key)
	}
}

func parseJSONMap(raw string) (map[string]any, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()

	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}

	if value == nil {
		return map[string]any{}, nil
	}

	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("value must be a JSON object")
	}

	return object, nil
}

var ErrMissingEnv = errors.New("missing required environment variable")
