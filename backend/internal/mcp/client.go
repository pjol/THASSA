package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
)

// Client is a minimal MCP JSON-RPC 2.0 HTTP client. The generation agent uses
// it with an in-process transport against the local server (so the LLM's tool
// calls are bridged over the real MCP protocol); remote consumers point it at
// the backend URL with the node bearer token.
type Client struct {
	url    string
	token  string
	http   *http.Client
	nextID int64
}

// NewClient builds a network client.
func NewClient(url, token string) *Client {
	return &Client{url: url, token: token, http: &http.Client{}}
}

// NewInProcessClient builds a client whose transport invokes the handler
// directly (no sockets) while still exercising the full HTTP+JSON-RPC path.
func NewInProcessClient(s *Server, token string) *Client {
	return &Client{
		url:   "http://mcp.internal/rpc",
		token: token,
		http:  &http.Client{Transport: handlerTransport{h: s}},
	}
}

type handlerTransport struct{ h http.Handler }

func (t handlerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	t.h.ServeHTTP(rec, r)
	return rec.Result(), nil
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mcp: http %d", res.StatusCode)
	}
	var rpc struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rpc); err != nil {
		return nil, err
	}
	if rpc.Error != nil {
		return nil, fmt.Errorf("mcp: %s", rpc.Error.Message)
	}
	return rpc.Result, nil
}

// ListTools fetches the tool descriptors.
func (c *Client) ListTools(ctx context.Context) ([]ToolDef, error) {
	raw, err := c.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []ToolDef `json:"tools"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out.Tools, nil
}

// CallTool invokes a tool and returns the concatenated text content (MCP
// tools/call result convention).
func (c *Client) CallTool(ctx context.Context, name string, args any) (string, error) {
	raw, err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return "", err
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	text := ""
	for _, cpart := range out.Content {
		if cpart.Type == "text" {
			text += cpart.Text
		}
	}
	return text, nil
}

// ResolveSources is a typed helper over the resolve_sources tool.
func (c *Client) ResolveSources(ctx context.Context, question string) (category, rule string, sourcesJSON json.RawMessage, err error) {
	text, err := c.CallTool(ctx, ToolResolveSources, map[string]any{"question": question})
	if err != nil {
		return "", "", nil, err
	}
	var out struct {
		Category string          `json:"category"`
		Rule     string          `json:"rule"`
		Sources  json.RawMessage `json:"sources"`
	}
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return "", "", nil, err
	}
	return out.Category, out.Rule, out.Sources, nil
}
