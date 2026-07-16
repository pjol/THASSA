package sources

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFetcher_StatusClassification(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			_, _ = w.Write([]byte(`{"hello":"world"}`))
		case "/missing":
			w.WriteHeader(http.StatusNotFound)
		case "/forbidden":
			w.WriteHeader(http.StatusForbidden)
		case "/down":
			w.WriteHeader(http.StatusBadGateway)
		case "/empty":
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	f := newFetcher(2 * time.Second)
	ctx := context.Background()

	if body, err := f.get(ctx, server.URL+"/ok", nil); err != nil || string(body) != `{"hello":"world"}` {
		t.Fatalf("expected ok fetch, got body=%q err=%v", body, err)
	}
	if _, err := f.get(ctx, server.URL+"/missing", nil); !errors.Is(err, ErrSourceMisconfigured) {
		t.Fatalf("404 must classify as misconfigured, got %v", err)
	}
	if _, err := f.get(ctx, server.URL+"/forbidden", nil); !errors.Is(err, ErrSourceMisconfigured) {
		t.Fatalf("403 must classify as misconfigured, got %v", err)
	}
	if _, err := f.get(ctx, server.URL+"/down", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("502 must classify as unavailable, got %v", err)
	}
	if _, err := f.get(ctx, server.URL+"/empty", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("empty body must classify as unavailable, got %v", err)
	}
}

func TestFetcher_RequiredAPIKeyEnvMissingIsExplicit(t *testing.T) {
	f := newFetcher(time.Second)
	f.apiKeyEnv = "THASSA_TEST_MISSING_API_KEY"
	f.apiKeyHeader = "X-Api-Key"

	_, err := f.get(context.Background(), "https://example.com/data", nil)
	if !errors.Is(err, ErrSourceMisconfigured) || !strings.Contains(err.Error(), "THASSA_TEST_MISSING_API_KEY") {
		t.Fatalf("missing API key env must be an explicit configuration error, got %v", err)
	}
}

func TestRequireHost_AllowlistsAndScheme(t *testing.T) {
	if err := requireHost("espn", "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", "espn.com"); err != nil {
		t.Fatalf("espn subdomain must pass: %v", err)
	}
	if err := requireHost("espn", "https://evil.com/espn.com", "espn.com"); !errors.Is(err, ErrSourceMisconfigured) {
		t.Fatalf("foreign host must fail: %v", err)
	}
	if err := requireHost("espn", "http://site.api.espn.com/x", "espn.com"); !errors.Is(err, ErrSourceMisconfigured) {
		t.Fatalf("plain http must fail: %v", err)
	}
	if err := requireHost("nws", "https://api.weather.gov/stations/KSFO/observations/latest", nwsHost); err != nil {
		t.Fatalf("exact host must pass: %v", err)
	}
}

func TestESPNAdapter_SummarizesScoreboard(t *testing.T) {
	payload := `{
		"events": [{
			"name": "San Francisco 49ers at Seattle Seahawks",
			"date": "2026-07-12T20:00Z",
			"status": {"type": {"description": "Final", "completed": true, "detail": "Final"}},
			"competitions": [{
				"competitors": [
					{"homeAway": "home", "score": "17", "winner": false, "team": {"displayName": "Seattle Seahawks"}},
					{"homeAway": "away", "score": "24", "winner": true, "team": {"displayName": "San Francisco 49ers"}}
				]
			}]
		}]
	}`

	content := espnAdapter{}.summarize([]byte(payload))
	for _, expected := range []string{"San Francisco 49ers at Seattle Seahawks", "completed=true", "score=24 winner=true"} {
		if !strings.Contains(content, expected) {
			t.Fatalf("summary missing %q:\n%s", expected, content)
		}
	}

	// Non-scoreboard payloads pass through raw for the adjudicator.
	raw := `{"boxscore": {"teams": []}}`
	if content := (espnAdapter{}).summarize([]byte(raw)); content != raw {
		t.Fatalf("non-scoreboard payload must pass through, got %q", content)
	}
}

func TestParseFeedItems_RSSAndAtom(t *testing.T) {
	rss := `<?xml version="1.0"?>
	<rss version="2.0"><channel><title>BBC News</title>
		<item><title>Measurable rain falls in San Francisco</title><description>0.12 in recorded at KSFO</description><pubDate>Wed, 15 Jul 2026 12:00:00 GMT</pubDate><link>https://www.bbc.com/news/1</link></item>
		<item><title>Unrelated markets story</title><description>equities</description><pubDate>Wed, 15 Jul 2026 11:00:00 GMT</pubDate><link>https://www.bbc.com/news/2</link></item>
	</channel></rss>`

	items, title, err := parseFeedItems([]byte(rss))
	if err != nil || title != "BBC News" || len(items) != 2 {
		t.Fatalf("rss parse failed: items=%d title=%q err=%v", len(items), title, err)
	}

	atom := `<?xml version="1.0"?>
	<feed xmlns="http://www.w3.org/2005/Atom"><title>NYT</title>
		<entry><title>Atom entry one</title><summary>details</summary><updated>2026-07-15T12:00:00Z</updated><link href="https://nyt.com/1"/></entry>
	</feed>`

	items, title, err = parseFeedItems([]byte(atom))
	if err != nil || title != "NYT" || len(items) != 1 || items[0].Link != "https://nyt.com/1" {
		t.Fatalf("atom parse failed: items=%+v title=%q err=%v", items, title, err)
	}
}

func TestSelectRelevantItems_PrefersQuestionTerms(t *testing.T) {
	items := []rssItem{
		{Title: "Unrelated story about markets"},
		{Title: "Rain recorded in San Francisco", Description: "precipitation at KSFO"},
		{Title: "Another unrelated story"},
	}

	selected := selectRelevantItems(items, "Did measurable precipitation fall in San Francisco?", 1)
	if len(selected) != 1 || !strings.Contains(selected[0].Title, "San Francisco") {
		t.Fatalf("expected the relevant item first, got %+v", selected)
	}

	// No overlap: newest items still returned so absence of coverage is observable.
	selected = selectRelevantItems(items, "zebra kayak", 2)
	if len(selected) != 2 || selected[0].Title != items[0].Title {
		t.Fatalf("expected original order fallback, got %+v", selected)
	}
}

func TestSummarizeNWSPayload_FlattensProperties(t *testing.T) {
	payload := `{"properties": {"temperature": {"value": 15.6, "unitCode": "wmoUnit:degC"}, "textDescription": "Cloudy", "nullField": null, "@context": "ignored"}}`

	content := summarizeNWSPayload([]byte(payload))
	for _, expected := range []string{"temperature.value: 15.6", "textDescription: Cloudy"} {
		if !strings.Contains(content, expected) {
			t.Fatalf("nws summary missing %q:\n%s", expected, content)
		}
	}
	if strings.Contains(content, "nullField") || strings.Contains(content, "@context") {
		t.Fatalf("nws summary must skip nulls and @-keys:\n%s", content)
	}
}

func TestCoinbaseAdapter_DerivePairAndBoundURL(t *testing.T) {
	if pair := derivePricePair("Will BTC-USD close above $150,000 on 2026-08-01?"); pair != "BTC-USD" {
		t.Fatalf("expected BTC-USD, got %q", pair)
	}
	if pair := derivePricePair("Will ETH/USD trade above 10k?"); pair != "ETH-USD" {
		t.Fatalf("expected ETH-USD, got %q", pair)
	}
	if pair := derivePricePair("Will it rain tomorrow?"); pair != "" {
		t.Fatalf("expected no pair, got %q", pair)
	}

	// Without a bound URL or derivable pair the adapter reports explicit misconfiguration.
	_, err := coinbaseAdapter{fetcher: newFetcher(time.Second)}.Fetch(context.Background(), SourceRef{ID: "coinbase"}, "Will it rain?")
	if !errors.Is(err, ErrSourceMisconfigured) {
		t.Fatalf("expected misconfiguration error, got %v", err)
	}
}

func TestNWSAdapter_RequiresBoundURL(t *testing.T) {
	_, err := nwsAdapter{fetcher: newFetcher(time.Second)}.Fetch(context.Background(), SourceRef{ID: "nws"}, "weather?")
	if !errors.Is(err, ErrSourceMisconfigured) {
		t.Fatalf("expected misconfiguration error, got %v", err)
	}
}

func TestRegistry_DefaultsAndRouting(t *testing.T) {
	registry := NewRegistry(time.Second)

	for _, id := range []string{"espn", "nyt", "wsj", "reuters", "ap", "bbc", "nws", "coinbase"} {
		if _, ok := registry.Adapter(id); !ok {
			t.Fatalf("default adapter %q missing", id)
		}
	}
	if adapter, ok := registry.Adapter("weather"); !ok || adapter.ID() != "nws" {
		t.Fatalf("weather alias must route to nws")
	}

	news, ok := registry.Category(CategoryNews)
	if !ok || news.Rule != RuleMajority || len(news.Sources) != 5 {
		t.Fatalf("default news category wrong: %+v", news)
	}
	sports, ok := registry.Category(CategorySports)
	if !ok || sports.Rule != RuleSingle || len(sports.Sources) != 1 {
		t.Fatalf("default sports category wrong: %+v", sports)
	}

	if _, err := registry.Fetch(context.Background(), SourceRef{ID: "unknown-src"}, "q"); !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("unknown source must error, got %v", err)
	}
}

func TestRegistry_ApplyCategoriesValidatesEntries(t *testing.T) {
	registry := NewRegistry(time.Second)

	registry.ApplyCategories(map[string]CategoryRule{
		"esports": {Rule: "MAJORITY", Sources: []SourceRef{{ID: "espn"}, {ID: "bbc"}, {ID: "nyt"}}},
		"bad":     {Rule: "plurality"},
		"":        {Rule: RuleSingle},
	})

	if rule, ok := registry.Category("esports"); !ok || rule.Rule != RuleMajority || len(rule.Sources) != 3 {
		t.Fatalf("esports category not applied: %+v", rule)
	}
	if _, ok := registry.Category("bad"); ok {
		t.Fatalf("invalid rule must be rejected")
	}

	// Empty refreshes never wipe existing bindings.
	registry.ApplyCategories(nil)
	if _, ok := registry.Category(CategoryNews); !ok {
		t.Fatalf("built-in categories must survive empty refresh")
	}
}
