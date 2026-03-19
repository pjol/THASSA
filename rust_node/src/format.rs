use anyhow::{anyhow, Result};
use ethers::abi::{encode, Token};
use ethers::types::Address;
use serde_json::Value;

use crate::shape::validate_fields;
use crate::types::FieldSpec;

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
        validate_fields(fields)?;
        let object = shaped
            .as_object()
            .ok_or_else(|| anyhow!("shaped output must be a JSON object"))?;

        let mut tokens = Vec::with_capacity(fields.len());
        for field in fields {
            let value = object
                .get(&field.name)
                .ok_or_else(|| anyhow!("missing shaped field {}", field.name))?;
            tokens.push(coerce_token(&field.solidity_type, value)?);
        }

        Ok(encode(&tokens))
    }
}

fn coerce_token(solidity_type: &str, value: &Value) -> Result<Token> {
    let ty = solidity_type.trim().to_lowercase();
    match ty.as_str() {
        "string" => Ok(Token::String(value_to_string(value)?)),
        "bool" => Ok(Token::Bool(value_to_bool(value)?)),
        "address" => Ok(Token::Address(value_to_address(value)?)),
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
        _ if ty.starts_with("int") => Ok(Token::Int(value_to_int(value)?.into_raw())),
        _ => Err(anyhow!("unsupported ABI type: {solidity_type}")),
    }
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
