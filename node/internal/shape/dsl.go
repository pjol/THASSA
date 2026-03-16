package shape

import (
	"fmt"
	"regexp"
	"strings"
)

var validFieldName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func ParseExpectedShapeDSL(expectedShape string) ([]FieldSpec, error) {
	normalized := compactWhitespace(expectedShape)
	if !strings.HasPrefix(normalized, "tuple(") || !strings.HasSuffix(normalized, ")") {
		return nil, fmt.Errorf("expectedShape must be tuple(...)")
	}

	body := normalized[len("tuple(") : len(normalized)-1]
	if strings.TrimSpace(body) == "" {
		return nil, fmt.Errorf("tuple must contain at least one field")
	}

	parts, err := splitTopLevel(body, ',')
	if err != nil {
		return nil, err
	}

	fields := make([]FieldSpec, 0, len(parts))
	for _, part := range parts {
		item := strings.TrimSpace(part)
		if item == "" {
			return nil, fmt.Errorf("empty tuple field")
		}

		pieces, err := splitTopLevel(item, ':')
		if err != nil {
			return nil, err
		}
		if len(pieces) != 2 {
			return nil, fmt.Errorf("invalid field %q (expected name:type)", item)
		}

		name := strings.TrimSpace(pieces[0])
		solType := strings.TrimSpace(pieces[1])

		if !validFieldName.MatchString(name) {
			return nil, fmt.Errorf("invalid field name %q", name)
		}
		if solType == "" {
			return nil, fmt.Errorf("field %q has empty type", name)
		}

		// Autofill currently supports flat tuple shapes only.
		if strings.Contains(solType, "(") || strings.Contains(solType, ")") ||
			strings.Contains(solType, "[") || strings.Contains(solType, "]") {
			return nil, fmt.Errorf(
				"field %q uses unsupported type %q for auto-fulfill; only flat primitive tuple fields are supported",
				name,
				solType,
			)
		}

		fields = append(fields, FieldSpec{
			Name:         name,
			SolidityType: solType,
		})
	}

	if err := ValidateFields(fields); err != nil {
		return nil, err
	}

	return fields, nil
}

func compactWhitespace(input string) string {
	var b strings.Builder
	b.Grow(len(input))

	for _, r := range strings.TrimSpace(input) {
		if r == '\n' || r == '\r' || r == '\t' {
			continue
		}
		b.WriteRune(r)
	}

	return strings.TrimSpace(b.String())
}

func splitTopLevel(input string, separator rune) ([]string, error) {
	var parts []string
	last := 0
	depthParen := 0
	depthBracket := 0

	for i, r := range input {
		switch r {
		case '(':
			depthParen++
		case ')':
			depthParen--
			if depthParen < 0 {
				return nil, fmt.Errorf("unbalanced parentheses in shape")
			}
		case '[':
			depthBracket++
		case ']':
			depthBracket--
			if depthBracket < 0 {
				return nil, fmt.Errorf("unbalanced brackets in shape")
			}
		}

		if r == separator && depthParen == 0 && depthBracket == 0 {
			parts = append(parts, input[last:i])
			last = i + 1
		}
	}

	if depthParen != 0 || depthBracket != 0 {
		return nil, fmt.Errorf("unbalanced delimiters in shape")
	}

	parts = append(parts, input[last:])
	return parts, nil
}
