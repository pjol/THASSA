package marketsvc

import (
	"errors"
	"regexp"
	"strings"
	"unicode"
)

// Sanitization + prompt-injection guardrails (spec §6.5/§8): user text is
// length-capped, stripped of control characters and URLs, and screened by a
// deny-list before it is ever placed — inside a delimited data block only —
// in front of the model.

const maxInputLen = 200

var (
	// ErrEmptyInput is returned when nothing usable remains after cleaning.
	ErrEmptyInput = errors.New("empty market query")
	// ErrTooLong is returned for inputs over the 200-char cap.
	ErrTooLong = errors.New("market query too long (max 200 characters)")
	// ErrFlagged is returned when the deny-list matches.
	ErrFlagged = errors.New("market query rejected by content guardrails")
)

var urlRE = regexp.MustCompile(`(?i)\b(?:https?://|www\.)\S+`)

// denyList catches prompt-injection and self-dealing attempts: references to
// the system prompt / instructions / tools, role-switching, and
// payout-to-self settlement conditions.
var denyList = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)`),
	regexp.MustCompile(`(?i)\bdisregard\s+(the\s+)?(instructions?|rules?|system)`),
	regexp.MustCompile(`(?i)\bsystem\s*prompt\b`),
	regexp.MustCompile(`(?i)\byou\s+are\s+now\b`),
	regexp.MustCompile(`(?i)\bact\s+as\b.*\b(admin|root|developer|system)\b`),
	regexp.MustCompile(`(?i)\b(reveal|print|show|repeat)\b.*\b(instructions?|prompt|rules)\b`),
	regexp.MustCompile(`(?i)\b(tool|function)\s*(call|use|invocation)s?\b`),
	regexp.MustCompile(`(?i)\bapi[\s_-]?key\b`),
	regexp.MustCompile(`(?i)\bjailbreak\b|\bDAN\b`),
	regexp.MustCompile(`(?i)\b(settle|resolve|pay(s|out)?|award)\b.*\b(me|my|myself|caller|sender|maker)\b`),
	regexp.MustCompile(`(?i)\balways\s+(settle|resolve)s?\s+(yes|no|true|false)\b`),
	regexp.MustCompile(`(?i)_fulfilled\b|\bfulfiller\b|\boracle\s+node\b`),
	regexp.MustCompile("(?i)```|<\\|"),
}

// Sanitize cleans a raw "attach market" query: trims, strips control chars
// and URLs, collapses whitespace, enforces the length cap, and runs the
// deny-list. Returns the cleaned text and flagged=true (with ErrFlagged) when
// an injection attempt was detected — callers must log either way.
func Sanitize(raw string) (clean string, flagged bool, err error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false, ErrEmptyInput
	}
	if len(s) > maxInputLen {
		return "", false, ErrTooLong
	}
	// Strip control characters (keep normal whitespace as spaces).
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' || r == '\t' || r == '\r':
			b.WriteRune(' ')
		case unicode.IsControl(r):
			// drop
		default:
			b.WriteRune(r)
		}
	}
	s = b.String()
	// Strip URLs entirely (settlement sources come from the registry, never
	// from user-supplied links).
	s = urlRE.ReplaceAllString(s, " ")
	// Collapse whitespace.
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", false, ErrEmptyInput
	}
	for _, re := range denyList {
		if re.MatchString(s) {
			return s, true, ErrFlagged
		}
	}
	return s, false, nil
}

// ScreenCandidate applies the deny-list to model OUTPUT as well (question +
// settlement query text), rejecting candidates that smuggle instructions or
// self-dealing conditions through the generation step.
func ScreenCandidate(text string) bool {
	for _, re := range denyList {
		if re.MatchString(text) {
			return false
		}
	}
	return true
}
