package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	openaigo "github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	openaishared "github.com/openai/openai-go/shared"
)

type Client struct {
	client          *openaigo.Client
	maxContextChars int
}

func NewClient(apiKey string, baseURL string, timeout time.Duration, maxContextChars int) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if maxContextChars <= 0 {
		maxContextChars = 16000
	}

	opts := []option.RequestOption{
		option.WithAPIKey(apiKey),
		option.WithHTTPClient(&http.Client{Timeout: timeout}),
	}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}

	sdkClient := openaigo.NewClient(opts...)

	return &Client{
		client:          &sdkClient,
		maxContextChars: maxContextChars,
	}
}

func (c *Client) GenerateStructuredOutput(
	ctx context.Context,
	model string,
	query string,
	inputData map[string]any,
	schema map[string]any,
) (map[string]any, string, error) {
	systemPrompt := "You are an oracle data shaping engine. Search the web for answers when needed and return strict JSON only."

	inputDataJSON, err := json.Marshal(inputData)
	if err != nil {
		return nil, "", fmt.Errorf("marshal inputData: %w", err)
	}
	schemaJSON, err := json.Marshal(schema)
	if err != nil {
		return nil, "", fmt.Errorf("marshal schema: %w", err)
	}

	contextChars := len(systemPrompt) + len(query) + len(inputDataJSON) + len(schemaJSON)
	if contextChars > c.maxContextChars {
		return nil, "", fmt.Errorf(
			"request context too large: %d chars exceeds OPENAI_MAX_CONTEXT_CHARS=%d (query=%d inputData=%d schema=%d)",
			contextChars,
			c.maxContextChars,
			len(query),
			len(inputDataJSON),
			len(schemaJSON),
		)
	}

	userPrompt := strings.TrimSpace(fmt.Sprintf(
		`Query:
%s

Input data (JSON):
%s

Return only a JSON object that strictly matches the provided schema.`,
		query,
		string(inputDataJSON),
	))

	schemaParam := openaishared.ResponseFormatJSONSchemaJSONSchemaParam{
		Name:   "thassa_output",
		Strict: openaigo.Bool(true),
		Schema: schema,
	}

	request := openaigo.ChatCompletionNewParams{
		Model: model,
		Messages: []openaigo.ChatCompletionMessageParamUnion{
			openaigo.SystemMessage(systemPrompt),
			openaigo.UserMessage(userPrompt),
		},
		ResponseFormat: openaigo.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONSchema: &openaishared.ResponseFormatJSONSchemaParam{
				JSONSchema: schemaParam,
			},
		},
		WebSearchOptions: openaigo.ChatCompletionNewParamsWebSearchOptions{
			SearchContextSize: "medium",
		},
	}

	completion, err := c.client.Chat.Completions.New(ctx, request)
	if err != nil {
		var apiErr *openaigo.Error
		if errors.As(err, &apiErr) && isUnknownWebSearchOptionsError(apiErr) {
			// Fallback for backends that do not yet accept `web_search_options`.
			request.WebSearchOptions = openaigo.ChatCompletionNewParamsWebSearchOptions{}
			completion, err = c.client.Chat.Completions.New(ctx, request)
		}
	}

	if err != nil {
		var apiErr *openaigo.Error
		if errors.As(err, &apiErr) {
			detail := strings.TrimSpace(apiErr.RawJSON())
			if detail == "" {
				detail = strings.TrimSpace(apiErr.Message)
			}
			if detail != "" {
				return nil, "", fmt.Errorf("openai error (%d): %s", apiErr.StatusCode, detail)
			}
			return nil, "", fmt.Errorf("openai error (%d)", apiErr.StatusCode)
		}

		return nil, "", fmt.Errorf("call openai: %w", err)
	}

	if len(completion.Choices) == 0 {
		return nil, "", fmt.Errorf("openai returned no choices")
	}

	raw := strings.TrimSpace(stripCodeFence(completion.Choices[0].Message.Content))
	if raw == "" {
		refusal := strings.TrimSpace(completion.Choices[0].Message.Refusal)
		if refusal != "" {
			return nil, "", fmt.Errorf("openai refusal: %s", refusal)
		}
		return nil, "", fmt.Errorf("openai returned empty content")
	}

	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()

	var shaped map[string]any
	if err := decoder.Decode(&shaped); err != nil {
		return nil, "", fmt.Errorf("decode structured output: %w", err)
	}

	return shaped, raw, nil
}

func isUnknownWebSearchOptionsError(apiErr *openaigo.Error) bool {
	if apiErr == nil {
		return false
	}

	if apiErr.Param == "web_search_options" && apiErr.Code == "unknown_parameter" {
		return true
	}

	raw := strings.ToLower(apiErr.RawJSON())
	return strings.Contains(raw, "unknown parameter") && strings.Contains(raw, "web_search_options")
}

func stripCodeFence(raw string) string {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "```") {
		return raw
	}

	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	return strings.TrimSpace(raw)
}
