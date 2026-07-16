package fulfillment

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/pjol/THASSA/node/internal/sources"
)

// fakeAdapter serves canned evidence (or an error) for one source id.
type fakeAdapter struct {
	id       string
	evidence string
	err      error
}

func (a fakeAdapter) ID() string { return a.id }

func (a fakeAdapter) Fetch(_ context.Context, ref sources.SourceRef, _ string) (sources.Evidence, error) {
	if a.err != nil {
		return sources.Evidence{}, a.err
	}
	return sources.Evidence{
		SourceID:  ref.ID,
		Name:      ref.Name,
		URL:       "https://example.test/" + a.id,
		Content:   a.evidence,
		FetchedAt: time.Now().UTC(),
	}, nil
}

// fakeLLM returns per-source verdicts keyed on the sourceId in inputData.
type fakeLLM struct {
	verdicts map[string]map[string]any
	calls    []string
}

func (f *fakeLLM) GenerateStructuredOutputNoSearch(
	_ context.Context,
	_ string,
	_ string,
	inputData map[string]any,
	_ map[string]any,
) (map[string]any, string, error) {
	sourceID, _ := inputData["sourceId"].(string)
	f.calls = append(f.calls, sourceID)

	verdict, ok := f.verdicts[sourceID]
	if !ok {
		return nil, "", fmt.Errorf("no canned verdict for %q", sourceID)
	}
	return verdict, "{}", nil
}

func verdictJSON(fulfilled bool, settled bool, direction bool) map[string]any {
	return map[string]any{"_fulfilled": fulfilled, "settled": settled, "direction": direction}
}

func newTestRegistry(adapters ...fakeAdapter) *sources.Registry {
	registry := sources.NewRegistry(time.Second)
	for _, adapter := range adapters {
		registry.Register(adapter)
	}
	return registry
}

func TestAdjudicateSources_MajoritySettles(t *testing.T) {
	registry := newTestRegistry(
		fakeAdapter{id: "s1", evidence: "outcome happened"},
		fakeAdapter{id: "s2", evidence: "outcome happened"},
		fakeAdapter{id: "s3", evidence: "no coverage"},
	)
	llm := &fakeLLM{verdicts: map[string]map[string]any{
		"s1": verdictJSON(true, true, true),
		"s2": verdictJSON(true, true, true),
		"s3": verdictJSON(false, false, false),
	}}

	query := sources.StructuredQuery{
		Question: "Did the outcome happen?",
		Category: "news",
		Rule:     sources.RuleMajority,
		Sources:  []sources.SourceRef{{ID: "s1"}, {ID: "s2"}, {ID: "s3"}},
	}

	outcome, verdicts, err := AdjudicateSources(context.Background(), registry, llm, "test-model", query, nil)
	if err != nil {
		t.Fatalf("adjudicate: %v", err)
	}
	if !outcome.Settled || !outcome.Direction {
		t.Fatalf("expected settled YES, got %+v", outcome)
	}
	if len(verdicts) != 3 || len(llm.calls) != 3 {
		t.Fatalf("every source must be adjudicated independently: verdicts=%d calls=%v", len(verdicts), llm.calls)
	}
}

func TestAdjudicateSources_FetchFailureCountsAgainstMajority(t *testing.T) {
	registry := newTestRegistry(
		fakeAdapter{id: "s1", evidence: "outcome happened"},
		fakeAdapter{id: "s2", err: fmt.Errorf("%w: feed down", sources.ErrSourceUnavailable)},
		fakeAdapter{id: "s3", err: fmt.Errorf("%w: feed down", sources.ErrSourceUnavailable)},
	)
	llm := &fakeLLM{verdicts: map[string]map[string]any{
		"s1": verdictJSON(true, true, true),
	}}

	query := sources.StructuredQuery{
		Question: "Did the outcome happen?",
		Rule:     sources.RuleMajority,
		Sources:  []sources.SourceRef{{ID: "s1"}, {ID: "s2"}, {ID: "s3"}},
	}

	outcome, _, err := AdjudicateSources(context.Background(), registry, llm, "test-model", query, nil)
	if err != nil {
		t.Fatalf("adjudicate: %v", err)
	}
	if outcome.Settled {
		t.Fatalf("1/3 with two failed sources must not settle: %+v", outcome)
	}
	// Only the reachable source hits the LLM.
	if len(llm.calls) != 1 || llm.calls[0] != "s1" {
		t.Fatalf("failed fetches must never reach the LLM: %v", llm.calls)
	}
}

func TestAdjudicateSources_SingleSourceDecides(t *testing.T) {
	registry := newTestRegistry(fakeAdapter{id: "s1", evidence: "final score shows loss"})
	llm := &fakeLLM{verdicts: map[string]map[string]any{
		"s1": verdictJSON(true, true, false),
	}}

	query := sources.StructuredQuery{
		Question: "Did the team win?",
		Rule:     sources.RuleSingle,
		Sources:  []sources.SourceRef{{ID: "s1"}}, // single bound source
	}

	outcome, _, err := AdjudicateSources(context.Background(), registry, llm, "test-model", query, nil)
	if err != nil {
		t.Fatalf("adjudicate: %v", err)
	}
	if !outcome.Settled || outcome.Direction {
		t.Fatalf("expected settled NO, got %+v", outcome)
	}
}

func TestAdjudicateSources_UnfulfilledVerdictIsUnsettled(t *testing.T) {
	registry := newTestRegistry(fakeAdapter{id: "s1", evidence: "event has not occurred yet"})
	llm := &fakeLLM{verdicts: map[string]map[string]any{
		// The model claims settled but marks _fulfilled=false: never trusted.
		"s1": verdictJSON(false, true, true),
	}}

	query := sources.StructuredQuery{
		Question: "Did the future event happen?",
		Rule:     sources.RuleSingle,
		Sources:  []sources.SourceRef{{ID: "s1"}},
	}

	outcome, _, err := AdjudicateSources(context.Background(), registry, llm, "test-model", query, nil)
	if err != nil {
		t.Fatalf("adjudicate: %v", err)
	}
	if outcome.Settled {
		t.Fatalf("_fulfilled=false must never settle: %+v", outcome)
	}
}

func TestAdjudicateSources_RequiresBoundSources(t *testing.T) {
	registry := newTestRegistry()
	llm := &fakeLLM{}

	_, _, err := AdjudicateSources(
		context.Background(), registry, llm, "test-model",
		sources.StructuredQuery{Question: "q", Rule: sources.RuleSingle}, nil,
	)
	if err == nil {
		t.Fatalf("queries without bound sources must be rejected")
	}
}
