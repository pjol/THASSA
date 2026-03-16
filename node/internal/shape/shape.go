package shape

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

type FieldSpec struct {
	Name         string `json:"name"`
	SolidityType string `json:"solidityType"`
	JSONType     string `json:"jsonType,omitempty"`
	Description  string `json:"description,omitempty"`
	Optional     bool   `json:"optional,omitempty"`
}

var (
	validUintType  = regexp.MustCompile(`^uint([0-9]{0,3})$`)
	validIntType   = regexp.MustCompile(`^int([0-9]{0,3})$`)
	validBytesType = regexp.MustCompile(`^bytes([0-9]+)$`)
)

func ValidateFields(fields []FieldSpec) error {
	if len(fields) == 0 {
		return errors.New("shape must include at least one field")
	}

	seen := make(map[string]struct{}, len(fields))
	for i, field := range fields {
		if field.Name == "" {
			return fmt.Errorf("shape[%d].name is required", i)
		}
		if field.SolidityType == "" {
			return fmt.Errorf("shape[%d].solidityType is required", i)
		}

		if _, exists := seen[field.Name]; exists {
			return fmt.Errorf("duplicate shape field name: %s", field.Name)
		}
		seen[field.Name] = struct{}{}

		if _, err := inferJSONType(field); err != nil {
			return fmt.Errorf("shape[%d]: %w", i, err)
		}
	}

	return nil
}

func BuildJSONSchema(fields []FieldSpec) (map[string]any, error) {
	if err := ValidateFields(fields); err != nil {
		return nil, err
	}

	properties := make(map[string]any, len(fields))
	required := make([]string, 0, len(fields))

	for _, field := range fields {
		jsonType, err := inferJSONType(field)
		if err != nil {
			return nil, err
		}

		fieldSchema := map[string]any{
			"type": jsonType,
		}
		if field.Description != "" {
			fieldSchema["description"] = field.Description
		}

		properties[field.Name] = fieldSchema
		if !field.Optional {
			required = append(required, field.Name)
		}
	}

	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}

	return schema, nil
}

func CanonicalShape(fields []FieldSpec) (string, error) {
	if err := ValidateFields(fields); err != nil {
		return "", err
	}

	pairs := make([][]string, 0, len(fields))
	for _, field := range fields {
		pairs = append(pairs, []string{field.Name, field.SolidityType})
	}

	raw, err := json.Marshal(pairs)
	if err != nil {
		return "", err
	}

	return string(raw), nil
}

func inferJSONType(field FieldSpec) (string, error) {
	if field.JSONType != "" {
		return field.JSONType, nil
	}

	solType := strings.ToLower(strings.TrimSpace(field.SolidityType))
	switch {
	case solType == "string", solType == "address", solType == "bytes", solType == "bytes32", validBytesType.MatchString(solType):
		return "string", nil
	case solType == "bool":
		return "boolean", nil
	case validUintType.MatchString(solType), validIntType.MatchString(solType):
		return "integer", nil
	default:
		return "", fmt.Errorf("unsupported solidity type for shape inference: %s", field.SolidityType)
	}
}
