package shape

import "fmt"

func ValidateStructuredOutput(fields []FieldSpec, shaped map[string]any) error {
	if len(shaped) != len(fields) {
		return fmt.Errorf("field count mismatch: expected %d got %d", len(fields), len(shaped))
	}

	for _, field := range fields {
		if _, ok := shaped[field.Name]; !ok {
			return fmt.Errorf("missing field %q", field.Name)
		}
	}

	return nil
}
