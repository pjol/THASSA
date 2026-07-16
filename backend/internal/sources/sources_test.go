package sources

import (
	"encoding/json"
	"testing"
)

func TestDefaultRegistryInvariants(t *testing.T) {
	r := Default()
	if err := r.Validate(); err != nil {
		t.Fatalf("default registry invalid: %v", err)
	}
	for _, c := range r.Categories {
		switch c.Kind {
		case "numeric":
			// Numeric data ⇒ exactly one publicly-disclosed source, rule single.
			if c.Rule != RuleSingle || len(c.Sources) != 1 {
				t.Fatalf("numeric category %s must bind exactly one source with rule single", c.ID)
			}
		case "boolean":
			if c.Rule == RuleMajority && (len(c.Sources) < 3 || len(c.Sources)%2 == 0) {
				t.Fatalf("majority category %s must have an odd panel ≥ 3", c.ID)
			}
		}
	}
	// The spec-mandated seeds.
	if r.Get("sports").Sources[0].ID != "espn" {
		t.Fatal("sports must bind ESPN")
	}
	if r.Get("weather").Sources[0].ID != "nws" {
		t.Fatal("weather must bind NWS")
	}
	if r.Get("price").Sources[0].ID != "coinbase" {
		t.Fatal("price must bind Coinbase spot")
	}
	if r.Get("news").Rule != RuleMajority || len(r.Get("news").Sources) != 5 {
		t.Fatal("news must be a 5-source majority panel")
	}
}

func TestValidateRejectsBadRegistries(t *testing.T) {
	// Numeric with 2 sources violates the single-source invariant.
	bad := &Registry{Categories: []Category{{
		ID: "weather", Kind: "numeric", Rule: RuleSingle,
		Sources: []Source{{ID: "a"}, {ID: "b"}},
	}}}
	if err := bad.Validate(); err == nil {
		t.Fatal("numeric with 2 sources must fail validation")
	}
	// Numeric with rule majority is forbidden outright.
	bad = &Registry{Categories: []Category{{
		ID: "price", Kind: "numeric", Rule: RuleMajority,
		Sources: []Source{{ID: "a"}, {ID: "b"}, {ID: "c"}},
	}}}
	if err := bad.Validate(); err == nil {
		t.Fatal("numeric majority must fail validation")
	}
	// Even-sized majority panel can tie — forbidden.
	bad = &Registry{Categories: []Category{{
		ID: "news", Kind: "boolean", Rule: RuleMajority,
		Sources: []Source{{ID: "a"}, {ID: "b"}, {ID: "c"}, {ID: "d"}},
	}}}
	if err := bad.Validate(); err == nil {
		t.Fatal("even majority panel must fail validation")
	}
	// Panel of one is not a majority panel.
	bad = &Registry{Categories: []Category{{
		ID: "news", Kind: "boolean", Rule: RuleMajority,
		Sources: []Source{{ID: "a"}},
	}}}
	if err := bad.Validate(); err == nil {
		t.Fatal("majority panel of 1 must fail validation")
	}
}

func TestCategorize(t *testing.T) {
	r := Default()
	tests := []struct {
		question string
		want     string
	}{
		{"Will the Lakers beat the Warriors in the playoffs?", "sports"},
		{"Will Spain win the World Cup?", "sports"},
		{"Will the temperature in SF exceed 90 degrees on July 20?", "weather"},
		{"Will it rain in Seattle tomorrow?", "weather"},
		{"Will BTC price exceed $150,000 before August?", "price"},
		{"Will ethereum flip bitcoin by market cap?", "price"},
		{"Will the senate pass the bill before recess?", "news"},
		{"Will the president resign this year?", "news"},
		{"Will my neighbor repaint their fence?", "general"},
		{"", "general"},
	}
	for _, tt := range tests {
		if got := r.Categorize(tt.question); got.ID != tt.want {
			t.Fatalf("Categorize(%q) = %s, want %s", tt.question, got.ID, tt.want)
		}
	}
}

func TestResolveBindsSources(t *testing.T) {
	r := Default()
	sq := r.Resolve("Will BTC price exceed $150,000 before August?")
	if sq.Category != "price" || sq.Rule != RuleSingle || len(sq.Sources) != 1 || sq.Sources[0].ID != "coinbase" {
		t.Fatalf("unexpected resolution: %+v", sq)
	}
}

func TestBuildAndParseSettlementQuery(t *testing.T) {
	r := Default()
	question := "Will the NWS-reported high in SF exceed 90°F on 2026-07-20?"
	sq, raw, err := r.BuildSettlementQuery(question, "weather")
	if err != nil {
		t.Fatal(err)
	}
	// The JSON must carry the full public disclosure.
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("settlement query is not valid JSON: %v", err)
	}
	for _, k := range []string{"question", "category", "rule", "sources"} {
		if _, ok := decoded[k]; !ok {
			t.Fatalf("settlement query JSON missing %q: %s", k, raw)
		}
	}
	parsed := ParseSettlementQuery(raw)
	if parsed.Question != question || parsed.Category != sq.Category ||
		parsed.Rule != sq.Rule || len(parsed.Sources) != len(sq.Sources) {
		t.Fatalf("round trip mismatch: %+v vs %+v", parsed, sq)
	}
	// Unknown category falls back to general (clearly labeled).
	sq2, _, err := r.BuildSettlementQuery("anything", "nonexistent")
	if err != nil || sq2.Category != "general" {
		t.Fatalf("unknown category must map to general: %+v %v", sq2, err)
	}
	// Legacy plain-text queries parse as general.
	legacy := ParseSettlementQuery("did the thing happen by friday?")
	if legacy.Category != "general" || legacy.Question == "" {
		t.Fatalf("legacy parse: %+v", legacy)
	}
}
