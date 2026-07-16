// Package sources is the authoritative-resolution-source registry (spec
// §6.5b). Market settlement resolves against known sources, not open-ended
// LLM web search. The registry is publicly readable (GET /v1/sources) and
// served to remote oracle nodes over MCP (list_sources / resolve_sources).
//
// Invariant encoded here: numeric categories bind EXACTLY ONE publicly
// disclosed source (rule "single"); boolean categories bind a multi-source
// majority panel of odd size ≥ 3 (rule "majority").
package sources

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Rules.
const (
	RuleSingle   = "single"
	RuleMajority = "majority"
)

// Source is one authoritative endpoint.
type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// Category binds a market category to its resolution rule + sources.
type Category struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"` // numeric | boolean | general
	Rule    string   `json:"rule"` // single | majority
	Sources []Source `json:"sources"`
}

// Registry is the full source registry.
type Registry struct {
	Categories []Category `json:"categories"`
}

// SettlementQuery is the structured JSON stored onchain and rendered in the
// UI: it always discloses the bound source(s).
type SettlementQuery struct {
	Question string   `json:"question"`
	Category string   `json:"category"`
	Rule     string   `json:"rule"`
	Sources  []Source `json:"sources"`
}

// Default builds the registry seeded per spec §6.5b. Deployments may override
// individual sources via future config; the invariants are re-validated.
func Default() *Registry {
	r := &Registry{Categories: []Category{
		{
			ID: "sports", Name: "Sports", Kind: "boolean", Rule: RuleSingle,
			Sources: []Source{{ID: "espn", Name: "ESPN", URL: "https://www.espn.com"}},
		},
		{
			ID: "news", Name: "News", Kind: "boolean", Rule: RuleMajority,
			Sources: []Source{
				{ID: "nyt", Name: "The New York Times", URL: "https://www.nytimes.com"},
				{ID: "wsj", Name: "The Wall Street Journal", URL: "https://www.wsj.com"},
				{ID: "reuters", Name: "Reuters", URL: "https://www.reuters.com"},
				{ID: "ap", Name: "Associated Press", URL: "https://apnews.com"},
				{ID: "bbc", Name: "BBC", URL: "https://www.bbc.com"},
			},
		},
		{
			ID: "weather", Name: "Weather", Kind: "numeric", Rule: RuleSingle,
			Sources: []Source{{ID: "nws", Name: "National Weather Service", URL: "https://api.weather.gov"}},
		},
		{
			ID: "price", Name: "Asset prices", Kind: "numeric", Rule: RuleSingle,
			Sources: []Source{{ID: "coinbase", Name: "Coinbase spot", URL: "https://api.coinbase.com"}},
		},
		{
			ID: "general", Name: "General (LLM adjudication)", Kind: "general", Rule: RuleSingle,
			Sources: []Source{{ID: "llm", Name: "LLM adjudication (fallback — clearly labeled)", URL: ""}},
		},
	}}
	if err := r.Validate(); err != nil {
		panic("sources: default registry violates invariants: " + err.Error())
	}
	return r
}

// Validate enforces the registry invariants (spec §6.5b rule of thumb):
// numeric data ⇒ exactly one publicly-disclosed source; boolean data with
// rule majority ⇒ odd panel of at least 3 sources.
func (r *Registry) Validate() error {
	for _, c := range r.Categories {
		switch c.Rule {
		case RuleSingle:
			if len(c.Sources) != 1 {
				return fmt.Errorf("category %s: rule single requires exactly 1 source, has %d", c.ID, len(c.Sources))
			}
		case RuleMajority:
			if c.Kind == "numeric" {
				return fmt.Errorf("category %s: numeric categories must use rule single", c.ID)
			}
			if len(c.Sources) < 3 || len(c.Sources)%2 == 0 {
				return fmt.Errorf("category %s: rule majority requires an odd panel ≥ 3, has %d", c.ID, len(c.Sources))
			}
		default:
			return fmt.Errorf("category %s: unknown rule %q", c.ID, c.Rule)
		}
		if c.Kind == "numeric" && (c.Rule != RuleSingle || len(c.Sources) != 1) {
			return fmt.Errorf("category %s: numeric ⇒ exactly one source", c.ID)
		}
	}
	return nil
}

// Get returns a category by id (nil when unknown).
func (r *Registry) Get(id string) *Category {
	for i := range r.Categories {
		if r.Categories[i].ID == id {
			return &r.Categories[i]
		}
	}
	return nil
}

// List returns all categories, or just one when a filter id is given.
func (r *Registry) List(categoryID string) []Category {
	if categoryID == "" {
		return r.Categories
	}
	if c := r.Get(categoryID); c != nil {
		return []Category{*c}
	}
	return nil
}

// --- categorization ---------------------------------------------------------

var categoryPatterns = []struct {
	category string
	re       *regexp.Regexp
}{
	{"sports", regexp.MustCompile(`(?i)\b(nba|nfl|mlb|nhl|ncaa|premier league|la liga|serie a|bundesliga|champions league|world cup|super ?bowl|playoffs?|finals?|grand slam|wimbledon|us open|olympics?|match|game \d|beat[s]?|defeat[s]?|win[s]? (the|against|over)|score[s]?|touchdown|home run|goal[s]?|team|championship|tournament|f1|grand prix|ufc|boxing)\b`)},
	{"weather", regexp.MustCompile(`(?i)\b(temperature|rain(fall)?|snow(fall)?|precipitation|humidity|wind speed|hurricane|storm|heatwave|degrees|celsius|fahrenheit|°[cf]|forecast|weather|sunny|cloudy)\b`)},
	{"price", regexp.MustCompile(`(?i)\b(price|btc|bitcoin|eth(ereum)?|sol(ana)?|doge(coin)?|crypto(currency)?|token|coin|stock|share price|market cap|trading|exchange rate|usd[tc]?|above \$|below \$|\$\d)\b`)},
	{"news", regexp.MustCompile(`(?i)\b(elect(ion|ed)?|president|senate|congress|parliament|prime minister|bill|law|announce[ds]?|resign[s]?|indict(ed|ment)?|treaty|war|ceasefire|sanction[s]?|merger|acquisition|ipo|bankrupt(cy)?|verdict|ruling|scandal|summit|policy)\b`)},
}

// Categorize maps a question to a registry category using keyword heuristics;
// uncategorizable questions fall back to "general" (clearly labeled).
func (r *Registry) Categorize(question string) *Category {
	q := strings.TrimSpace(question)
	for _, p := range categoryPatterns {
		if p.re.MatchString(q) {
			if c := r.Get(p.category); c != nil {
				return c
			}
		}
	}
	return r.Get("general")
}

// Resolve implements resolve_sources: question → category + rule + sources.
func (r *Registry) Resolve(question string) SettlementQuery {
	c := r.Categorize(question)
	return SettlementQuery{
		Question: question,
		Category: c.ID,
		Rule:     c.Rule,
		Sources:  c.Sources,
	}
}

// BuildSettlementQuery binds a settlement question to a category's sources
// and serializes the structured JSON stored onchain.
func (r *Registry) BuildSettlementQuery(question, categoryID string) (SettlementQuery, string, error) {
	c := r.Get(categoryID)
	if c == nil {
		c = r.Get("general")
	}
	sq := SettlementQuery{Question: question, Category: c.ID, Rule: c.Rule, Sources: c.Sources}
	b, err := json.Marshal(sq)
	if err != nil {
		return sq, "", err
	}
	return sq, string(b), nil
}

// ParseSettlementQuery decodes a stored settlement query. Legacy plain-text
// queries are mapped to a general-category structure so old rows render.
func ParseSettlementQuery(raw string) SettlementQuery {
	var sq SettlementQuery
	if err := json.Unmarshal([]byte(raw), &sq); err == nil && sq.Question != "" {
		return sq
	}
	return SettlementQuery{Question: raw, Category: "general", Rule: RuleSingle,
		Sources: []Source{{ID: "llm", Name: "LLM adjudication (fallback — clearly labeled)"}}}
}
