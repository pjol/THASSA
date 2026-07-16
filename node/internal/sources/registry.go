package sources

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Registry routes source ids to fetch adapters and holds the per-category resolution rules.
// It is seeded with the built-in defaults below and can be refreshed from the backend MCP
// server; when the MCP endpoint is unreachable the built-ins keep working.
type Registry struct {
	mu         sync.RWMutex
	adapters   map[string]Adapter
	aliases    map[string]string
	categories map[string]CategoryRule
}

// NewRegistry builds a registry with all default adapters registered and the default category
// bindings from platform spec section 6.5b.
func NewRegistry(fetchTimeout time.Duration) *Registry {
	f := newFetcher(fetchTimeout)

	registry := &Registry{
		adapters:   map[string]Adapter{},
		aliases:    map[string]string{},
		categories: map[string]CategoryRule{},
	}

	registry.Register(espnAdapter{fetcher: f})
	registry.Register(rssAdapter{
		id:          "nyt",
		name:        "The New York Times",
		defaultFeed: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
		allowedHost: []string{"nytimes.com"},
		fetcher:     f,
	})
	registry.Register(rssAdapter{
		id:          "wsj",
		name:        "The Wall Street Journal",
		defaultFeed: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews",
		allowedHost: []string{"dowjones.io", "wsj.com"},
		fetcher:     f,
	})
	// Reuters and AP publish no first-party public RSS; both are consumed through the public
	// Google News RSS index scoped to their domains, which carries their headlines verbatim.
	registry.Register(rssAdapter{
		id:          "reuters",
		name:        "Reuters",
		defaultFeed: "https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en",
		allowedHost: []string{"news.google.com", "reuters.com", "reutersagency.com"},
		fetcher:     f,
	})
	registry.Register(rssAdapter{
		id:          "ap",
		name:        "The Associated Press",
		defaultFeed: "https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en",
		allowedHost: []string{"news.google.com", "apnews.com"},
		fetcher:     f,
	})
	registry.Register(rssAdapter{
		id:          "bbc",
		name:        "BBC News",
		defaultFeed: "https://feeds.bbci.co.uk/news/rss.xml",
		allowedHost: []string{"bbci.co.uk", "bbc.co.uk", "bbc.com"},
		fetcher:     f,
	})
	registry.Register(nwsAdapter{fetcher: f})
	registry.Register(coinbaseAdapter{fetcher: f})

	registry.aliases["weather"] = "nws"
	registry.aliases["noaa"] = "nws"
	registry.aliases["price"] = "coinbase"

	registry.categories = DefaultCategories()

	return registry
}

// DefaultCategories is the built-in registry fallback (spec 6.5b): numeric data resolves against
// exactly one publicly disclosed source; boolean news questions against a majority panel.
func DefaultCategories() map[string]CategoryRule {
	return map[string]CategoryRule{
		CategorySports: {
			Rule: RuleSingle,
			Sources: []SourceRef{
				{ID: "espn", Name: "ESPN", URL: defaultESPNURL},
			},
		},
		CategoryNews: {
			Rule: RuleMajority,
			Sources: []SourceRef{
				{ID: "nyt", Name: "The New York Times"},
				{ID: "wsj", Name: "The Wall Street Journal"},
				{ID: "reuters", Name: "Reuters"},
				{ID: "ap", Name: "The Associated Press"},
				{ID: "bbc", Name: "BBC News"},
			},
		},
		CategoryWeather: {
			Rule: RuleSingle,
			Sources: []SourceRef{
				{ID: "nws", Name: "National Weather Service", URL: "https://api.weather.gov"},
			},
		},
		CategoryPrice: {
			Rule: RuleSingle,
			Sources: []SourceRef{
				{ID: "coinbase", Name: "Coinbase"},
			},
		},
		CategoryGeneral: {
			Rule:    RuleSingle,
			Sources: nil, // general questions fall through to labeled LLM adjudication
		},
	}
}

// Register adds or replaces an adapter, keyed by its id.
func (r *Registry) Register(adapter Adapter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.adapters[strings.ToLower(adapter.ID())] = adapter
}

// Adapter resolves a source id (or alias) to its adapter.
func (r *Registry) Adapter(sourceID string) (Adapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	id := strings.ToLower(strings.TrimSpace(sourceID))
	if alias, ok := r.aliases[id]; ok {
		id = alias
	}
	adapter, ok := r.adapters[id]
	return adapter, ok
}

// Fetch routes one bound source to its adapter and fetches evidence.
func (r *Registry) Fetch(ctx context.Context, ref SourceRef, question string) (Evidence, error) {
	adapter, ok := r.Adapter(ref.ID)
	if !ok {
		return Evidence{}, fmt.Errorf("%w: no adapter registered for source id %q", ErrUnknownSource, ref.ID)
	}
	return adapter.Fetch(ctx, ref, question)
}

// Category returns the resolution rule bound to a category name.
func (r *Registry) Category(name string) (CategoryRule, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rule, ok := r.categories[strings.ToLower(strings.TrimSpace(name))]
	return rule, ok
}

// ApplyCategories replaces category bindings with a registry snapshot fetched over MCP.
// Unknown/empty snapshots are ignored so a bad refresh can never wipe the built-ins.
func (r *Registry) ApplyCategories(categories map[string]CategoryRule) {
	if len(categories) == 0 {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	for name, rule := range categories {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		rule.Rule = strings.ToLower(strings.TrimSpace(rule.Rule))
		if rule.Rule != RuleSingle && rule.Rule != RuleMajority {
			continue
		}
		r.categories[name] = rule
	}
}
