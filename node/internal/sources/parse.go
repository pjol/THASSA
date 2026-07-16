package sources

import (
	"encoding/json"
	"strings"
)

// ParseSettlementQuery parses a settlement query string from bid inputData. Structured queries
// are JSON objects with a non-empty "question"; anything else falls back to a general free-text
// question (structured == false).
func ParseSettlementQuery(raw string) (StructuredQuery, bool) {
	trimmed := strings.TrimSpace(raw)

	fallback := StructuredQuery{
		Question: trimmed,
		Category: CategoryGeneral,
		Rule:     "",
		Sources:  nil,
	}

	if !strings.HasPrefix(trimmed, "{") {
		return fallback, false
	}

	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.DisallowUnknownFields()

	var parsed StructuredQuery
	if err := decoder.Decode(&parsed); err != nil {
		// Tolerate extra fields from newer registry versions: retry without strictness.
		var lenient StructuredQuery
		if lenientErr := json.Unmarshal([]byte(trimmed), &lenient); lenientErr != nil {
			return fallback, false
		}
		parsed = lenient
	}

	parsed.Question = strings.TrimSpace(parsed.Question)
	if parsed.Question == "" {
		return fallback, false
	}

	parsed.Category = strings.ToLower(strings.TrimSpace(parsed.Category))
	if parsed.Category == "" {
		parsed.Category = CategoryGeneral
	}

	parsed.Rule = strings.ToLower(strings.TrimSpace(parsed.Rule))
	if parsed.Rule == "" {
		if len(parsed.Sources) > 1 {
			parsed.Rule = RuleMajority
		} else {
			parsed.Rule = RuleSingle
		}
	}
	if parsed.Rule != RuleSingle && parsed.Rule != RuleMajority {
		return fallback, false
	}

	cleaned := make([]SourceRef, 0, len(parsed.Sources))
	for _, ref := range parsed.Sources {
		ref.ID = strings.ToLower(strings.TrimSpace(ref.ID))
		ref.Name = strings.TrimSpace(ref.Name)
		ref.URL = strings.TrimSpace(ref.URL)
		if ref.ID == "" {
			continue
		}
		cleaned = append(cleaned, ref)
	}
	parsed.Sources = cleaned

	return parsed, true
}
