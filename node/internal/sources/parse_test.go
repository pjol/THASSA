package sources

import "testing"

func TestParseSettlementQuery_StructuredJSON(t *testing.T) {
	raw := `{
		"question": "Did the 49ers beat the Seahawks on 2026-07-12?",
		"category": "Sports",
		"rule": "single",
		"sources": [{"id": "ESPN", "name": "ESPN", "url": "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"}]
	}`

	parsed, structured := ParseSettlementQuery(raw)
	if !structured {
		t.Fatalf("expected structured=true")
	}
	if parsed.Question != "Did the 49ers beat the Seahawks on 2026-07-12?" {
		t.Fatalf("unexpected question: %q", parsed.Question)
	}
	if parsed.Category != CategorySports {
		t.Fatalf("category not lowercased: %q", parsed.Category)
	}
	if parsed.Rule != RuleSingle {
		t.Fatalf("unexpected rule: %q", parsed.Rule)
	}
	if len(parsed.Sources) != 1 || parsed.Sources[0].ID != "espn" {
		t.Fatalf("source ids must be normalized: %+v", parsed.Sources)
	}
}

func TestParseSettlementQuery_DefaultRuleFromSourceCount(t *testing.T) {
	single, structured := ParseSettlementQuery(`{"question": "q", "sources": [{"id": "nws"}]}`)
	if !structured || single.Rule != RuleSingle {
		t.Fatalf("one source must default to single, got %q (structured=%t)", single.Rule, structured)
	}

	majority, structured := ParseSettlementQuery(`{"question": "q", "sources": [{"id": "nyt"}, {"id": "bbc"}]}`)
	if !structured || majority.Rule != RuleMajority {
		t.Fatalf("multiple sources must default to majority, got %q (structured=%t)", majority.Rule, structured)
	}
}

func TestParseSettlementQuery_FallsBackToGeneral(t *testing.T) {
	for _, raw := range []string{
		"Will it rain in SF tomorrow?",           // plain text
		`{"category": "news"}`,                   // JSON without a question
		`{"question": "q", "rule": "plurality"}`, // unknown rule
		`{not json`,
	} {
		parsed, structured := ParseSettlementQuery(raw)
		if structured {
			t.Fatalf("input %q must not parse as structured", raw)
		}
		if parsed.Category != CategoryGeneral {
			t.Fatalf("fallback category must be general, got %q", parsed.Category)
		}
	}
}

func TestParseSettlementQuery_TolerantOfExtraFields(t *testing.T) {
	parsed, structured := ParseSettlementQuery(
		`{"question": "q", "rule": "majority", "sources": [{"id": "nyt"}, {"id": "ap"}], "closeNote": "resolves 2026-08-01"}`,
	)
	if !structured {
		t.Fatalf("extra fields must not break structured parsing")
	}
	if parsed.Rule != RuleMajority || len(parsed.Sources) != 2 {
		t.Fatalf("unexpected parse result: %+v", parsed)
	}
}

func TestParseSettlementQuery_DropsSourcesWithoutID(t *testing.T) {
	parsed, structured := ParseSettlementQuery(`{"question": "q", "sources": [{"id": ""}, {"id": "bbc"}]}`)
	if !structured || len(parsed.Sources) != 1 || parsed.Sources[0].ID != "bbc" {
		t.Fatalf("unexpected sources: %+v (structured=%t)", parsed.Sources, structured)
	}
}
