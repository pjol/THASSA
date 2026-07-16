package sources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newMCPTestServer(t *testing.T, handler func(name string, arguments map[string]any) (string, bool)) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			JSONRPC string `json:"jsonrpc"`
			ID      any    `json:"id"`
			Method  string `json:"method"`
			Params  struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode rpc request: %v", err)
		}
		if request.JSONRPC != "2.0" || request.Method != "tools/call" {
			t.Fatalf("unexpected rpc envelope: %+v", request)
		}

		text, isError := handler(request.Params.Name, request.Params.Arguments)
		response := map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result": map[string]any{
				"content": []map[string]any{{"type": "text", "text": text}},
				"isError": isError,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
}

func TestMCPClient_ListSourcesRefreshesRegistry(t *testing.T) {
	server := newMCPTestServer(t, func(name string, arguments map[string]any) (string, bool) {
		if name != "list_sources" {
			t.Fatalf("unexpected tool %q", name)
		}
		return `{"categories": {"sports": {"rule": "single", "sources": [{"id": "espn", "name": "ESPN", "url": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"}]}}}`, false
	})
	defer server.Close()

	client := NewMCPClient(server.URL, 2*time.Second)
	categories, err := client.ListSources(context.Background(), "")
	if err != nil {
		t.Fatalf("list sources: %v", err)
	}

	registry := NewRegistry(time.Second)
	registry.ApplyCategories(categories)

	sports, ok := registry.Category(CategorySports)
	if !ok || len(sports.Sources) != 1 || !strings.Contains(sports.Sources[0].URL, "nba") {
		t.Fatalf("registry refresh not applied: %+v", sports)
	}
}

func TestMCPClient_ListSourcesAcceptsBareMap(t *testing.T) {
	server := newMCPTestServer(t, func(string, map[string]any) (string, bool) {
		return `{"news": {"rule": "majority", "sources": [{"id": "nyt"}, {"id": "bbc"}, {"id": "ap"}]}}`, false
	})
	defer server.Close()

	categories, err := NewMCPClient(server.URL, 2*time.Second).ListSources(context.Background(), "news")
	if err != nil {
		t.Fatalf("list sources: %v", err)
	}
	if len(categories["news"].Sources) != 3 {
		t.Fatalf("unexpected categories: %+v", categories)
	}
}

func TestMCPClient_ResolveSources(t *testing.T) {
	server := newMCPTestServer(t, func(name string, arguments map[string]any) (string, bool) {
		if name != "resolve_sources" {
			t.Fatalf("unexpected tool %q", name)
		}
		if question, _ := arguments["question"].(string); !strings.Contains(question, "49ers") {
			t.Fatalf("question not forwarded: %+v", arguments)
		}
		return `{"category": "sports", "rule": "single", "sources": [{"id": "espn", "name": "ESPN"}]}`, false
	})
	defer server.Close()

	binding, err := NewMCPClient(server.URL, 2*time.Second).ResolveSources(context.Background(), "Did the 49ers win?")
	if err != nil {
		t.Fatalf("resolve sources: %v", err)
	}
	if binding.Category != "sports" || binding.Rule != RuleSingle || len(binding.Sources) != 1 {
		t.Fatalf("unexpected binding: %+v", binding)
	}
}

func TestMCPClient_ToolErrorSurfaces(t *testing.T) {
	server := newMCPTestServer(t, func(string, map[string]any) (string, bool) {
		return "registry unavailable", true
	})
	defer server.Close()

	if _, err := NewMCPClient(server.URL, 2*time.Second).ListSources(context.Background(), ""); err == nil {
		t.Fatalf("tool errors must surface so callers can degrade to the built-in registry")
	}
}

func TestMCPClient_UnreachableEndpointErrors(t *testing.T) {
	client := NewMCPClient("http://127.0.0.1:1", 500*time.Millisecond)
	if _, err := client.ListSources(context.Background(), ""); err == nil {
		t.Fatalf("unreachable endpoint must error (graceful degradation happens in the caller)")
	}
}
