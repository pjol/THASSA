package sources

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	defaultUserAgent  = "thassa-oracle-node/1.0 (+https://github.com/pjol/THASSA)"
	maxResponseBytes  = 1 << 20 // 1 MiB
	maxEvidenceChars  = 6000
	maxRelevantItems  = 12
	defaultESPNURL    = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
	nwsHost           = "api.weather.gov"
	coinbaseHost      = "api.coinbase.com"
	defaultCoinbaseNS = "https://api.coinbase.com/v2/prices/%s/spot"
)

// Adapter fetches evidence from one authoritative source. Adapters perform real HTTP against
// the source's public endpoints; the LLM never fetches anything itself.
type Adapter interface {
	ID() string
	Fetch(ctx context.Context, ref SourceRef, question string) (Evidence, error)
}

type fetcher struct {
	httpClient *http.Client
	userAgent  string
	// apiKeyEnv, when non-empty, names an environment variable whose value is sent as
	// apiKeyHeader on every request. An empty variable is an explicit configuration error.
	apiKeyEnv    string
	apiKeyHeader string
}

func newFetcher(timeout time.Duration) fetcher {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return fetcher{
		httpClient: &http.Client{Timeout: timeout},
		userAgent:  defaultUserAgent,
	}
}

func (f fetcher) get(ctx context.Context, rawURL string, headers map[string]string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: build request for %s: %v", ErrSourceMisconfigured, rawURL, err)
	}

	request.Header.Set("User-Agent", f.userAgent)
	for key, value := range headers {
		request.Header.Set(key, value)
	}

	if f.apiKeyEnv != "" {
		apiKey := strings.TrimSpace(os.Getenv(f.apiKeyEnv))
		if apiKey == "" {
			return nil, fmt.Errorf("%w: required API key env %s is not set", ErrSourceMisconfigured, f.apiKeyEnv)
		}
		header := f.apiKeyHeader
		if header == "" {
			header = "Authorization"
			apiKey = "Bearer " + apiKey
		}
		request.Header.Set(header, apiKey)
	}

	response, err := f.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: GET %s: %v", ErrSourceUnavailable, rawURL, err)
	}
	defer response.Body.Close()

	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%w: GET %s: HTTP %d (credentials rejected or required)", ErrSourceMisconfigured, rawURL, response.StatusCode)
	case response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusBadRequest:
		return nil, fmt.Errorf("%w: GET %s: HTTP %d (bound URL looks wrong)", ErrSourceMisconfigured, rawURL, response.StatusCode)
	case response.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%w: GET %s: HTTP %d", ErrSourceUnavailable, rawURL, response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("%w: read %s: %v", ErrSourceUnavailable, rawURL, err)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("%w: GET %s: empty response body", ErrSourceUnavailable, rawURL)
	}

	return body, nil
}

func requireHost(sourceID string, rawURL string, allowedSuffixes ...string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return fmt.Errorf("%w: source %s bound URL %q is not a valid https URL", ErrSourceMisconfigured, sourceID, rawURL)
	}

	host := strings.ToLower(parsed.Hostname())
	for _, suffix := range allowedSuffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return nil
		}
	}

	return fmt.Errorf(
		"%w: source %s bound URL host %q is outside its allowed domains %v",
		ErrSourceMisconfigured, sourceID, host, allowedSuffixes,
	)
}

func truncateEvidence(content string) string {
	content = strings.TrimSpace(content)
	if len(content) <= maxEvidenceChars {
		return content
	}
	return content[:maxEvidenceChars] + "\n...[truncated]"
}

// ---------------------------------------------------------------------------
// ESPN (sports; scoreboard/summary JSON API)
// ---------------------------------------------------------------------------

type espnAdapter struct {
	fetcher fetcher
}

type espnScoreboard struct {
	Events []struct {
		Name      string `json:"name"`
		ShortName string `json:"shortName"`
		Date      string `json:"date"`
		Status    struct {
			Type struct {
				Description string `json:"description"`
				Completed   bool   `json:"completed"`
				Detail      string `json:"detail"`
			} `json:"type"`
		} `json:"status"`
		Competitions []struct {
			Competitors []struct {
				HomeAway string `json:"homeAway"`
				Score    string `json:"score"`
				Winner   bool   `json:"winner"`
				Team     struct {
					DisplayName string `json:"displayName"`
				} `json:"team"`
			} `json:"competitors"`
		} `json:"competitions"`
	} `json:"events"`
}

func (a espnAdapter) ID() string { return "espn" }

func (a espnAdapter) Fetch(ctx context.Context, ref SourceRef, _ string) (Evidence, error) {
	endpoint := ref.URL
	if endpoint == "" {
		endpoint = defaultESPNURL
	}
	if err := requireHost(a.ID(), endpoint, "espn.com"); err != nil {
		return Evidence{}, err
	}

	body, err := a.fetcher.get(ctx, endpoint, map[string]string{"Accept": "application/json"})
	if err != nil {
		return Evidence{}, err
	}

	content := a.summarize(body)
	return Evidence{
		SourceID:  ref.ID,
		Name:      sourceName(ref, "ESPN"),
		URL:       endpoint,
		Content:   truncateEvidence(content),
		FetchedAt: time.Now().UTC(),
	}, nil
}

func (a espnAdapter) summarize(body []byte) string {
	var scoreboard espnScoreboard
	if err := json.Unmarshal(body, &scoreboard); err != nil || len(scoreboard.Events) == 0 {
		// Summary/team endpoints have other schemas: hand the raw JSON to the adjudicator.
		return string(body)
	}

	var b strings.Builder
	b.WriteString("ESPN scoreboard events:\n")
	for _, event := range scoreboard.Events {
		status := event.Status.Type.Description
		if event.Status.Type.Detail != "" {
			status = event.Status.Type.Detail
		}
		b.WriteString(fmt.Sprintf("- %s (%s) [%s, completed=%t]", event.Name, event.Date, status, event.Status.Type.Completed))
		for _, competition := range event.Competitions {
			for _, competitor := range competition.Competitors {
				b.WriteString(fmt.Sprintf(
					" | %s (%s) score=%s winner=%t",
					competitor.Team.DisplayName, competitor.HomeAway, competitor.Score, competitor.Winner,
				))
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// News RSS panel (NYT, WSJ, Reuters, AP, BBC)
// ---------------------------------------------------------------------------

type rssAdapter struct {
	id          string
	name        string
	defaultFeed string
	allowedHost []string
	fetcher     fetcher
}

type rssFeed struct {
	Channel struct {
		Title string    `xml:"title"`
		Items []rssItem `xml:"item"`
	} `xml:"channel"`
}

type rssItem struct {
	Title       string `xml:"title"`
	Description string `xml:"description"`
	PubDate     string `xml:"pubDate"`
	Link        string `xml:"link"`
}

type atomFeed struct {
	Title   string `xml:"title"`
	Entries []struct {
		Title   string `xml:"title"`
		Summary string `xml:"summary"`
		Updated string `xml:"updated"`
		Link    struct {
			Href string `xml:"href,attr"`
		} `xml:"link"`
	} `xml:"entry"`
}

func (a rssAdapter) ID() string { return a.id }

func (a rssAdapter) Fetch(ctx context.Context, ref SourceRef, question string) (Evidence, error) {
	endpoint := ref.URL
	if endpoint == "" {
		endpoint = a.defaultFeed
	}
	if err := requireHost(a.ID(), endpoint, a.allowedHost...); err != nil {
		return Evidence{}, err
	}

	body, err := a.fetcher.get(ctx, endpoint, map[string]string{
		"Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
	})
	if err != nil {
		return Evidence{}, err
	}

	items, feedTitle, err := parseFeedItems(body)
	if err != nil {
		return Evidence{}, fmt.Errorf("%w: parse feed %s: %v", ErrSourceUnavailable, endpoint, err)
	}
	if len(items) == 0 {
		return Evidence{}, fmt.Errorf("%w: feed %s contains no items", ErrSourceUnavailable, endpoint)
	}

	selected := selectRelevantItems(items, question, maxRelevantItems)

	var b strings.Builder
	b.WriteString(fmt.Sprintf("%s feed %q (%d items total, %d shown):\n", sourceName(ref, a.name), feedTitle, len(items), len(selected)))
	for _, item := range selected {
		b.WriteString(fmt.Sprintf("- [%s] %s", strings.TrimSpace(item.PubDate), strings.TrimSpace(item.Title)))
		if description := strings.TrimSpace(stripHTMLTags(item.Description)); description != "" {
			b.WriteString(" — " + description)
		}
		if link := strings.TrimSpace(item.Link); link != "" {
			b.WriteString(" (" + link + ")")
		}
		b.WriteString("\n")
	}

	return Evidence{
		SourceID:  ref.ID,
		Name:      sourceName(ref, a.name),
		URL:       endpoint,
		Content:   truncateEvidence(b.String()),
		FetchedAt: time.Now().UTC(),
	}, nil
}

func parseFeedItems(body []byte) ([]rssItem, string, error) {
	var rss rssFeed
	if err := xml.Unmarshal(body, &rss); err == nil && len(rss.Channel.Items) > 0 {
		return rss.Channel.Items, rss.Channel.Title, nil
	}

	var atom atomFeed
	if err := xml.Unmarshal(body, &atom); err != nil {
		return nil, "", err
	}

	items := make([]rssItem, 0, len(atom.Entries))
	for _, entry := range atom.Entries {
		items = append(items, rssItem{
			Title:       entry.Title,
			Description: entry.Summary,
			PubDate:     entry.Updated,
			Link:        entry.Link.Href,
		})
	}
	return items, atom.Title, nil
}

var (
	nonWordPattern = regexp.MustCompile(`[^a-z0-9]+`)
	htmlTagPattern = regexp.MustCompile(`<[^>]*>`)

	stopwords = map[string]bool{
		"the": true, "a": true, "an": true, "and": true, "or": true, "of": true, "in": true,
		"on": true, "at": true, "to": true, "by": true, "did": true, "does": true, "do": true,
		"is": true, "was": true, "were": true, "will": true, "has": true, "have": true,
		"had": true, "be": true, "been": true, "for": true, "with": true, "that": true,
		"this": true, "it": true, "as": true, "before": true, "after": true, "per": true,
	}
)

func stripHTMLTags(input string) string {
	return htmlTagPattern.ReplaceAllString(input, " ")
}

func questionTerms(question string) map[string]bool {
	terms := map[string]bool{}
	for _, token := range nonWordPattern.Split(strings.ToLower(question), -1) {
		if len(token) < 3 || stopwords[token] {
			continue
		}
		terms[token] = true
	}
	return terms
}

// selectRelevantItems scores items by shared non-stopword terms with the question and keeps the
// best matches; when nothing overlaps, the newest items are returned so the adjudicator can
// still confirm absence of coverage.
func selectRelevantItems(items []rssItem, question string, limit int) []rssItem {
	terms := questionTerms(question)

	type scored struct {
		item  rssItem
		score int
		index int
	}

	ranked := make([]scored, 0, len(items))
	for i, item := range items {
		text := strings.ToLower(item.Title + " " + item.Description)
		score := 0
		for term := range terms {
			if strings.Contains(text, term) {
				score++
			}
		}
		ranked = append(ranked, scored{item: item, score: score, index: i})
	}

	// Stable selection sort by (score desc, original order asc); item counts are tiny.
	for i := 0; i < len(ranked); i++ {
		best := i
		for j := i + 1; j < len(ranked); j++ {
			if ranked[j].score > ranked[best].score ||
				(ranked[j].score == ranked[best].score && ranked[j].index < ranked[best].index) {
				best = j
			}
		}
		ranked[i], ranked[best] = ranked[best], ranked[i]
	}

	if limit > len(ranked) {
		limit = len(ranked)
	}

	selected := make([]rssItem, 0, limit)
	for _, entry := range ranked[:limit] {
		selected = append(selected, entry.item)
	}
	return selected
}

// ---------------------------------------------------------------------------
// NWS (weather; api.weather.gov)
// ---------------------------------------------------------------------------

type nwsAdapter struct {
	fetcher fetcher
}

func (a nwsAdapter) ID() string { return "nws" }

func (a nwsAdapter) Fetch(ctx context.Context, ref SourceRef, _ string) (Evidence, error) {
	if ref.URL == "" {
		return Evidence{}, fmt.Errorf(
			"%w: nws source requires a bound api.weather.gov endpoint (e.g. https://api.weather.gov/stations/KSFO/observations/latest)",
			ErrSourceMisconfigured,
		)
	}
	if err := requireHost(a.ID(), ref.URL, nwsHost); err != nil {
		return Evidence{}, err
	}

	// api.weather.gov rejects requests without a User-Agent.
	body, err := a.fetcher.get(ctx, ref.URL, map[string]string{"Accept": "application/geo+json, application/json"})
	if err != nil {
		return Evidence{}, err
	}

	content := summarizeNWSPayload(body)
	return Evidence{
		SourceID:  ref.ID,
		Name:      sourceName(ref, "National Weather Service"),
		URL:       ref.URL,
		Content:   truncateEvidence(content),
		FetchedAt: time.Now().UTC(),
	}, nil
}

func summarizeNWSPayload(body []byte) string {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return string(body)
	}

	properties, ok := payload["properties"].(map[string]any)
	if !ok {
		return string(body)
	}

	var b strings.Builder
	b.WriteString("NWS observation/forecast properties:\n")
	writeFlattenedJSON(&b, "", properties, 0)
	return b.String()
}

func writeFlattenedJSON(b *strings.Builder, prefix string, value any, depth int) {
	if depth > 4 {
		return
	}

	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if strings.HasPrefix(key, "@") {
				continue
			}
			childPrefix := key
			if prefix != "" {
				childPrefix = prefix + "." + key
			}
			writeFlattenedJSON(b, childPrefix, child, depth+1)
		}
	case []any:
		limit := len(typed)
		if limit > 16 {
			limit = 16
		}
		for i := 0; i < limit; i++ {
			writeFlattenedJSON(b, fmt.Sprintf("%s[%d]", prefix, i), typed[i], depth+1)
		}
	case nil:
		// Skip null readings.
	default:
		b.WriteString(fmt.Sprintf("- %s: %v\n", prefix, typed))
	}
}

// ---------------------------------------------------------------------------
// Coinbase spot (price)
// ---------------------------------------------------------------------------

type coinbaseAdapter struct {
	fetcher fetcher
}

type coinbaseSpotResponse struct {
	Data struct {
		Base     string `json:"base"`
		Currency string `json:"currency"`
		Amount   string `json:"amount"`
	} `json:"data"`
}

func (a coinbaseAdapter) ID() string { return "coinbase" }

func (a coinbaseAdapter) Fetch(ctx context.Context, ref SourceRef, question string) (Evidence, error) {
	endpoint := ref.URL
	if endpoint == "" {
		pair := derivePricePair(question)
		if pair == "" {
			return Evidence{}, fmt.Errorf(
				"%w: coinbase source requires a bound spot URL (e.g. https://api.coinbase.com/v2/prices/BTC-USD/spot) or a recognizable asset pair in the question",
				ErrSourceMisconfigured,
			)
		}
		endpoint = fmt.Sprintf(defaultCoinbaseNS, pair)
	}
	if err := requireHost(a.ID(), endpoint, coinbaseHost); err != nil {
		return Evidence{}, err
	}

	body, err := a.fetcher.get(ctx, endpoint, map[string]string{"Accept": "application/json"})
	if err != nil {
		return Evidence{}, err
	}

	var spot coinbaseSpotResponse
	if err := json.Unmarshal(body, &spot); err != nil || spot.Data.Amount == "" {
		return Evidence{}, fmt.Errorf("%w: unexpected coinbase payload from %s", ErrSourceUnavailable, endpoint)
	}

	content := fmt.Sprintf(
		"Coinbase spot price: %s-%s = %s (endpoint %s)",
		spot.Data.Base, spot.Data.Currency, spot.Data.Amount, endpoint,
	)

	return Evidence{
		SourceID:  ref.ID,
		Name:      sourceName(ref, "Coinbase"),
		URL:       endpoint,
		Content:   content,
		FetchedAt: time.Now().UTC(),
	}, nil
}

var pricePairPattern = regexp.MustCompile(`\b([A-Z]{2,6})[-/]([A-Z]{3,6})\b`)

func derivePricePair(question string) string {
	match := pricePairPattern.FindStringSubmatch(strings.ToUpper(question))
	if len(match) != 3 {
		return ""
	}
	return match[1] + "-" + match[2]
}

func sourceName(ref SourceRef, fallback string) string {
	if strings.TrimSpace(ref.Name) != "" {
		return ref.Name
	}
	return fallback
}
