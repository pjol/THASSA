package fulfillment

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/pjol/THASSA/node/internal/shape"
)

const unfulfilledRetryDelay = 1500 * time.Millisecond

type StructuredOutputClient interface {
	GenerateStructuredOutput(
		ctx context.Context,
		model string,
		query string,
		inputData map[string]any,
		schema map[string]any,
	) (map[string]any, string, error)
}

type Logger func(format string, args ...any)

type Result struct {
	ShapedOutput map[string]any
	RawModelJSON string
	Fulfilled    bool
	Attempts     int
}

func GenerateUntilFulfilled(
	ctx context.Context,
	client StructuredOutputClient,
	model string,
	query string,
	inputData map[string]any,
	schema map[string]any,
	llmShape []shape.FieldSpec,
	logger Logger,
) (Result, error) {
	if ctx == nil {
		return Result{}, fmt.Errorf("context is required")
	}

	baseInput := cloneMap(inputData)
	attempt := 1
	currentQuery := query
	currentInput := cloneMap(baseInput)

	for {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}

		logf(logger, "structured output attempt=%d model=%s", attempt, model)

		shapedOutput, rawModelJSON, err := client.GenerateStructuredOutput(
			ctx,
			model,
			currentQuery,
			currentInput,
			schema,
		)
		if err != nil {
			return Result{}, fmt.Errorf("generate structured output attempt %d: %w", attempt, err)
		}

		if err := shape.ValidateStructuredOutput(llmShape, shapedOutput); err != nil {
			return Result{}, fmt.Errorf("structured output shape validation failed on attempt %d: %w", attempt, err)
		}

		fulfilled, err := shape.ExtractFulfillmentFlag(shapedOutput)
		if err != nil {
			return Result{}, fmt.Errorf("extract _fulfilled on attempt %d: %w", attempt, err)
		}

		result := Result{
			ShapedOutput: shapedOutput,
			RawModelJSON: rawModelJSON,
			Fulfilled:    fulfilled,
			Attempts:     attempt,
		}
		if fulfilled {
			return result, nil
		}

		shapedOutputJSON, marshalErr := json.Marshal(shapedOutput)
		if marshalErr != nil {
			logf(logger, "attempt=%d _fulfilled=false shapedOutput=<marshal-error:%v>", attempt, marshalErr)
		} else {
			logf(logger, "attempt=%d _fulfilled=false shapedOutput=%s", attempt, string(shapedOutputJSON))
		}
		logf(logger, "attempt=%d _fulfilled=false rawModelJson=%s", attempt, rawModelJSON)
		logf(logger, "attempt=%d returned _fulfilled=false; retrying after %s", attempt, unfulfilledRetryDelay)

		currentInput = cloneMap(baseInput)
		currentInput["unfulfilledRetryAttempt"] = attempt
		currentInput["previousStructuredOutput"] = shapedOutput
		currentInput["previousRawModelJson"] = rawModelJSON
		currentInput["fulfillmentRequirement"] =
			"Retry from scratch using live current source data. Set _fulfilled to true only if the request succeeds with real data."
		currentQuery = buildRetryQuery(query, attempt)

		attempt++

		timer := time.NewTimer(unfulfilledRetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return Result{}, fmt.Errorf("structured output remained _fulfilled=false before retry %d: %w", attempt, ctx.Err())
		case <-timer.C:
		}
	}
}

func buildRetryQuery(baseQuery string, previousAttempt int) string {
	return baseQuery + fmt.Sprintf(
		"\n\nRetry instruction after attempt %d returned _fulfilled=false: execute the request again from scratch using live current data. "+
			"Do not rely on placeholders, zero defaults, or stale cached values. Only set _fulfilled=true if you actually found and used real current source data.",
		previousAttempt,
	)
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}

	cloned := make(map[string]any, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}

func logf(logger Logger, format string, args ...any) {
	if logger == nil {
		return
	}
	logger(format, args...)
}
