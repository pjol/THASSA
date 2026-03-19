package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	openaigo "github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/responses"
	"github.com/openai/openai-go/shared"
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
	instructions := buildInstructions()

	inputDataJSON, err := json.Marshal(inputData)
	if err != nil {
		return nil, "", fmt.Errorf("marshal inputData: %w", err)
	}
	schemaJSON, err := json.Marshal(schema)
	if err != nil {
		return nil, "", fmt.Errorf("marshal schema: %w", err)
	}

	contextChars := len(instructions) + len(query) + len(inputDataJSON) + len(schemaJSON)
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

	log.Printf(
		"[OPENAI] model=%s contextChars=%d maxContextChars=%d queryChars=%d inputDataChars=%d schemaChars=%d webSearchRequested=true webSearchRequired=true reasoningEffort=medium",
		model,
		contextChars,
		c.maxContextChars,
		len(query),
		len(inputDataJSON),
		len(schemaJSON),
	)

	userPrompt := strings.TrimSpace(fmt.Sprintf(
		`Query:
%s

Execution-status rule:
- Always include "_fulfilled" in the JSON response.
- Set "_fulfilled" to true only when the request was actually executed successfully and the remaining fields come from the real result.
- Set "_fulfilled" to false if execution failed, live data could not be obtained, or you had to use default/placeholder/fabricated/empty fallback values.
- Legitimate zero values are allowed when they are the actual observed value or the correct schema encoding of the observed result.
- If "_fulfilled" is false, still return a syntactically valid JSON object for the full schema.

Input data (JSON):
%s

Return only a JSON object that strictly matches the provided schema.`,
		query,
		string(inputDataJSON),
	))

	searchTool := responses.WebSearchToolParam{
		Type:              responses.WebSearchToolTypeWebSearchPreview2025_03_11,
		SearchContextSize: responses.WebSearchToolSearchContextSizeHigh,
	}

	request := responses.ResponseNewParams{
		Model:        model,
		Store:        param.NewOpt(false),
		Instructions: param.NewOpt(instructions),
		Input: responses.ResponseNewParamsInputUnion{
			OfInputItemList: responses.ResponseInputParam{
				responses.ResponseInputItemParamOfMessage(userPrompt, responses.EasyInputMessageRoleUser),
			},
		},
		Reasoning: shared.ReasoningParam{
			Effort: shared.ReasoningEffortMedium,
		},
		MaxToolCalls:      param.NewOpt(int64(8)),
		ParallelToolCalls: param.NewOpt(false),
		Text: responses.ResponseTextConfigParam{
			Format: responses.ResponseFormatTextConfigUnionParam{
				OfJSONSchema: &responses.ResponseFormatTextJSONSchemaConfigParam{
					Name:   "thassa_output",
					Schema: schema,
					Strict: param.NewOpt(true),
				},
			},
		},
		Tools: []responses.ToolUnionParam{
			{
				OfWebSearchPreview: &searchTool,
			},
		},
		ToolChoice: responses.ResponseNewParamsToolChoiceUnion{
			OfToolChoiceMode: param.NewOpt(responses.ToolChoiceOptionsRequired),
		},
	}

	requestOptions := []option.RequestOption{
		// The live API accepts the newer GA `web_search` tool type even though this SDK
		// still models preview variants. Use JSON override so the demo path tracks the
		// current tool behavior more closely.
		option.WithJSONSet("tools.0.type", "web_search"),
	}

	response, err := c.client.Responses.New(ctx, request, requestOptions...)
	if err != nil {
		var apiErr *openaigo.Error
		if errors.As(err, &apiErr) && isUnsupportedWebSearchTypeError(apiErr) {
			log.Printf(
				"[OPENAI] model=%s backend rejected GA web_search tool type; retrying with preview tool type %q",
				model,
				searchTool.Type,
			)
			response, err = c.client.Responses.New(ctx, request)
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

	if response == nil {
		return nil, "", fmt.Errorf("openai returned nil response")
	}

	if response.Error.Message != "" {
		return nil, "", fmt.Errorf("openai response error: %s", response.Error.Message)
	}

	if response.Status == responses.ResponseStatusIncomplete {
		reason := strings.TrimSpace(response.IncompleteDetails.Reason)
		if reason == "" {
			reason = "unknown"
		}
		return nil, "", fmt.Errorf("openai response incomplete: %s", reason)
	}

	log.Printf("[OPENAI] model=%s responseStatus=%s tools=%s", model, response.Status, summarizeResponseItems(response))

	raw := strings.TrimSpace(stripCodeFence(response.OutputText()))
	if raw == "" {
		refusal := strings.TrimSpace(extractResponseRefusal(response))
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

func buildInstructions() string {
	return "You are an oracle data shaping engine. Use web search for live-data requests and return strict JSON only. " +
		"Every response must include a boolean field named `_fulfilled`. Set `_fulfilled` to true only if you successfully executed " +
		"the request using real source data and populated the remaining fields from that result. Set `_fulfilled` to false if you " +
		"could not execute the request, could not obtain the requested live data, or had to rely on default, placeholder, fabricated, or empty fallback values. " +
		"Legitimate zero values are allowed when they are the actual observed value or the correct schema encoding of the observed result; zero by itself does not imply fallback. " +
		"Do not stop at a generic search summary if it lacks required fields; continue searching and open source pages when needed. " +
		"Do not invent missing fields. If any required numeric field would be guessed, inferred, or defaulted, `_fulfilled` must be false."
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

func extractResponseRefusal(response *responses.Response) string {
	if response == nil {
		return ""
	}

	for _, item := range response.Output {
		for _, content := range item.Content {
			if content.Type == "refusal" {
				return content.Refusal
			}
		}
	}

	return ""
}

func isUnsupportedWebSearchTypeError(apiErr *openaigo.Error) bool {
	if apiErr == nil {
		return false
	}

	raw := strings.ToLower(strings.TrimSpace(apiErr.RawJSON()))
	if raw == "" {
		raw = strings.ToLower(strings.TrimSpace(apiErr.Message))
	}

	if !strings.Contains(raw, "web_search") {
		return false
	}

	return strings.Contains(raw, "invalid value") ||
		strings.Contains(raw, "unsupported") ||
		strings.Contains(raw, "unknown") ||
		strings.Contains(raw, "invalid enum")
}

func summarizeResponseItems(response *responses.Response) string {
	if response == nil || len(response.Output) == 0 {
		return "none"
	}

	parts := make([]string, 0, len(response.Output))
	for _, item := range response.Output {
		summary := item.Type
		if item.Status != "" {
			summary += ":" + item.Status
		}
		if item.Type == "web_search_call" {
			actionType := strings.TrimSpace(string(item.Action.Type))
			if actionType != "" {
				summary += ":" + actionType
			}
			query := strings.TrimSpace(item.Action.Query)
			if query != "" {
				summary += ":" + query
			}
			url := strings.TrimSpace(item.Action.URL)
			if url != "" {
				summary += ":" + url
			}
		}
		parts = append(parts, summary)
	}

	return strings.Join(parts, " | ")
}
