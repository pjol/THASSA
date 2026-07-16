// Package sources implements the authoritative-resolution-source layer of the oracle node
// (platform spec section 6.5b): parsing structured settlement queries, per-source HTTP fetch
// adapters (ESPN, news RSS panel, NWS weather, Coinbase pricing), a pluggable adapter registry
// seeded with defaults and refreshable from the backend MCP server, and the concurrence math
// applied to per-source verdicts.
package sources

import (
	"errors"
	"time"
)

// Resolution rules.
const (
	RuleSingle   = "single"
	RuleMajority = "majority"
)

// Well-known categories.
const (
	CategorySports  = "sports"
	CategoryNews    = "news"
	CategoryWeather = "weather"
	CategoryPrice   = "price"
	CategoryGeneral = "general"
)

// Error taxonomy. Adapters wrap these so callers can distinguish transient unavailability
// (retry later) from configuration problems (operator action required).
var (
	// ErrSourceUnavailable marks transient failures: network errors, timeouts, 5xx, bad payloads.
	ErrSourceUnavailable = errors.New("source unavailable")
	// ErrSourceMisconfigured marks permanent failures: missing bound URL, missing API key.
	ErrSourceMisconfigured = errors.New("source misconfigured")
	// ErrUnknownSource marks a source id with no registered adapter.
	ErrUnknownSource = errors.New("unknown source")
)

// SourceRef is one bound source inside a structured settlement query
// {"sources": [{"id", "name", "url"}]}.
type SourceRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// StructuredQuery is the structured settlement query JSON stored onchain:
// {"question", "category", "rule": "single|majority", "sources": [...]}.
type StructuredQuery struct {
	Question string      `json:"question"`
	Category string      `json:"category"`
	Rule     string      `json:"rule"`
	Sources  []SourceRef `json:"sources"`
}

// Evidence is the raw material handed to the adjudication LLM: what one source said, fetched
// directly by the node (never by the model).
type Evidence struct {
	SourceID  string    `json:"sourceId"`
	Name      string    `json:"name"`
	URL       string    `json:"url"`
	Content   string    `json:"content"`
	FetchedAt time.Time `json:"fetchedAt"`
}

// Verdict is one source's independent adjudication result. Err is non-nil when the source could
// not be fetched or adjudicated; such verdicts never count toward concurrence.
type Verdict struct {
	SourceID  string
	Settled   bool
	Direction bool
	Err       error
}

// Outcome is the aggregate resolution across all bound sources.
type Outcome struct {
	Settled   bool
	Direction bool
	Reason    string
}

// CategoryRule is one registry entry: the resolution rule plus the bound sources for a category.
type CategoryRule struct {
	Rule    string      `json:"rule"`
	Sources []SourceRef `json:"sources"`
}
