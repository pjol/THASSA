#![no_main]
sp1_zkvm::entrypoint!(main);

use anyhow::{anyhow, Context, Result};
use ethabi::{
    ethereum_types::{Address, H256, U256},
    Token,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thassa_zkvm_lib::{OracleSpec, ProofCommitmentJson, ProofProgramInput};
use tiny_keccak::{Hasher, Keccak};
use zktls_att_verification::attestation_data::verify_attestation_data;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FieldSpec {
    name: String,
    solidity_type: String,
}

fn main() {
    if let Err(err) = run() {
        panic!("thassa zkvm program failed: {err:#}");
    }
}

fn run() -> Result<()> {
    let raw_input = sp1_zkvm::io::read::<String>();
    let input: ProofProgramInput =
        serde_json::from_str(&raw_input).context("parse proof program input")?;

    let attestation_config = serde_json::json!({
        "attestor_addr": input.expected_attestor,
        "url": input.allowed_urls,
    });
    let (attestation_data, _config, messages) = verify_attestation_data(
        &input.attestation_data_json,
        &attestation_config.to_string(),
    )
    .context("verify Primus attestation data")?;

    let public_data = attestation_data
        .public_data
        .first()
        .ok_or_else(|| anyhow!("attestation public_data cannot be empty"))?;
    let fulfiller = parse_address(&input.commitment.fulfiller)?;
    let recipient = parse_address(&public_data.attestation.recipient)?;
    if recipient != fulfiller {
        return Err(anyhow!(
            "attestation recipient did not match commitment fulfiller"
        ));
    }
    let request = public_data
        .attestation
        .request
        .first()
        .ok_or_else(|| anyhow!("attestation request cannot be empty"))?;
    if !request.method.eq_ignore_ascii_case("POST") {
        return Err(anyhow!("attested request method was not POST"));
    }
    if request.body != input.openai_request_body_json {
        return Err(anyhow!(
            "attested request body did not match expected OpenAI body"
        ));
    }

    let first_message = messages
        .first()
        .and_then(|group| group.first())
        .ok_or_else(|| anyhow!("verified attestation messages cannot be empty"))?;
    let content = first_message
        .msg
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("attested OpenAI response missing choices[0].message.content"))?;
    let structured_output: Value = serde_json::from_str(content)
        .context("parse structured output JSON from attested response")?;

    let fields = parse_expected_shape_dsl(&input.oracle_spec.expected_shape)?;
    validate_structured_output(&fields, &structured_output)?;
    let callback_data = encode_callback_data(&fields, &structured_output)?;
    let expected_callback_data = decode_hex_prefixed(&input.callback_data_hex)?;
    if callback_data != expected_callback_data {
        return Err(anyhow!(
            "callback data mismatch between zkvm recomputation and node input"
        ));
    }

    let commitment = &input.commitment;
    if commitment.client_version != input.oracle_spec.client_version {
        return Err(anyhow!(
            "commitment client version did not match oracle spec"
        ));
    }
    let query_hash = keccak256_bytes(input.oracle_spec.query.as_bytes());
    let shape_hash = keccak256_bytes(input.oracle_spec.expected_shape.as_bytes());
    let model_hash = keccak256_bytes(input.oracle_spec.model.as_bytes());
    if hex_32(&query_hash) != normalize_hex_32(&commitment.query_hash)? {
        return Err(anyhow!("query hash mismatch"));
    }
    if hex_32(&shape_hash) != normalize_hex_32(&commitment.shape_hash)? {
        return Err(anyhow!("shape hash mismatch"));
    }
    if hex_32(&model_hash) != normalize_hex_32(&commitment.model_hash)? {
        return Err(anyhow!("model hash mismatch"));
    }

    let derived_nonce = derive_nonce(commitment.request_timestamp, &input.api_key);
    if derived_nonce != parse_u256(&commitment.nonce)? {
        return Err(anyhow!("nonce mismatch"));
    }

    let callback_hash = keccak256_bytes(&callback_data);
    if hex_32(&callback_hash) != normalize_hex_32(&commitment.callback_hash)? {
        return Err(anyhow!("callback hash mismatch"));
    }

    let public_values = encode_commitment(commitment, &input.oracle_spec)?;
    sp1_zkvm::io::commit_slice(&public_values);
    Ok(())
}

fn encode_commitment(
    commitment: &ProofCommitmentJson,
    oracle_spec: &OracleSpec,
) -> Result<Vec<u8>> {
    Ok(ethabi::encode(&[
        Token::FixedBytes(parse_h256(&commitment.digest)?.0.to_vec()),
        Token::Uint(parse_u256(&commitment.bid_id)?),
        Token::Bool(commitment.auto_flow),
        Token::Address(parse_address(&commitment.client)?),
        Token::Address(parse_address(&commitment.fulfiller)?),
        Token::FixedBytes(keccak256_bytes(oracle_spec.query.as_bytes()).to_vec()),
        Token::FixedBytes(keccak256_bytes(oracle_spec.expected_shape.as_bytes()).to_vec()),
        Token::FixedBytes(keccak256_bytes(oracle_spec.model.as_bytes()).to_vec()),
        Token::Uint(U256::from(commitment.client_version)),
        Token::Uint(U256::from(commitment.request_timestamp)),
        Token::Uint(U256::from(commitment.expiry)),
        Token::Uint(parse_u256(&commitment.nonce)?),
        Token::FixedBytes(parse_h256(&commitment.callback_hash)?.0.to_vec()),
    ]))
}

fn parse_expected_shape_dsl(expected_shape: &str) -> Result<Vec<FieldSpec>> {
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
        });
    }

    Ok(fields)
}

fn validate_structured_output(fields: &[FieldSpec], shaped: &Value) -> Result<()> {
    let object = shaped
        .as_object()
        .ok_or_else(|| anyhow!("structured output must be a JSON object"))?;

    for field in fields {
        if !object.contains_key(&field.name) {
            return Err(anyhow!("structured output missing field {}", field.name));
        }
    }

    if object.len() != fields.len() {
        return Err(anyhow!("structured output contained unexpected fields"));
    }

    Ok(())
}

fn encode_callback_data(fields: &[FieldSpec], shaped: &Value) -> Result<Vec<u8>> {
    let object = shaped
        .as_object()
        .ok_or_else(|| anyhow!("structured output must be an object"))?;
    let mut tokens = Vec::with_capacity(fields.len());
    for field in fields {
        let value = object
            .get(&field.name)
            .ok_or_else(|| anyhow!("missing shaped field {}", field.name))?;
        tokens.push(coerce_token(&field.solidity_type, value)?);
    }
    Ok(ethabi::encode(&tokens))
}

fn coerce_token(solidity_type: &str, value: &Value) -> Result<Token> {
    let ty = solidity_type.trim().to_lowercase();
    match ty.as_str() {
        "string" => Ok(Token::String(value_to_string(value))),
        "bool" => Ok(Token::Bool(value_to_bool(value)?)),
        "address" => Ok(Token::Address(parse_address(&value_to_string(value))?)),
        "bytes" => Ok(Token::Bytes(value_to_bytes(value)?)),
        _ if ty.starts_with("bytes") => {
            let expected = ty.trim_start_matches("bytes").parse::<usize>().ok();
            let bytes = value_to_bytes(value)?;
            if let Some(expected) = expected {
                if expected != bytes.len() {
                    return Err(anyhow!("expected {expected} bytes, got {}", bytes.len()));
                }
                Ok(Token::FixedBytes(bytes))
            } else {
                Ok(Token::Bytes(bytes))
            }
        }
        _ if ty.starts_with("uint") => Ok(Token::Uint(value_to_uint(value)?)),
        _ if ty.starts_with("int") => Ok(Token::Int(value_to_int(value)?)),
        _ => Err(anyhow!("unsupported ABI type: {solidity_type}")),
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn value_to_bool(value: &Value) -> Result<bool> {
    match value {
        Value::Bool(b) => Ok(*b),
        Value::String(s) => match s.to_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(anyhow!("expected boolean string")),
        },
        _ => Err(anyhow!("expected boolean-compatible value")),
    }
}

fn value_to_bytes(value: &Value) -> Result<Vec<u8>> {
    match value {
        Value::String(s) if s.starts_with("0x") || s.starts_with("0X") => {
            hex::decode(&s[2..]).map_err(|err| anyhow!("invalid hex bytes: {err}"))
        }
        Value::String(s) => Ok(s.as_bytes().to_vec()),
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let byte = item
                    .as_u64()
                    .ok_or_else(|| anyhow!("expected array of unsigned bytes"))?;
                out.push(u8::try_from(byte).map_err(|_| anyhow!("byte value out of range"))?);
            }
            Ok(out)
        }
        _ => Err(anyhow!("expected byte string")),
    }
}

fn value_to_uint(value: &Value) -> Result<U256> {
    match value {
        Value::Number(n) => {
            U256::from_dec_str(&n.to_string()).map_err(|err| anyhow!("invalid uint: {err}"))
        }
        Value::String(s) => parse_u256(s),
        _ => Err(anyhow!("expected integer-compatible value")),
    }
}

fn value_to_int(value: &Value) -> Result<U256> {
    let raw = match value {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return Err(anyhow!("expected integer-compatible value")),
    };

    if let Some(unsigned) = raw.strip_prefix('-') {
        let magnitude = parse_u256(unsigned)?;
        Ok((!magnitude).overflowing_add(U256::from(1u8)).0)
    } else {
        parse_u256(&raw)
    }
}

fn derive_nonce(request_timestamp: u64, api_key: &str) -> U256 {
    let mut hasher = Sha256::new();
    hasher.update(request_timestamp.to_be_bytes());
    hasher.update(api_key.as_bytes());
    let digest = hasher.finalize();
    U256::from_big_endian(&digest)
}

fn parse_address(raw: &str) -> Result<Address> {
    let bytes = decode_hex_prefixed(raw)?;
    if bytes.len() != 20 {
        return Err(anyhow!("address must be 20 bytes"));
    }
    Ok(Address::from_slice(&bytes))
}

fn parse_h256(raw: &str) -> Result<H256> {
    let bytes = decode_hex_prefixed(raw)?;
    if bytes.len() != 32 {
        return Err(anyhow!("bytes32 value must be 32 bytes"));
    }
    Ok(H256::from_slice(&bytes))
}

fn parse_u256(raw: &str) -> Result<U256> {
    if let Some(hex_value) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        let bytes = hex::decode(hex_value).with_context(|| format!("decode hex uint {raw}"))?;
        Ok(U256::from_big_endian(&bytes))
    } else {
        U256::from_dec_str(raw).with_context(|| format!("parse uint {raw}"))
    }
}

fn decode_hex_prefixed(raw: &str) -> Result<Vec<u8>> {
    let trimmed = raw.trim_start_matches("0x").trim_start_matches("0X");
    hex::decode(trimmed).with_context(|| format!("decode hex value {raw}"))
}

fn normalize_hex_32(raw: &str) -> Result<[u8; 32]> {
    let bytes = decode_hex_prefixed(raw)?;
    if bytes.len() != 32 {
        return Err(anyhow!("expected 32-byte hex value"));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn hex_32(bytes: &[u8; 32]) -> [u8; 32] {
    *bytes
}

fn keccak256_bytes(input: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut keccak = Keccak::v256();
    keccak.update(input);
    keccak.finalize(&mut out);
    out
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
