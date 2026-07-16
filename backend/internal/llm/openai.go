// Package llm is a minimal OpenAI chat-completions client with structured
// outputs (json_schema) and tool calling — enough for the market-generation
// agent without pulling a heavyweight SDK.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Client talks to the OpenAI-compatible chat completions API.
type Client struct {
	apiKey  string
	baseURL string
	Model   string
	http    *http.Client
}

// New builds a client. model defaults from env (spec: gpt-5.4).
func New(apiKey, model string) *Client {
	return &Client{
		apiKey:  apiKey,
		baseURL: "https://api.openai.com/v1",
		Model:   model,
		http:    &http.Client{Timeout: 120 * time.Second},
	}
}

// Configured reports whether an API key is present.
func (c *Client) Configured() bool { return c.apiKey != "" }

// Message is one chat turn.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// ToolCall is an assistant-requested function invocation.
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// Tool is a function tool definition.
type Tool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

// NewTool builds a function tool.
func NewTool(name, description string, parameters map[string]any) Tool {
	var t Tool
	t.Type = "function"
	t.Function.Name = name
	t.Function.Description = description
	t.Function.Parameters = parameters
	return t
}

// ResponseFormat requests strict structured output.
type ResponseFormat struct {
	Type       string `json:"type"`
	JSONSchema struct {
		Name   string         `json:"name"`
		Strict bool           `json:"strict"`
		Schema map[string]any `json:"schema"`
	} `json:"json_schema"`
}

// NewJSONSchemaFormat builds a strict json_schema response format.
func NewJSONSchemaFormat(name string, schema map[string]any) *ResponseFormat {
	var rf ResponseFormat
	rf.Type = "json_schema"
	rf.JSONSchema.Name = name
	rf.JSONSchema.Strict = true
	rf.JSONSchema.Schema = schema
	return &rf
}

type chatRequest struct {
	Model          string          `json:"model"`
	Messages       []Message       `json:"messages"`
	Tools          []Tool          `json:"tools,omitempty"`
	ResponseFormat *ResponseFormat `json:"response_format,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Chat runs one completion round and returns the assistant message.
func (c *Client) Chat(ctx context.Context, messages []Message, tools []Tool, format *ResponseFormat) (*Message, error) {
	if !c.Configured() {
		return nil, fmt.Errorf("llm: OPENAI_API_KEY not configured")
	}
	body, err := json.Marshal(chatRequest{
		Model:          c.Model,
		Messages:       messages,
		Tools:          tools,
		ResponseFormat: format,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("llm: %w", err)
	}
	defer res.Body.Close()
	var out chatResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("llm: decode: %w", err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("llm: api: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return nil, fmt.Errorf("llm: empty response")
	}
	return &out.Choices[0].Message, nil
}
