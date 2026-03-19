use std::{env, path::PathBuf, time::Duration};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

const DEFAULT_PRIMUS_ATTESTOR: &str = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub rpc_url: String,
    pub chain_id: u64,
    pub hub_address: String,
    pub abi_dir: String,
    pub node_private_key: String,
    pub auto_fulfill: bool,
    pub bid_scan_interval: Duration,
    pub request_timeout: Duration,
    pub primus_timeout: Duration,
    pub sp1_timeout: Duration,
    pub sp1_poll_interval: Duration,
    pub default_model: String,
    pub default_client_version: u64,
    pub default_ttl_seconds: u64,
    pub default_input_data: Value,
    pub openai_api_key: Option<String>,
    pub openai_base_url: String,
    pub openai_max_context_chars: usize,
    pub openai_max_completion_tokens: u32,
    pub primus_app_id: String,
    pub primus_app_secret: String,
    pub primus_base_service_url: String,
    pub primus_quote_base_url: String,
    pub primus_bridge_mode: String,
    pub primus_bridge_command: String,
    pub primus_bridge_args: Vec<String>,
    pub primus_bridge_url: Option<String>,
    pub primus_mode: String,
    pub primus_pado_url: Option<String>,
    pub primus_proxy_url: Option<String>,
    pub primus_base_url: Option<String>,
    pub primus_attestor_address: String,
    pub sp1_prover_mode: String,
    pub sp1_private_key: Option<String>,
    pub sp1_rpc_url: Option<String>,
    pub sp1_elf_path: Option<String>,
}

impl Config {
    pub fn load() -> Result<Self> {
        load_dotenv(".env");

        let default_input_data = parse_json_value(
            env::var("AUTO_FULFILL_INPUT_DATA_JSON").unwrap_or_else(|_| "{}".to_string()),
        )
        .context("parse AUTO_FULFILL_INPUT_DATA_JSON")?;

        let primus_bridge_args = {
            let configured = parse_list("PRIMUS_BRIDGE_ARGS");
            if configured.is_empty() {
                default_bridge_args()
            } else {
                configured
            }
        };

        Ok(Self {
            port: parse_env("PORT", 8080)?,
            rpc_url: required("THASSA_RPC_URL")?,
            chain_id: parse_env("DEFAULT_CHAIN_ID", 31337)?,
            hub_address: required("DEFAULT_THASSA_HUB")?,
            abi_dir: env::var("ABI_DIR").unwrap_or_else(|_| "abi".to_string()),
            node_private_key: required("NODE_PRIVATE_KEY")?,
            auto_fulfill: parse_env("AUTO_FULFILL_BIDS", true)?,
            bid_scan_interval: Duration::from_secs(parse_env("BID_SCAN_INTERVAL_SECONDS", 2)?),
            request_timeout: Duration::from_secs(parse_env("REQUEST_TIMEOUT_SECONDS", 45)?),
            primus_timeout: Duration::from_secs(parse_env("PRIMUS_TIMEOUT_SECONDS", 240)?),
            sp1_timeout: Duration::from_secs(parse_env("SP1_TIMEOUT_SECONDS", 900)?),
            sp1_poll_interval: Duration::from_secs(parse_env("SP1_POLL_INTERVAL_SECONDS", 10)?),
            default_model: env::var("OPENAI_MODEL")
                .unwrap_or_else(|_| "openai:gpt-5.4".to_string()),
            default_client_version: parse_env("DEFAULT_CLIENT_VERSION", 1)?,
            default_ttl_seconds: parse_env("DEFAULT_TTL_SECONDS", 3600)?,
            default_input_data,
            openai_api_key: optional("OPENAI_API_KEY"),
            openai_base_url: env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            openai_max_context_chars: parse_env("OPENAI_MAX_CONTEXT_CHARS", 16_000usize)?,
            openai_max_completion_tokens: parse_env("OPENAI_MAX_COMPLETION_TOKENS", 1_200u32)?,
            primus_app_id: required("PRIMUS_APP_ID")?,
            primus_app_secret: required("PRIMUS_APP_SECRET")?,
            primus_base_service_url: env::var("PRIMUS_BASE_SERVICE_URL")
                .unwrap_or_else(|_| "https://api.padolabs.org".to_string()),
            primus_quote_base_url: env::var("PRIMUS_QUOTE_BASE_URL")
                .unwrap_or_else(|_| "https://api.padolabs.org".to_string()),
            primus_bridge_mode: env::var("PRIMUS_BRIDGE_MODE")
                .unwrap_or_else(|_| "command".to_string()),
            primus_bridge_command: env::var("PRIMUS_BRIDGE_COMMAND")
                .unwrap_or_else(|_| "node".to_string()),
            primus_bridge_args,
            primus_bridge_url: optional("PRIMUS_BRIDGE_URL"),
            primus_mode: env::var("PRIMUS_ALGORITHM_MODE").unwrap_or_else(|_| "auto".to_string()),
            primus_pado_url: optional("PRIMUS_PADO_URL"),
            primus_proxy_url: optional("PRIMUS_PROXY_URL"),
            primus_base_url: optional("PRIMUS_ALGO_BASE_URL"),
            primus_attestor_address: env::var("PRIMUS_ATTESTOR_ADDRESS")
                .unwrap_or_else(|_| DEFAULT_PRIMUS_ATTESTOR.to_string()),
            sp1_prover_mode: env::var("SP1_PROVER").unwrap_or_else(|_| "network".to_string()),
            sp1_private_key: optional("NETWORK_PRIVATE_KEY"),
            sp1_rpc_url: optional("NETWORK_RPC_URL"),
            sp1_elf_path: optional("SP1_ELF_PATH").or_else(default_sp1_elf_path),
        })
    }
}

fn load_dotenv(path: &str) {
    dotenvy::from_filename(path).ok();
}

fn required(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("{key} is required"))
}

fn optional(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn parse_env<T>(key: &str, default_value: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(key) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .parse::<T>()
            .map_err(|err| anyhow!("invalid {key}: {err}")),
        _ => Ok(default_value),
    }
}

fn parse_list(key: &str) -> Vec<String> {
    env::var(key)
        .ok()
        .map(|raw| {
            raw.split_whitespace()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_json_value(raw: String) -> Result<Value> {
    serde_json::from_str::<Value>(&raw).context("invalid JSON value")
}

fn default_bridge_args() -> Vec<String> {
    let candidates = [
        PathBuf::from("bridge/primus_bridge.cjs"),
        PathBuf::from("rust_node/bridge/primus_bridge.cjs"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return vec![candidate.to_string_lossy().to_string()];
        }
    }

    vec!["bridge/primus_bridge.cjs".to_string()]
}

fn default_sp1_elf_path() -> Option<String> {
    let candidates = [
        PathBuf::from("artifacts/thassa-zkvm-program.elf"),
        PathBuf::from("rust_node/artifacts/thassa-zkvm-program.elf"),
        PathBuf::from("artifacts/thassa-program.elf"),
        PathBuf::from("rust_node/artifacts/thassa-program.elf"),
        PathBuf::from("zkvm/program/elf/riscv32im-succinct-zkvm-elf/release/thassa-zkvm-program"),
        PathBuf::from(
            "rust_node/zkvm/program/elf/riscv32im-succinct-zkvm-elf/release/thassa-zkvm-program",
        ),
        PathBuf::from("program/elf/riscv32im-succinct-zkvm-elf/release/thassa-program"),
        PathBuf::from("rust_node/program/elf/riscv32im-succinct-zkvm-elf/release/thassa-program"),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.to_string_lossy().to_string())
}
