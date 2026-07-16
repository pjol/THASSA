package sources

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// MCPClient talks JSON-RPC 2.0 to the backend MCP HTTP endpoint (NODE_MCP_URL) and exposes the
// two registry tools the backend serves: list_sources and resolve_sources. Callers are expected
// to degrade gracefully (keep the built-in registry) when calls fail.
type MCPClient struct {
	endpoint   string
	httpClient *http.Client
	nextID     atomic.Int64
}

// ResolvedBinding is the resolve_sources result: a suggested category, rule, and bound sources
// for a free-text question.
type ResolvedBinding struct {
	Category string      `json:"category"`
	Rule     string      `json:"rule"`
	Sources  []SourceRef `json:"sources"`
}

type jsonRPCRequest struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      int64          `json:"id"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
}

type jsonRPCResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  *struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type listSourcesPayload struct {
	Categories map[string]CategoryRule `json:"categories"`
}

func NewMCPClient(endpoint string, timeout time.Duration) *MCPClient {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &MCPClient{
		endpoint:   strings.TrimSpace(endpoint),
		httpClient: &http.Client{Timeout: timeout},
	}
}

// ListSources fetches the source registry; category may be empty to fetch every category.
func (c *MCPClient) ListSources(ctx context.Context, category string) (map[string]CategoryRule, error) {
	arguments := map[string]any{}
	if strings.TrimSpace(category) != "" {
		arguments["category"] = strings.TrimSpace(category)
	}

	text, err := c.callTool(ctx, "list_sources", arguments)
	if err != nil {
		return nil, err
	}

	var payload listSourcesPayload
	if err := json.Unmarshal([]byte(text), &payload); err == nil && len(payload.Categories) > 0 {
		return payload.Categories, nil
	}

	// Also accept the bare {"news": {...}} map form.
	var bare map[string]CategoryRule
	if err := json.Unmarshal([]byte(text), &bare); err != nil {
		return nil, fmt.Errorf("decode list_sources payload: %w", err)
	}
	return bare, nil
}

// ResolveSources asks the backend to categorize a question and bind sources to it.
func (c *MCPClient) ResolveSources(ctx context.Context, question string) (ResolvedBinding, error) {
	text, err := c.callTool(ctx, "resolve_sources", map[string]any{"question": question})
	if err != nil {
		return ResolvedBinding{}, err
	}

	var binding ResolvedBinding
	if err := json.Unmarshal([]byte(text), &binding); err != nil {
		return ResolvedBinding{}, fmt.Errorf("decode resolve_sources payload: %w", err)
	}
	if strings.TrimSpace(binding.Category) == "" {
		return ResolvedBinding{}, fmt.Errorf("resolve_sources returned no category")
	}
	return binding, nil
}

// callTool performs a JSON-RPC 2.0 tools/call and returns the first text content block.
func (c *MCPClient) callTool(ctx context.Context, name string, arguments map[string]any) (string, error) {
	if c.endpoint == "" {
		return "", fmt.Errorf("mcp endpoint is not configured")
	}

	requestBody, err := json.Marshal(jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      c.nextID.Add(1),
		Method:  "tools/call",
		Params: map[string]any{
			"name":      name,
			"arguments": arguments,
		},
	})
	if err != nil {
		return "", fmt.Errorf("marshal %s request: %w", name, err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(requestBody))
	if err != nil {
		return "", fmt.Errorf("build %s request: %w", name, err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("mcp %s: %w", name, err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("mcp %s: HTTP %d", name, response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return "", fmt.Errorf("mcp %s: read response: %w", name, err)
	}

	var rpcResponse jsonRPCResponse
	if err := json.Unmarshal(body, &rpcResponse); err != nil {
		return "", fmt.Errorf("mcp %s: decode response: %w", name, err)
	}
	if rpcResponse.Error != nil {
		return "", fmt.Errorf("mcp %s: rpc error %d: %s", name, rpcResponse.Error.Code, rpcResponse.Error.Message)
	}
	if rpcResponse.Result == nil {
		return "", fmt.Errorf("mcp %s: missing result", name)
	}
	if rpcResponse.Result.IsError {
		return "", fmt.Errorf("mcp %s: tool reported an error: %s", name, firstText(rpcResponse))
	}

	text := firstText(rpcResponse)
	if text == "" {
		return "", fmt.Errorf("mcp %s: result carries no text content", name)
	}
	return text, nil
}

func firstText(response jsonRPCResponse) string {
	if response.Result == nil {
		return ""
	}
	for _, content := range response.Result.Content {
		if content.Type == "text" && strings.TrimSpace(content.Text) != "" {
			return content.Text
		}
	}
	return ""
}
