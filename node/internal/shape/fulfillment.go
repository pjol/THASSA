package shape

import "fmt"

const FulfillmentFieldName = "_fulfilled"

var fulfillmentField = FieldSpec{
	Name:         FulfillmentFieldName,
	SolidityType: "bool",
	Description:  "True only if the request was successfully executed with real source data. False if fallback/default values were used.",
}

func WithFulfillmentField(fields []FieldSpec) []FieldSpec {
	if HasField(fields, FulfillmentFieldName) {
		cloned := make([]FieldSpec, len(fields))
		copy(cloned, fields)
		return cloned
	}

	augmented := make([]FieldSpec, 0, len(fields)+1)
	augmented = append(augmented, fields...)
	augmented = append(augmented, fulfillmentField)
	return augmented
}

func WithoutFulfillmentField(fields []FieldSpec) []FieldSpec {
	filtered := make([]FieldSpec, 0, len(fields))
	for _, field := range fields {
		if field.Name == FulfillmentFieldName {
			continue
		}
		filtered = append(filtered, field)
	}
	return filtered
}

func HasField(fields []FieldSpec, name string) bool {
	for _, field := range fields {
		if field.Name == name {
			return true
		}
	}
	return false
}

func ExtractFulfillmentFlag(shaped map[string]any) (bool, error) {
	if shaped == nil {
		return false, fmt.Errorf("structured output is empty")
	}

	raw, ok := shaped[FulfillmentFieldName]
	if !ok {
		return false, fmt.Errorf("missing field %q", FulfillmentFieldName)
	}

	value, ok := raw.(bool)
	if !ok {
		return false, fmt.Errorf("field %q must be boolean", FulfillmentFieldName)
	}

	return value, nil
}
