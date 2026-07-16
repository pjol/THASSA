// Package mcp implements a minimal MCP (Model Context Protocol) server —
// JSON-RPC 2.0 over HTTP supporting initialize, tools/list and tools/call —
// plus a client used by the market-generation agent (in-process) and by
// remote oracle nodes (over the network, bearer-token authenticated).
package mcp

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/pjol/THASSA/backend/internal/sources"
	"github.com/pjol/THASSA/backend/internal/store"
)

// Tool names exposed by the server.
const (
	ToolSearchMarkets  = "search_markets"
	ToolListSources    = "list_sources"
	ToolResolveSources = "resolve_sources"
)

// Server hosts the tools over JSON-RPC 2.0.
type Server struct {
	db       *store.Store
	registry *sources.Registry
	// nodeToken authorizes remote oracle nodes (Authorization: Bearer …).
	// Empty disables remote access; the in-process client bypasses HTTP auth
	// via the loopback transport with the same token.
	nodeToken string
}

func NewServer(db *store.Store, registry *sources.Registry, nodeToken string) *Server {
	return &Server{db: db, registry: registry, nodeToken: nodeToken}
}

// --- JSON-RPC plumbing -------------------------------------------------------

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// ServeHTTP handles a single JSON-RPC request per POST.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var req rpcRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: -32700, Message: "parse error"}})
		return
	}
	writeRPC(w, s.dispatch(r.Context(), req))
}

func (s *Server) authorized(r *http.Request) bool {
	if s.nodeToken == "" {
		return false
	}
	return r.Header.Get("Authorization") == "Bearer "+s.nodeToken
}

func writeRPC(w http.ResponseWriter, res rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

func (s *Server) dispatch(ctx context.Context, req rpcRequest) rpcResponse {
	res := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		res.Result = map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "thassa-backend", "version": "1.0.0"},
		}
	case "tools/list":
		res.Result = map[string]any{"tools": s.toolDefs()}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			res.Error = &rpcError{Code: -32602, Message: "invalid params"}
			return res
		}
		out, err := s.callTool(ctx, params.Name, params.Arguments)
		if err != nil {
			res.Error = &rpcError{Code: -32000, Message: err.Error()}
			return res
		}
		b, _ := json.Marshal(out)
		res.Result = map[string]any{
			"content": []map[string]any{{"type": "text", "text": string(b)}},
		}
	default:
		res.Error = &rpcError{Code: -32601, Message: "method not found"}
	}
	return res
}

// ToolDef mirrors the MCP tool descriptor.
type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func (s *Server) toolDefs() []ToolDef {
	return []ToolDef{
		{
			Name:        ToolSearchMarkets,
			Description: "Search existing prediction markets by free-text query. Returns the top matches with status and prices. Use before proposing any new market: never propose a market whose settlement outcome duplicates an existing one.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"query": map[string]any{"type": "string"}},
				"required":   []string{"query"},
			},
		},
		{
			Name:        ToolListSources,
			Description: "List the authoritative resolution-source registry (categories, rules, sources). Optionally filter by category id.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"category": map[string]any{"type": "string"}},
			},
		},
		{
			Name:        ToolResolveSources,
			Description: "Categorize a settlement question and bind its authoritative sources: returns {category, rule, sources[]}. Numeric categories bind exactly one disclosed source; boolean categories bind a majority panel.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"question": map[string]any{"type": "string"}},
				"required":   []string{"question"},
			},
		},
	}
}

func (s *Server) callTool(ctx context.Context, name string, args json.RawMessage) (any, error) {
	switch name {
	case ToolSearchMarkets:
		var a struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal(args, &a); err != nil || a.Query == "" {
			return nil, errInvalidArgs
		}
		markets, err := s.db.SearchMarkets(ctx, a.Query, 10)
		if err != nil {
			return nil, err
		}
		return map[string]any{"markets": markets}, nil
	case ToolListSources:
		var a struct {
			Category string `json:"category"`
		}
		_ = json.Unmarshal(args, &a)
		return map[string]any{"categories": s.registry.List(a.Category)}, nil
	case ToolResolveSources:
		var a struct {
			Question string `json:"question"`
		}
		if err := json.Unmarshal(args, &a); err != nil || a.Question == "" {
			return nil, errInvalidArgs
		}
		resolved := s.registry.Resolve(a.Question)
		return map[string]any{
			"category": resolved.Category,
			"rule":     resolved.Rule,
			"sources":  resolved.Sources,
		}, nil
	default:
		return nil, errUnknownTool
	}
}

var (
	errInvalidArgs = errString("invalid tool arguments")
	errUnknownTool = errString("unknown tool")
)

type errString string

func (e errString) Error() string { return string(e) }
