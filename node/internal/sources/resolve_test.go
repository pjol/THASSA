package sources

import (
	"errors"
	"testing"
)

func verdict(id string, settled bool, direction bool) Verdict {
	return Verdict{SourceID: id, Settled: settled, Direction: direction}
}

func failedVerdict(id string) Verdict {
	return Verdict{SourceID: id, Err: errors.New("boom")}
}

func TestResolve_SingleSettles(t *testing.T) {
	outcome := Resolve(RuleSingle, 1, []Verdict{verdict("espn", true, true)})
	if !outcome.Settled || !outcome.Direction {
		t.Fatalf("expected settled YES, got %+v", outcome)
	}

	outcome = Resolve(RuleSingle, 1, []Verdict{verdict("espn", true, false)})
	if !outcome.Settled || outcome.Direction {
		t.Fatalf("expected settled NO, got %+v", outcome)
	}
}

func TestResolve_SingleFailureOrUndeterminedDoesNotSettle(t *testing.T) {
	if outcome := Resolve(RuleSingle, 1, []Verdict{failedVerdict("nws")}); outcome.Settled {
		t.Fatalf("failed source must not settle: %+v", outcome)
	}
	if outcome := Resolve(RuleSingle, 1, []Verdict{verdict("nws", false, false)}); outcome.Settled {
		t.Fatalf("undetermined source must not settle: %+v", outcome)
	}
	if outcome := Resolve(RuleSingle, 2, []Verdict{verdict("a", true, true), verdict("b", true, true)}); outcome.Settled {
		t.Fatalf("single rule with two bound sources must not settle: %+v", outcome)
	}
}

func TestResolve_MajorityConcurrence(t *testing.T) {
	// 3 of 5 concur YES.
	outcome := Resolve(RuleMajority, 5, []Verdict{
		verdict("nyt", true, true),
		verdict("wsj", true, true),
		verdict("reuters", true, true),
		verdict("ap", true, false),
		failedVerdict("bbc"),
	})
	if !outcome.Settled || !outcome.Direction {
		t.Fatalf("expected settled YES with 3/5, got %+v", outcome)
	}

	// 3 of 5 concur NO.
	outcome = Resolve(RuleMajority, 5, []Verdict{
		verdict("nyt", true, false),
		verdict("wsj", true, false),
		verdict("reuters", true, false),
		verdict("ap", true, true),
		verdict("bbc", false, false),
	})
	if !outcome.Settled || outcome.Direction {
		t.Fatalf("expected settled NO with 3/5, got %+v", outcome)
	}
}

func TestResolve_MajorityNotReached(t *testing.T) {
	// 2 yes / 2 no / 1 failed: no majority.
	outcome := Resolve(RuleMajority, 5, []Verdict{
		verdict("nyt", true, true),
		verdict("wsj", true, true),
		verdict("reuters", true, false),
		verdict("ap", true, false),
		failedVerdict("bbc"),
	})
	if outcome.Settled {
		t.Fatalf("tie must not settle: %+v", outcome)
	}

	// Failures count against the majority: 2 yes of 5 bound is insufficient even though every
	// successful source concurred.
	outcome = Resolve(RuleMajority, 5, []Verdict{
		verdict("nyt", true, true),
		verdict("wsj", true, true),
		failedVerdict("reuters"),
		failedVerdict("ap"),
		failedVerdict("bbc"),
	})
	if outcome.Settled {
		t.Fatalf("2/5 with failures must not settle: %+v", outcome)
	}
}

func TestResolve_MajorityEvenPanelNeedsStrictMajority(t *testing.T) {
	// 2 of 4 is a tie-capable split: strict majority requires 3.
	outcome := Resolve(RuleMajority, 4, []Verdict{
		verdict("a", true, true),
		verdict("b", true, true),
		verdict("c", true, false),
		verdict("d", false, false),
	})
	if outcome.Settled {
		t.Fatalf("2/4 must not settle: %+v", outcome)
	}

	outcome = Resolve(RuleMajority, 4, []Verdict{
		verdict("a", true, true),
		verdict("b", true, true),
		verdict("c", true, true),
		verdict("d", true, false),
	})
	if !outcome.Settled || !outcome.Direction {
		t.Fatalf("3/4 must settle YES: %+v", outcome)
	}
}

func TestResolve_UnknownRule(t *testing.T) {
	if outcome := Resolve("plurality", 3, nil); outcome.Settled {
		t.Fatalf("unknown rule must not settle: %+v", outcome)
	}
}
