use anyhow::{anyhow, Result};
use ethers::abi::{encode, Token};
use ethers::types::Address;
use serde_json::Value;

use crate::shape::validate_fields;
use crate::types::FieldSpec;

pub const ABI_WORD_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AbiFieldEncoding {
    StaticWord([u8; ABI_WORD_BYTES]),
    DynamicBytes(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbiEncodingPlan {
    pub fields: Vec<AbiFieldEncoding>,
}

impl AbiEncodingPlan {
    pub fn encode_callback_data(&self) -> Vec<u8> {
        encode_abi_field_encodings(&self.fields)
    }
}

pub trait CallbackFormatter: Send + Sync {
    fn encode_callback_data(&self, fields: &[FieldSpec], shaped: &Value) -> Result<Vec<u8>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AbiCallbackFormatter;

impl AbiCallbackFormatter {
    pub fn new() -> Self {
        Self
    }
}

impl CallbackFormatter for AbiCallbackFormatter {
    fn encode_callback_data(&self, fields: &[FieldSpec], shaped: &Value) -> Result<Vec<u8>> {
        Ok(build_abi_encoding_plan(fields, shaped)?.encode_callback_data())
    }
}

pub fn build_abi_encoding_plan(fields: &[FieldSpec], shaped: &Value) -> Result<AbiEncodingPlan> {
    validate_fields(fields)?;
    let object = shaped
        .as_object()
        .ok_or_else(|| anyhow!("shaped output must be a JSON object"))?;

    let mut encodings = Vec::with_capacity(fields.len());
    for field in fields {
        let value = object
            .get(&field.name)
            .ok_or_else(|| anyhow!("missing shaped field {}", field.name))?;
        encodings.push(coerce_field_encoding(&field.solidity_type, value)?);
    }

    Ok(AbiEncodingPlan { fields: encodings })
}

pub fn encode_abi_field_encodings(fields: &[AbiFieldEncoding]) -> Vec<u8> {
    let head_size = fields.len() * ABI_WORD_BYTES;
    let mut head = Vec::with_capacity(head_size);
    let mut tail = Vec::new();

    for field in fields {
        match field {
            AbiFieldEncoding::StaticWord(word) => head.extend_from_slice(word),
            AbiFieldEncoding::DynamicBytes(bytes) => {
                let offset = head_size + tail.len();
                head.extend_from_slice(&abi_word_from_usize(offset));
                tail.extend_from_slice(&encode_dynamic_abi_bytes(bytes));
            }
        }
    }

    head.extend_from_slice(&tail);
    head
}

pub fn encode_dynamic_abi_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ABI_WORD_BYTES + padded_abi_len(bytes.len()));
    out.extend_from_slice(&abi_word_from_usize(bytes.len()));
    out.extend_from_slice(bytes);
    out.resize(ABI_WORD_BYTES + padded_abi_len(bytes.len()), 0);
    out
}

pub fn padded_abi_len(len: usize) -> usize {
    if len == 0 {
        0
    } else {
        ((len + (ABI_WORD_BYTES - 1)) / ABI_WORD_BYTES) * ABI_WORD_BYTES
    }
}

pub fn abi_word_from_usize(value: usize) -> [u8; ABI_WORD_BYTES] {
    let mut word = [0u8; ABI_WORD_BYTES];
    let raw = value as u128;
    word[16..].copy_from_slice(&raw.to_be_bytes());
    word
}

fn coerce_field_encoding(solidity_type: &str, value: &Value) -> Result<AbiFieldEncoding> {
    let ty = solidity_type.trim().to_lowercase();
    match ty.as_str() {
        "string" => Ok(AbiFieldEncoding::DynamicBytes(
            value_to_string(value)?.into_bytes(),
        )),
        "bytes" => Ok(AbiFieldEncoding::DynamicBytes(value_to_bytes(value)?)),
        "bool" => single_token_static_word(Token::Bool(value_to_bool(value)?)),
        "address" => single_token_static_word(Token::Address(value_to_address(value)?)),
        _ if ty.starts_with("bytes") => {
            let expected = ty.trim_start_matches("bytes").parse::<usize>().ok();
            let bytes = value_to_bytes(value)?;
            if let Some(expected) = expected {
                if expected != bytes.len() {
                    return Err(anyhow!("expected {expected} bytes, got {}", bytes.len()));
                }
                single_token_static_word(Token::FixedBytes(bytes))
            } else {
                Ok(AbiFieldEncoding::DynamicBytes(bytes))
            }
        }
        _ if ty.starts_with("uint") => single_token_static_word(Token::Uint(value_to_uint(value)?)),
        _ if ty.starts_with("int") => {
            single_token_static_word(Token::Int(value_to_int(value)?.into_raw()))
        }
        _ => Err(anyhow!("unsupported ABI type: {solidity_type}")),
    }
}

fn single_token_static_word(token: Token) -> Result<AbiFieldEncoding> {
    let encoded = encode(&[token]);
    if encoded.len() != ABI_WORD_BYTES {
        return Err(anyhow!("expected single static ABI word"));
    }

    let mut word = [0u8; ABI_WORD_BYTES];
    word.copy_from_slice(&encoded);
    Ok(AbiFieldEncoding::StaticWord(word))
}

fn value_to_string(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        other => Ok(other.to_string()),
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

fn value_to_address(value: &Value) -> Result<Address> {
    let text = value_to_string(value)?;
    text.parse::<Address>()
        .map_err(|_| anyhow!("invalid address {text}"))
}

fn value_to_bytes(value: &Value) -> Result<Vec<u8>> {
    match value {
        Value::String(s) if s.starts_with("0x") || s.starts_with("0X") => {
            Ok(hex::decode(&s[2..]).map_err(|err| anyhow!("invalid hex bytes: {err}"))?)
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

fn value_to_uint(value: &Value) -> Result<ethers::types::U256> {
    match value {
        Value::Number(n) => n
            .to_string()
            .parse::<ethers::types::U256>()
            .map_err(|err| anyhow!("invalid uint: {err}")),
        Value::String(s) => s
            .parse::<ethers::types::U256>()
            .map_err(|err| anyhow!("invalid uint string {s:?}: {err}")),
        _ => Err(anyhow!("expected integer-compatible value")),
    }
}

fn value_to_int(value: &Value) -> Result<ethers::types::I256> {
    match value {
        Value::Number(n) => n
            .to_string()
            .parse::<ethers::types::I256>()
            .map_err(|err| anyhow!("invalid int: {err}")),
        Value::String(s) => s
            .parse::<ethers::types::I256>()
            .map_err(|err| anyhow!("invalid int string {s:?}: {err}")),
        _ => Err(anyhow!("expected integer-compatible value")),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_abi_encoding_plan, AbiCallbackFormatter, CallbackFormatter};
    use crate::types::FieldSpec;
    use serde_json::json;

    #[test]
    fn abi_encoding_plan_matches_ethers_encoder_for_flat_tuple() {
        let fields = vec![
            FieldSpec {
                name: "observationTimestamp".to_string(),
                solidity_type: "uint64".to_string(),
                json_type: None,
                description: None,
                optional: None,
            },
            FieldSpec {
                name: "temperatureCentiCelsius".to_string(),
                solidity_type: "int32".to_string(),
                json_type: None,
                description: None,
                optional: None,
            },
            FieldSpec {
                name: "conditionDescription".to_string(),
                solidity_type: "string".to_string(),
                json_type: None,
                description: None,
                optional: None,
            },
        ];
        let shaped = json!({
            "observationTimestamp": 1741790800u64,
            "temperatureCentiCelsius": 1625,
            "conditionDescription": "partly cloudy"
        });

        let formatter = AbiCallbackFormatter::new();
        let expected = formatter.encode_callback_data(&fields, &shaped).unwrap();
        let planned = build_abi_encoding_plan(&fields, &shaped)
            .unwrap()
            .encode_callback_data();

        assert_eq!(planned, expected);
    }
}
