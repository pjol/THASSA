use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::types::FieldSpec;

pub fn validate_fields(fields: &[FieldSpec]) -> Result<()> {
    if fields.is_empty() {
        return Err(anyhow!("shape must include at least one field"));
    }

    let mut seen = std::collections::HashSet::with_capacity(fields.len());
    for (idx, field) in fields.iter().enumerate() {
        if field.name.trim().is_empty() {
            return Err(anyhow!("shape[{idx}].name is required"));
        }
        if field.solidity_type.trim().is_empty() {
            return Err(anyhow!("shape[{idx}].solidity_type is required"));
        }
        if !seen.insert(field.name.clone()) {
            return Err(anyhow!("duplicate shape field name: {}", field.name));
        }
        infer_json_type(field)?;
    }

    Ok(())
}

pub fn parse_expected_shape_dsl(expected_shape: &str) -> Result<Vec<FieldSpec>> {
    let normalized = compact_whitespace(expected_shape);
    if !normalized.starts_with("tuple(") || !normalized.ends_with(')') {
        return Err(anyhow!("expectedShape must be tuple(...)"));
    }

    let body = &normalized["tuple(".len()..normalized.len() - 1];
    if body.trim().is_empty() {
        return Err(anyhow!("tuple must contain at least one field"));
    }

    let parts = split_top_level(body, ',')?;
    let mut fields = Vec::with_capacity(parts.len());

    for part in parts {
        let item = part.trim();
        if item.is_empty() {
            return Err(anyhow!("empty tuple field"));
        }

        let pieces = split_top_level(item, ':')?;
        if pieces.len() != 2 {
            return Err(anyhow!("invalid field {item:?} (expected name:type)"));
        }

        let name = pieces[0].trim();
        let solidity_type = pieces[1].trim();
        if !is_valid_field_name(name) {
            return Err(anyhow!("invalid field name {name:?}"));
        }
        if solidity_type.is_empty() {
            return Err(anyhow!("field {name:?} has empty type"));
        }
        if solidity_type.contains('(')
            || solidity_type.contains(')')
            || solidity_type.contains('[')
            || solidity_type.contains(']')
        {
            return Err(anyhow!(
                "field {name:?} uses unsupported type {solidity_type:?}; only flat primitive tuple fields are supported"
            ));
        }

        fields.push(FieldSpec {
            name: name.to_string(),
            solidity_type: solidity_type.to_string(),
            json_type: None,
            description: None,
            optional: None,
        });
    }

    validate_fields(&fields)?;
    Ok(fields)
}

pub fn build_json_schema(fields: &[FieldSpec]) -> Result<Value> {
    validate_fields(fields)?;

    let mut properties = serde_json::Map::with_capacity(fields.len());
    let mut required = Vec::with_capacity(fields.len());

    for field in fields {
        let json_type = infer_json_type(field)?;
        let mut schema = serde_json::Map::new();
        schema.insert("type".to_string(), Value::String(json_type));
        if let Some(description) = &field.description {
            schema.insert(
                "description".to_string(),
                Value::String(description.clone()),
            );
        }
        properties.insert(field.name.clone(), Value::Object(schema));
        if !field.optional.unwrap_or(false) {
            required.push(Value::String(field.name.clone()));
        }
    }

    let mut schema = serde_json::Map::new();
    schema.insert("type".to_string(), Value::String("object".to_string()));
    schema.insert("properties".to_string(), Value::Object(properties));
    schema.insert("additionalProperties".to_string(), Value::Bool(false));
    if !required.is_empty() {
        schema.insert("required".to_string(), Value::Array(required));
    }

    Ok(Value::Object(schema))
}

pub fn canonical_shape(fields: &[FieldSpec]) -> Result<String> {
    validate_fields(fields)?;
    let pairs: Vec<[String; 2]> = fields
        .iter()
        .map(|field| [field.name.clone(), field.solidity_type.clone()])
        .collect();
    Ok(serde_json::to_string(&pairs)?)
}

fn infer_json_type(field: &FieldSpec) -> Result<String> {
    if let Some(json_type) = &field.json_type {
        return Ok(json_type.clone());
    }

    let sol_type = field.solidity_type.trim().to_lowercase();
    if matches!(
        sol_type.as_str(),
        "string" | "address" | "bytes" | "bytes32"
    ) || sol_type.starts_with("bytes")
    {
        return Ok("string".to_string());
    }
    if sol_type == "bool" {
        return Ok("boolean".to_string());
    }
    if sol_type.starts_with("uint") || sol_type.starts_with("int") {
        return Ok("integer".to_string());
    }

    Err(anyhow!(
        "unsupported solidity type for shape inference: {}",
        field.solidity_type
    ))
}

fn compact_whitespace(input: &str) -> String {
    input
        .trim()
        .chars()
        .filter(|c| *c != '\n' && *c != '\r' && *c != '\t')
        .collect::<String>()
        .trim()
        .to_string()
}

fn split_top_level(input: &str, separator: char) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut last = 0usize;
    let mut depth_paren = 0i32;
    let mut depth_bracket = 0i32;

    for (idx, ch) in input.char_indices() {
        match ch {
            '(' => depth_paren += 1,
            ')' => {
                depth_paren -= 1;
                if depth_paren < 0 {
                    return Err(anyhow!("unbalanced parentheses in shape"));
                }
            }
            '[' => depth_bracket += 1,
            ']' => {
                depth_bracket -= 1;
                if depth_bracket < 0 {
                    return Err(anyhow!("unbalanced brackets in shape"));
                }
            }
            _ => {}
        }

        if ch == separator && depth_paren == 0 && depth_bracket == 0 {
            parts.push(input[last..idx].to_string());
            last = idx + ch.len_utf8();
        }
    }

    if depth_paren != 0 || depth_bracket != 0 {
        return Err(anyhow!("unbalanced delimiters in shape"));
    }

    parts.push(input[last..].to_string());
    Ok(parts)
}

fn is_valid_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

pub fn schema_from_shape(fields: &[FieldSpec]) -> Result<Value> {
    build_json_schema(fields)
}

pub fn schema_debug_string(schema: &Value) -> String {
    serde_json::to_string(schema).unwrap_or_else(|_| json!({"error":"invalid schema"}).to_string())
}
