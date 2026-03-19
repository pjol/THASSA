use std::{
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use ethers::{
    abi::{encode_packed, Token},
    signers::{LocalWallet, Signer},
    types::{Address, Signature, H256},
    utils::keccak256,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;

use crate::types::{
    AlgorithmParams, AttMode, AttRequest, Attestation, AttestationBundle, AttestationResult,
    PrimusAttestationData, PrimusOneUrlResponseResolve, PrimusRequestData, PrimusResponseResolve,
    SignedAttRequest,
};

const DEFAULT_PADO_ATTESTOR: &str = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

#[derive(Clone, Debug)]
pub struct AlgorithmUrls {
    pub primus_mpc_url: String,
    pub primus_proxy_url: String,
    pub proxy_url: String,
    pub base_service_url: String,
}

impl AlgorithmUrls {
    pub async fn discover(
        base_service_url: impl Into<String>,
        primus_mpc_url: Option<String>,
        primus_proxy_url: Option<String>,
        proxy_url: Option<String>,
    ) -> Result<Self> {
        let base_service_url = base_service_url.into();
        if let (Some(primus_mpc_url), Some(primus_proxy_url), Some(proxy_url)) = (
            primus_mpc_url.clone(),
            primus_proxy_url.clone(),
            proxy_url.clone(),
        ) {
            return Ok(Self {
                primus_mpc_url,
                primus_proxy_url,
                proxy_url,
                base_service_url,
            });
        }

        let fallback = Self {
            primus_mpc_url: primus_mpc_url
                .unwrap_or_else(|| "wss://api2.padolabs.org/algorithm".to_string()),
            primus_proxy_url: primus_proxy_url
                .unwrap_or_else(|| "wss://api2.padolabs.org/algorithm-proxy".to_string()),
            proxy_url: proxy_url.unwrap_or_else(|| "wss://api2.padolabs.org/algoproxy".to_string()),
            base_service_url: base_service_url.clone(),
        };

        let client = Client::new();
        let response = client
            .get(format!(
                "{}/public/algo/nodes",
                base_service_url.trim_end_matches('/')
            ))
            .send()
            .await;

        let Ok(response) = response else {
            return Ok(fallback);
        };
        if !response.status().is_success() {
            return Ok(fallback);
        }

        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(_) => return Ok(fallback),
        };

        let Some(first) = payload
            .get("result")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            return Ok(fallback);
        };

        let Some(algorithm_domain) = first.get("algorithmDomain").and_then(Value::as_str) else {
            return Ok(fallback);
        };
        let Some(algo_proxy_domain) = first.get("algoProxyDomain").and_then(Value::as_str) else {
            return Ok(fallback);
        };

        Ok(Self {
            primus_mpc_url: format!("wss://{algorithm_domain}/algorithm"),
            primus_proxy_url: format!("wss://{algorithm_domain}/algorithm-proxy"),
            proxy_url: format!("wss://{algo_proxy_domain}/algoproxy"),
            base_service_url,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInvocation {
    pub method: String,
    pub version: String,
    pub params: Value,
}

#[async_trait]
pub trait AlgorithmBridge: Send + Sync {
    async fn call(&self, invocation: &BridgeInvocation) -> Result<Value>;
}

#[derive(Clone)]
pub struct HttpAlgorithmBridge {
    client: Client,
    endpoint: String,
}

impl HttpAlgorithmBridge {
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            endpoint: endpoint.into(),
        }
    }
}

#[async_trait]
impl AlgorithmBridge for HttpAlgorithmBridge {
    async fn call(&self, invocation: &BridgeInvocation) -> Result<Value> {
        let response = self
            .client
            .post(&self.endpoint)
            .json(invocation)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "algorithm bridge HTTP {} for {}",
                response.status(),
                invocation.method
            ));
        }
        Ok(response.json::<Value>().await?)
    }
}

#[derive(Clone)]
pub struct CommandAlgorithmBridge {
    command: PathBuf,
    args: Vec<String>,
}

impl CommandAlgorithmBridge {
    pub fn new(command: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Self {
            command: command.into(),
            args,
        }
    }
}

#[async_trait]
impl AlgorithmBridge for CommandAlgorithmBridge {
    async fn call(&self, invocation: &BridgeInvocation) -> Result<Value> {
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawn Primus bridge command {}", self.command.display()))?;

        if let Some(mut stdin) = child.stdin.take() {
            let payload = serde_json::to_vec(invocation)?;
            tokio::io::AsyncWriteExt::write_all(&mut stdin, &payload).await?;
            tokio::io::AsyncWriteExt::shutdown(&mut stdin).await?;
        }

        let output = child.wait_with_output().await?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(anyhow!(
                "Primus bridge command exited with {}{}",
                output.status,
                if stdout.is_empty() {
                    String::new()
                } else {
                    format!(": {stdout}")
                }
            ));
        }

        Ok(serde_json::from_slice::<Value>(&output.stdout)?)
    }
}

#[derive(Clone)]
pub struct PrimusClient {
    app_id: String,
    app_secret: LocalWallet,
    expected_attestor: Address,
    urls: AlgorithmUrls,
    bridge: Arc<dyn AlgorithmBridge>,
    http: Client,
    quote_base_url: String,
    default_mode: String,
}

impl PrimusClient {
    pub fn new(
        app_id: impl Into<String>,
        app_secret: impl AsRef<str>,
        expected_attestor: Option<&str>,
        urls: AlgorithmUrls,
        bridge: Arc<dyn AlgorithmBridge>,
        quote_base_url: impl Into<String>,
        default_mode: impl Into<String>,
    ) -> Result<Self> {
        let expected_attestor = expected_attestor
            .unwrap_or(DEFAULT_PADO_ATTESTOR)
            .parse::<Address>()
            .context("parse Primus attestor address")?;

        Ok(Self {
            app_id: app_id.into(),
            app_secret: app_secret
                .as_ref()
                .parse::<LocalWallet>()
                .context("parse PRIMUS_APP_SECRET as secp256k1 private key")?,
            expected_attestor,
            urls,
            bridge,
            http: Client::new(),
            quote_base_url: quote_base_url.into(),
            default_mode: default_mode.into(),
        })
    }

    pub fn generate_request_params(
        &self,
        request: Value,
        response_resolves: Value,
        user_address: impl Into<String>,
    ) -> AttRequest {
        AttRequest {
            app_id: self.app_id.clone(),
            request: Some(request),
            response_resolves: Some(response_resolves),
            user_address: user_address.into(),
            timestamp: now_ms(),
            att_mode: AttMode {
                algorithm_type: self.default_mode.clone(),
                result_type: "plain".to_string(),
            },
            att_conditions: None,
            addition_params: None,
            ssl_cipher: Some("ECDHE-RSA-AES128-GCM-SHA256".to_string()),
            no_proxy: true,
            request_interval: Some(-1),
        }
    }

    pub async fn check_app_quote(&self) -> Result<()> {
        let url = format!(
            "{}/public/app/quote",
            self.quote_base_url.trim_end_matches('/')
        );

        let response = self
            .http
            .get(url)
            .query(&[("appId", &self.app_id)])
            .send()
            .await
            .context("request Primus app quote")?;

        if !response.status().is_success() {
            warn!("Primus app quote check returned HTTP {}", response.status());
            return Ok(());
        }

        let payload: Value = response
            .json()
            .await
            .context("parse Primus app quote payload")?;

        let rc = payload.get("rc").and_then(Value::as_i64).unwrap_or(-1);
        if rc != 0 {
            warn!("Primus app quote payload returned non-zero rc: {payload}");
        }

        let Some(result) = payload.get("result") else {
            return Err(anyhow!("Primus app quote response missing result"));
        };

        let expiry_time = result.get("expiryTime").and_then(Value::as_i64);
        let remaining_quota = result.get("remainingQuota").and_then(Value::as_i64);

        if expiry_time.is_none() && remaining_quota.unwrap_or_default() <= 0 {
            return Err(anyhow!(
                "Primus app quote rejected: no expiryTime and no remaining quota"
            ));
        }

        if let Some(expiry_time) = expiry_time {
            let now_ms = now_ms() as i64;
            if expiry_time < now_ms {
                return Err(anyhow!(
                    "Primus app quote expired at {expiry_time}, now {now_ms}"
                ));
            }
            if remaining_quota.unwrap_or_default() <= 0 {
                return Err(anyhow!("Primus app quote rejected: no remaining quota"));
            }
        }

        Ok(())
    }

    pub async fn sign(&self, sign_params: &str) -> Result<SignedAttRequest> {
        let message_hash_hex = format!("0x{}", hex::encode(keccak256(sign_params.as_bytes())));
        let signature = self
            .app_secret
            .sign_message(message_hash_hex.as_bytes())
            .await
            .context("sign Primus attestation request")?;

        Ok(SignedAttRequest {
            att_request: serde_json::from_str(sign_params).context("parse signed AttRequest")?,
            app_signature: signature.to_string(),
        })
    }

    pub fn assemble_params(
        &self,
        signed: &SignedAttRequest,
        algorithm_urls: &AlgorithmUrls,
    ) -> Result<AlgorithmParams> {
        let request_value = signed
            .att_request
            .request
            .clone()
            .ok_or_else(|| anyhow!("Primus request payload missing request"))?;

        let first_request = match &request_value {
            Value::Array(items) => items
                .first()
                .ok_or_else(|| anyhow!("Primus request array cannot be empty"))?,
            Value::Object(_) => &request_value,
            _ => return Err(anyhow!("Primus request payload must be object or array")),
        };

        let request_url = first_request
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Primus request missing url"))?;
        let parsed_url = Url::parse(request_url).context("parse Primus request URL")?;
        let host_name = parsed_url
            .host_str()
            .ok_or_else(|| anyhow!("Primus request URL missing host"))?
            .to_string();
        let host = match parsed_url.port() {
            Some(port) => format!("{host_name}:{port}"),
            None => host_name,
        };

        let request_id = Uuid::new_v4().to_string();
        let timestamp = now_ms().to_string();
        let (pado_url, mut proxy_url, model_type) =
            match signed.att_request.att_mode.algorithm_type.as_str() {
                "mpctls" => (
                    algorithm_urls.primus_mpc_url.clone(),
                    algorithm_urls.proxy_url.clone(),
                    "mpctls".to_string(),
                ),
                _ => (
                    algorithm_urls.primus_proxy_url.clone(),
                    algorithm_urls.proxy_url.clone(),
                    "proxytls".to_string(),
                ),
            };

        if signed.att_request.no_proxy && model_type == "mpctls" {
            proxy_url.clear();
        }

        Ok(AlgorithmParams {
            source: "source".to_string(),
            requestid: request_id,
            pado_url,
            proxy_url,
            get_data_time: timestamp,
            cred_version: "1.0.5".to_string(),
            model_type,
            user: json!({
                "userid": "0",
                "address": signed.att_request.user_address,
                "token": ""
            }),
            auth_userid_hash: String::new(),
            app_parameters: json!({
                "appId": signed.att_request.app_id,
                "appSignParameters": serde_json::to_string(&signed.att_request)?,
                "appSignature": signed.app_signature,
                "additionParams": signed.att_request.addition_params.clone().unwrap_or_default()
            }),
            req_type: "web".to_string(),
            host,
            requests: Some(assemble_request_value(&request_value)?),
            responses: Some(assemble_response_value(
                signed
                    .att_request
                    .response_resolves
                    .clone()
                    .unwrap_or(Value::Null),
                signed.att_request.att_conditions.clone(),
            )?),
            template_id: Some(String::new()),
            pado_server_url: None,
            pado_extension_version: Some("0.3.21".to_string()),
            cipher: signed.att_request.ssl_cipher.clone(),
            request_interval_ms: signed.att_request.request_interval.map(|v| v.to_string()),
        })
    }

    pub async fn start_attestation(
        &self,
        att_request: AttRequest,
        timeout: Duration,
    ) -> Result<AttestationBundle> {
        self.check_app_quote().await?;

        let sign_params = serde_json::to_string(&att_request)?;
        let signed = self.sign(&sign_params).await?;
        let attestation_params = self.assemble_params(&signed, &self.urls)?;
        info!(
            request_id = %attestation_params.requestid,
            host = %attestation_params.host,
            "Primus request assembled"
        );

        let poll = self
            .bridge
            .call(&BridgeInvocation {
                method: "attest".to_string(),
                version: "1.1.1".to_string(),
                params: json!({
                    "mode": self.default_mode.clone(),
                    "attestationParams": serde_json::to_value(&attestation_params)?,
                    "timeoutMs": timeout.as_millis(),
                }),
            })
            .await
            .context("Primus bridge attest")?;

        let retcode = poll
            .get("retcode")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if retcode == "2" {
            return Err(anyhow!("Primus attestation failed: {poll}"));
        }

        if retcode != "0" {
            return Err(anyhow!(
                "Primus bridge returned unexpected retcode {retcode}: {poll}"
            ));
        }

        let attestation_result: AttestationResult =
            serde_json::from_value(poll.clone()).context("parse Primus attestation result")?;
        let content = attestation_result
            .content
            .as_ref()
            .ok_or_else(|| anyhow!("Primus attestation result missing content"))?;
        if content.signature.as_deref().unwrap_or_default().is_empty() {
            return Err(anyhow!(
                "Primus attestation result missing content.signature"
            ));
        }
        if content
            .balance_greater_than_base_value
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("false"))
        {
            return Err(anyhow!(
                "Primus attestation result reported balanceGreaterThanBaseValue=false"
            ));
        }
        let attestation_data_json = content
            .encoded_data
            .clone()
            .ok_or_else(|| anyhow!("Primus attestation result missing content.encodedData"))?;
        let attestation_data: PrimusAttestationData = serde_json::from_str(&attestation_data_json)
            .context("decode Primus encodedData into attestation data")?;
        let public_data = attestation_data
            .public_data
            .first()
            .ok_or_else(|| anyhow!("Primus attestation data missing public_data[0]"))?;
        let attestor = public_data
            .attestor
            .parse::<Address>()
            .context("parse Primus public_data attestor address")?;
        if attestor != self.expected_attestor {
            return Err(anyhow!(
                "Primus attestation attestor {} did not match expected {}",
                public_data.attestor,
                self.expected_attestor
            ));
        }
        if content.signature.as_deref() != Some(public_data.signature.as_str()) {
            return Err(anyhow!(
                "Primus content.signature did not match encodedData public_data[0].signature"
            ));
        }
        if !self
            .verify_attestation_signature(&public_data.attestation, &public_data.signature)
            .context("verify Primus attestation signature")?
        {
            return Err(anyhow!(
                "Primus attestation signature did not match expected attestor"
            ));
        }

        Ok(AttestationBundle {
            request_id: attestation_params.requestid.clone(),
            attestation_params: serde_json::to_value(&attestation_params)?,
            attestation_result: poll,
            attestation_data_json,
            attestation_data: attestation_data.clone(),
            attestation: public_data.attestation.clone(),
        })
    }

    pub fn verify_attestation_signature(
        &self,
        attestation: &Attestation,
        signature_hex: &str,
    ) -> Result<bool> {
        let encoded = encode_attestation(attestation)?;
        let signature = signature_hex
            .parse::<Signature>()
            .context("parse attestation signature")?;
        let recovered = signature
            .recover(H256::from(keccak256(&encoded)))
            .context("recover attestation signer")?;
        Ok(recovered == self.expected_attestor)
    }
}

fn assemble_request_value(request: &Value) -> Result<Value> {
    match request {
        Value::Object(obj) => Ok(Value::Array(vec![json!({
            "url": obj.get("url").and_then(Value::as_str).unwrap_or_default(),
            "method": obj.get("method").and_then(Value::as_str).unwrap_or_default(),
            "headers": normalize_headers(obj.get("header")),
            "body": obj.get("body").cloned().unwrap_or(Value::Null),
            "name": format!("{}-0", obj.get("url").and_then(Value::as_str).unwrap_or_default()),
        })])),
        Value::Array(items) => {
            let mut outputs = Vec::with_capacity(items.len());
            for (idx, item) in items.iter().enumerate() {
                let obj = item
                    .as_object()
                    .ok_or_else(|| anyhow!("request array entries must be objects"))?;
                let url = obj.get("url").and_then(Value::as_str).unwrap_or_default();
                outputs.push(json!({
                    "url": url,
                    "method": obj.get("method").and_then(Value::as_str).unwrap_or_default(),
                    "headers": normalize_headers(obj.get("header")),
                    "body": obj.get("body").cloned().unwrap_or(Value::Null),
                    "name": format!("{url}-{idx}"),
                }));
            }
            Ok(Value::Array(outputs))
        }
        _ => Err(anyhow!("request must be an object or array")),
    }
}

fn assemble_response_value(
    response_resolves: Value,
    att_conditions: Option<Value>,
) -> Result<Value> {
    let groups = if response_resolves
        .as_array()
        .and_then(|items| items.first())
        .map(Value::is_array)
        .unwrap_or(false)
    {
        response_resolves
            .as_array()
            .cloned()
            .ok_or_else(|| anyhow!("responseResolves must be an array"))?
    } else {
        vec![response_resolves]
    };

    let mut outputs = Vec::with_capacity(groups.len());
    for (idx, group) in groups.iter().enumerate() {
        let items = group
            .as_array()
            .ok_or_else(|| anyhow!("responseResolves group must be an array"))?;
        let conditions = att_conditions
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|all| all.get(idx))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut subconditions = Vec::with_capacity(items.len());
        for item in items {
            let key_name = item
                .get("keyName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let parse_path = item
                .get("parsePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let matching = conditions.iter().find(|cond| {
                cond.get("field")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    == key_name
            });
            let op = matching
                .and_then(|cond| cond.get("op").and_then(Value::as_str))
                .unwrap_or("");
            let value = matching
                .and_then(|cond| cond.get("value").and_then(Value::as_str))
                .unwrap_or_default();

            subconditions.push(json!({
                "field": get_field(parse_path, op),
                "reveal_id": key_name,
                "op": get_op(op),
                "type": get_type(op),
                "value": value,
            }));
        }

        outputs.push(json!({
            "conditions": {
                "type": "CONDITION_EXPANSION",
                "op": "BOOLEAN_AND",
                "subconditions": subconditions,
            }
        }));
    }

    Ok(Value::Array(outputs))
}

fn normalize_headers(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => {
            let mut map = map.clone();
            map.insert(
                "Accept-Encoding".to_string(),
                Value::String("identity".to_string()),
            );
            Value::Object(map)
        }
        Some(other) => json!({
            "value": other,
            "Accept-Encoding": "identity"
        }),
        None => json!({ "Accept-Encoding": "identity" }),
    }
}

fn get_field(parse_path: &str, op: &str) -> Value {
    if op == "SHA256_EX" {
        json!({ "type": "FIELD_ARITHMETIC", "op": "SHA256", "field": parse_path })
    } else {
        Value::String(parse_path.to_string())
    }
}

fn get_op(op: &str) -> String {
    if op == "SHA256_EX" {
        "REVEAL_HEX_STRING".to_string()
    } else if op.is_empty() {
        "REVEAL_STRING".to_string()
    } else {
        op.to_string()
    }
}

fn get_type(op: &str) -> String {
    if matches!(
        op,
        ">" | ">=" | "=" | "!=" | "<" | "<=" | "STREQ" | "STRNEQ"
    ) {
        "FIELD_RANGE".to_string()
    } else if op == "SHA256" {
        "FIELD_VALUE".to_string()
    } else {
        "FIELD_REVEAL".to_string()
    }
}

fn encode_attestation(attestation: &Attestation) -> Result<Vec<u8>> {
    let request_hash = hash_request(&attestation.request)?;
    let response_hash = hash_response(&attestation.response_resolves)?;

    encode_packed(&[
        Token::Address(
            attestation
                .recipient
                .parse::<Address>()
                .context("parse attestation recipient")?,
        ),
        Token::FixedBytes(request_hash.as_bytes().to_vec()),
        Token::FixedBytes(response_hash.as_bytes().to_vec()),
        Token::String(attestation.data.clone()),
        Token::String(attestation.att_conditions.clone()),
        Token::Uint(attestation.timestamp.into()),
        Token::String(attestation.addition_params.clone()),
    ])
    .context("encode attestation")
}

fn hash_request(requests: &[PrimusRequestData]) -> Result<H256> {
    if requests.is_empty() {
        return Err(anyhow!("attestation request cannot be empty"));
    }

    if requests.len() == 1 {
        return Ok(H256::from(keccak256(encode_request(&requests[0])?)));
    }

    let mut packed = Vec::new();
    for request in requests {
        packed.extend(encode_request(request)?);
    }
    Ok(H256::from(keccak256(packed)))
}

fn hash_response(response_groups: &[PrimusOneUrlResponseResolve]) -> Result<H256> {
    if response_groups.is_empty() {
        return Err(anyhow!("attestation responseResolves cannot be empty"));
    }

    if response_groups.len() == 1 {
        return Ok(H256::from(keccak256(encode_response_group(
            &response_groups[0],
        )?)));
    }

    let mut packed = Vec::new();
    for group in response_groups {
        packed.extend(encode_response_group(group)?);
    }
    Ok(H256::from(keccak256(packed)))
}

fn encode_request(request: &PrimusRequestData) -> Result<Vec<u8>> {
    encode_packed(&[
        Token::String(request.url.clone()),
        Token::String(request.header.clone()),
        Token::String(request.method.clone()),
        Token::String(request.body.clone()),
    ])
    .context("encode Primus request object")
}

fn encode_response_group(group: &PrimusOneUrlResponseResolve) -> Result<Vec<u8>> {
    let mut packed = Vec::new();
    for response in &group.one_url_response_resolve {
        packed.extend(encode_response(response)?);
    }
    Ok(packed)
}

fn encode_response(response: &PrimusResponseResolve) -> Result<Vec<u8>> {
    encode_packed(&[
        Token::String(response.key_name.clone()),
        Token::String(response.parse_type.clone()),
        Token::String(response.parse_path.clone()),
    ])
    .context("encode Primus responseResolve entry")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}
