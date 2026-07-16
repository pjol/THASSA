package sources

import (
	"fmt"
	"strings"
)

// Resolve applies the resolution rule to per-source verdicts, in code (never delegated to the
// LLM). totalSources is the number of BOUND sources (not just the successfully fetched ones):
// failed fetches count against concurrence, so unavailable sources can never be outvoted into
// a settlement.
//
//   - RuleSingle: exactly one bound source decides; any fetch/adjudication failure, or a source
//     that reports the outcome as not yet determinable, yields no settlement.
//   - RuleMajority: a strict majority (floor(total/2)+1) of ALL bound sources must concur on the
//     same direction; ties or too many failures yield no settlement.
func Resolve(rule string, totalSources int, verdicts []Verdict) Outcome {
	switch strings.ToLower(strings.TrimSpace(rule)) {
	case RuleSingle:
		return resolveSingle(totalSources, verdicts)
	case RuleMajority:
		return resolveMajority(totalSources, verdicts)
	default:
		return Outcome{Reason: fmt.Sprintf("unknown resolution rule %q", rule)}
	}
}

func resolveSingle(totalSources int, verdicts []Verdict) Outcome {
	if totalSources != 1 || len(verdicts) != 1 {
		return Outcome{
			Reason: fmt.Sprintf("single rule requires exactly one bound source, got %d bound / %d verdicts", totalSources, len(verdicts)),
		}
	}

	verdict := verdicts[0]
	if verdict.Err != nil {
		return Outcome{Reason: fmt.Sprintf("source %s failed: %v", verdict.SourceID, verdict.Err)}
	}
	if !verdict.Settled {
		return Outcome{Reason: fmt.Sprintf("source %s reports the outcome as not yet determinable", verdict.SourceID)}
	}

	return Outcome{
		Settled:   true,
		Direction: verdict.Direction,
		Reason:    fmt.Sprintf("single source %s decided direction=%t", verdict.SourceID, verdict.Direction),
	}
}

func resolveMajority(totalSources int, verdicts []Verdict) Outcome {
	if totalSources < 2 {
		return Outcome{Reason: fmt.Sprintf("majority rule requires at least two bound sources, got %d", totalSources)}
	}

	required := totalSources/2 + 1

	var yes, no, failed, unsettled int
	for _, verdict := range verdicts {
		switch {
		case verdict.Err != nil:
			failed++
		case !verdict.Settled:
			unsettled++
		case verdict.Direction:
			yes++
		default:
			no++
		}
	}

	if yes >= required {
		return Outcome{
			Settled:   true,
			Direction: true,
			Reason:    fmt.Sprintf("majority concurrence: %d/%d sources say YES (required %d)", yes, totalSources, required),
		}
	}
	if no >= required {
		return Outcome{
			Settled:   true,
			Direction: false,
			Reason:    fmt.Sprintf("majority concurrence: %d/%d sources say NO (required %d)", no, totalSources, required),
		}
	}

	return Outcome{
		Reason: fmt.Sprintf(
			"no majority concurrence: yes=%d no=%d unsettled=%d failed=%d of %d bound sources (required %d)",
			yes, no, unsettled, failed, totalSources, required,
		),
	}
}
