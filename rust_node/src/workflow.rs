use std::{str::FromStr, sync::Arc};

use anyhow::{anyhow, Context, Result};
use ethers::{
    abi::{encode, Token},
    types::{Address, H256, U256},
    utils::keccak256,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::time::sleep;
use tracing::{error, info, warn};

use crate::{
    config::Config,
    contracts::ContractArtifacts,
    format::{AbiCallbackFormatter, CallbackFormatter},
    primus::{AlgorithmUrls, CommandAlgorithmBridge, HttpAlgorithmBridge, PrimusClient},
    prover::{GeneratedProof, ProverService},
    shape::{build_json_schema, canonical_shape, parse_expected_shape_dsl},
    submission::SubmissionService,
    types::{
        HashCommitments, OracleSpec, PreparedProofCommitment, PreparedProofEnvelope,
        PreparedUpdate, PrimusAttestationData, ProofCommitmentJson, ProofEnvelopeJson,
        ProofProgramInput, ResponseResolveSpec, UpdateEnvelopeJson, UpdateRequest, UpdateResponse,
    },
};

const PROOF_SCHEME_SP1: u8 = 2;

#[derive(Clone)]
pub struct FulfillmentService {
    config: Arc<Config>,
    submission: SubmissionService,
    primus: PrimusClient,
    prover: Arc<ProverService>,
    formatter: Arc<dyn CallbackFormatter>,
}

impl FulfillmentService {
    pub fn new(
        config: Arc<Config>,
        submission: SubmissionService,
        primus: PrimusClient,
        prover: ProverService,
    ) -> Self {
        Self {
            config,
            submission,
            primus,
            prover: Arc::new(prover),
            formatter: Arc::new(AbiCallbackFormatter::new()),
        }
    }

    pub async fn fulfill_request(&self, request: UpdateRequest) -> Result<UpdateResponse> {
        let client = Address::from_str(&request.client).context("parse request client address")?;
        let auto_flow = request.auto_flow.unwrap_or(false);
        let bid_id = request.bid_id;
        if auto_flow && bid_id.is_none() {
            return Err(anyhow!("bidId is required when autoFlow=true"));
        }
        if !auto_flow && bid_id.is_some() {
            return Err(anyhow!("bidId is only valid for auto-flow submissions"));
        }

        self.execute_fulfillment(FulfillmentJob {
            client,
            bid_id,
            auto_flow,
            submit_on_chain: request.submit_on_chain.unwrap_or(false),
            request_timestamp: request.request_timestamp,
            ttl_seconds: request.ttl_seconds,
            nonce_override: request.nonce,
            input_data: request.input_data,
            source: "manual_api".to_string(),
        })
        .await
    }

    pub async fn fulfill_bid(&self, bid_id: u64, client: Address) -> Result<UpdateResponse> {
        self.execute_fulfillment(FulfillmentJob {
            client,
            bid_id: Some(bid_id),
            auto_flow: true,
            submit_on_chain: true,
            request_timestamp: None,
            ttl_seconds: None,
            nonce_override: None,
            input_data: self.config.default_input_data.clone(),
            source: "autofill".to_string(),
        })
        .await
    }

    pub fn submission(&self) -> &SubmissionService {
        &self.submission
    }

    async fn execute_fulfillment(&self, job: FulfillmentJob) -> Result<UpdateResponse> {
        let fulfiller = self.submission.wallet_address();
        let bid_id_value = job.bid_id.unwrap_or_default();
        let label = log_label(job.bid_id, job.client);
        info!(label = %label, source = %job.source, auto_flow = job.auto_flow, submit_on_chain = job.submit_on_chain, "Starting fulfillment job");

        if job.auto_flow {
            let bid = self
                .submission
                .chain()
                .read_bid(U256::from(bid_id_value))
                .await
                .context("read bid")?;
            if !bid.is_open {
                return Err(anyhow!("bid {bid_id_value} is not open"));
            }
            if bid.client != job.client {
                return Err(anyhow!(
                    "bid {bid_id_value} client mismatch: expected {}, got {}",
                    bid.client,
                    job.client
                ));
            }
        }

        let oracle_spec = self
            .submission
            .chain()
            .read_oracle_spec(job.client)
            .await
            .context("read oracle spec")?;
        info!(label = %label, model = %oracle_spec.model, client_version = oracle_spec.client_version, "Loaded oracle spec");

        let fields = parse_expected_shape_dsl(&oracle_spec.expected_shape)
            .with_context(|| format!("parse expectedShape {}", oracle_spec.expected_shape))?;
        let schema = build_json_schema(&fields).context("build JSON schema")?;
        let canonical_shape = canonical_shape(&fields).context("canonicalize expected shape")?;
        info!(label = %label, expected_shape = %oracle_spec.expected_shape, canonical_shape = %canonical_shape, "Derived shaping schema");

        let input_data = merge_input_data(self.config.default_input_data.clone(), job.input_data);
        let openai_model = derive_openai_model(&oracle_spec.model)
            .ok_or_else(|| anyhow!("cannot derive OpenAI model from {}", oracle_spec.model))?;
        let openai_request_body = build_openai_request_body(
            &self.config,
            &openai_model,
            &oracle_spec,
            &input_data,
            &schema,
        )?;
        let request_body_string =
            serde_json::to_string(&openai_request_body).context("serialize OpenAI request body")?;
        let request_body_hash = H256::from(keccak256(request_body_string.as_bytes()));
        info!(
            label = %label,
            model = %openai_model,
            request_body_hash = %request_body_hash,
            web_search = true,
            web_search_context_size = "medium",
            "Prepared attested OpenAI request"
        );

        let api_key = self
            .config
            .openai_api_key
            .as_ref()
            .context("OPENAI_API_KEY is required for fulfillment")?;
        let request_spec = json!({
            "url": format!("{}/chat/completions", self.config.openai_base_url.trim_end_matches('/')),
            "method": "POST",
            "header": {
                "Authorization": format!("Bearer {api_key}"),
                "Content-Type": "application/json"
            },
            "body": openai_request_body,
        });
        let openai_url = format!(
            "{}/chat/completions",
            self.config.openai_base_url.trim_end_matches('/')
        );
        let response_resolves = serde_json::to_value(vec![ResponseResolveSpec {
            key_name: "structured_output".to_string(),
            parse_path: "$.choices[0].message.content".to_string(),
            parse_type: Some("json".to_string()),
            op: None,
        }])?;

        let att_request = self.primus.generate_request_params(
            request_spec,
            response_resolves,
            fulfiller.to_string(),
        );
        info!(label = %label, timeout_secs = self.config.primus_timeout.as_secs(), "Requesting Primus attestation");
        let attestation_bundle = self
            .primus
            .start_attestation(att_request, self.config.primus_timeout)
            .await
            .context("generate Primus attestation")?;
        info!(label = %label, request_id = %attestation_bundle.request_id, "Primus attestation verified");

        let structured_output = extract_structured_output(&attestation_bundle.attestation_data)?;
        validate_structured_output(&fields, &structured_output)?;
        info!(label = %label, structured_output = %structured_output, "Structured output extracted from attestation");

        let callback_data = self
            .formatter
            .encode_callback_data(&fields, &structured_output)
            .context("ABI-encode callback payload")?;
        let callback_hash = H256::from(keccak256(&callback_data));
        info!(label = %label, callback_hash = %callback_hash, callback_size = callback_data.len(), "Callback payload encoded");

        let request_timestamp = job.request_timestamp.unwrap_or_else(now_seconds);
        let expiry = request_timestamp + job.ttl_seconds.unwrap_or(self.config.default_ttl_seconds);
        let query_hash = H256::from(keccak256(oracle_spec.query.as_bytes()));
        let shape_hash = H256::from(keccak256(oracle_spec.expected_shape.as_bytes()));
        let model_hash = H256::from(keccak256(oracle_spec.model.as_bytes()));
        let nonce = match job.nonce_override.as_deref() {
            Some(raw) => parse_u256(raw).with_context(|| format!("parse nonce override {raw}"))?,
            None => derive_nonce(request_timestamp, api_key),
        };

        let prepared_update = PreparedUpdate {
            client: job.client,
            callback_data: callback_data.clone(),
            query_hash,
            shape_hash,
            model_hash,
            client_version: oracle_spec.client_version,
            request_timestamp,
            expiry,
            nonce,
            fulfiller,
        };
        let digest = self
            .submission
            .compute_update_digest(&prepared_update, bid_id_value, job.auto_flow)
            .await
            .context("compute update digest from hub")?;
        info!(label = %label, digest = %digest, nonce = %nonce, request_timestamp, expiry, "Computed hub update digest");

        let commitment = PreparedProofCommitment {
            digest,
            bid_id: U256::from(bid_id_value),
            auto_flow: job.auto_flow,
            client: job.client,
            fulfiller,
            query_hash,
            shape_hash,
            model_hash,
            client_version: oracle_spec.client_version,
            request_timestamp,
            expiry,
            nonce,
            callback_hash,
        };
        let expected_public_values = encode_commitment(&commitment);
        let commitment_json = commitment_json(&commitment);

        let proof_input = ProofProgramInput {
            oracle_spec: oracle_spec.clone(),
            attestation_data_json: attestation_bundle.attestation_data_json.clone(),
            expected_attestor: self.config.primus_attestor_address.clone(),
            allowed_urls: vec![openai_url],
            openai_request_body_json: request_body_string.clone(),
            api_key: api_key.clone(),
            callback_data_hex: hex_prefixed(&callback_data),
            commitment: commitment_json.clone(),
        };

        info!(label = %label, "Requesting SP1 proof generation");
        let GeneratedProof {
            artifact,
            mut summary,
        } = self
            .prover
            .prove(job.bid_id, &job.client.to_string(), &proof_input)
            .await
            .context("generate SP1 proof")?;
        let proof_public_values = decode_hex_prefixed(&artifact.public_values_hex)?;
        if proof_public_values != expected_public_values {
            return Err(anyhow!(
                "proof public values mismatch: expected {} got {}",
                hex_prefixed(&expected_public_values),
                artifact.public_values_hex
            ));
        }
        info!(label = %label, proof_job = %summary.job_id, proof_mode = %artifact.proof_mode, "SP1 proof completed and public values matched expected commitment");

        let prepared_proof = PreparedProofEnvelope {
            scheme: PROOF_SCHEME_SP1,
            public_values: proof_public_values.clone(),
            proof: decode_hex_prefixed(&artifact.proof_bytes_hex)?,
        };

        let mut submission = None;
        if job.submit_on_chain {
            summary.status = crate::types::ProofJobStatus::Submitted;
            submission = Some(if job.auto_flow {
                self.submission
                    .submit_auto_update(bid_id_value, &prepared_update, &prepared_proof)
                    .await
                    .context("submit auto update")?
            } else {
                self.submission
                    .submit_manual_update(&prepared_update, &prepared_proof)
                    .await
                    .context("submit manual update")?
            });
        }

        Ok(UpdateResponse {
            oracle_spec: oracle_spec.clone(),
            expected_shape: oracle_spec.expected_shape.clone(),
            canonical_shape,
            structured_output: structured_output.clone(),
            callback_data: hex_prefixed(&callback_data),
            update: update_json(&prepared_update),
            proof: Some(ProofEnvelopeJson {
                scheme: PROOF_SCHEME_SP1,
                public_values: hex_prefixed(&proof_public_values),
                proof: artifact.proof_bytes_hex.clone(),
            }),
            proof_commitment: Some(commitment_json),
            hash_commitments: HashCommitments {
                query_hash: format!("{query_hash:#x}"),
                shape_hash: format!("{shape_hash:#x}"),
                model_hash: format!("{model_hash:#x}"),
                request_body_hash: format!("{request_body_hash:#x}"),
            },
            attestation: Some(redacted_attestation_value(&attestation_bundle.attestation)?),
            attestation_data: Some(redacted_attestation_data_value(
                &attestation_bundle.attestation_data,
            )?),
            revealed_data: None,
            proof_job: Some(summary),
            submission,
        })
    }
}

#[derive(Clone)]
struct FulfillmentJob {
    client: Address,
    bid_id: Option<u64>,
    auto_flow: bool,
    submit_on_chain: bool,
    request_timestamp: Option<u64>,
    ttl_seconds: Option<u64>,
    nonce_override: Option<String>,
    input_data: Value,
    source: String,
}

pub struct NodeRuntimeParts {
    pub service: Arc<FulfillmentService>,
}

pub struct NodeRuntime {
    config: Arc<Config>,
    parts: NodeRuntimeParts,
}

impl NodeRuntime {
    pub async fn build(config: Config) -> Result<Self> {
        let config = Arc::new(config);
        let artifacts = ContractArtifacts::load(&config.abi_dir)
            .with_context(|| format!("load ABI directory {}", config.abi_dir))?;
        let submission = SubmissionService::from_config(&config, artifacts.clone()).await?;

        let urls = AlgorithmUrls::discover(
            config.primus_base_service_url.clone(),
            config.primus_pado_url.clone(),
            config.primus_proxy_url.clone(),
            config.primus_base_url.clone(),
        )
        .await
        .context("discover Primus algorithm URLs")?;

        let bridge: Arc<dyn crate::primus::AlgorithmBridge> =
            match config.primus_bridge_mode.as_str() {
                "http" => Arc::new(HttpAlgorithmBridge::new(
                    config
                        .primus_bridge_url
                        .clone()
                        .context("PRIMUS_BRIDGE_URL is required when PRIMUS_BRIDGE_MODE=http")?,
                )),
                _ => Arc::new(CommandAlgorithmBridge::new(
                    config.primus_bridge_command.clone(),
                    config.primus_bridge_args.clone(),
                )),
            };

        let primus = PrimusClient::new(
            config.primus_app_id.clone(),
            config.primus_app_secret.clone(),
            Some(&config.primus_attestor_address),
            urls,
            bridge,
            config.primus_quote_base_url.clone(),
            config.primus_mode.clone(),
        )?;

        let prover = ProverService::from_config(&config)?;
        let service = Arc::new(FulfillmentService::new(
            config.clone(),
            submission,
            primus,
            prover,
        ));

        Ok(Self {
            config,
            parts: NodeRuntimeParts { service },
        })
    }

    pub async fn run(self) -> Result<()> {
        let service = self.parts.service.clone();
        let app = crate::server::router(service.clone());
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", self.config.port))
            .await
            .with_context(|| format!("bind HTTP server on port {}", self.config.port))?;

        info!(
            port = self.config.port,
            auto_fulfill = self.config.auto_fulfill,
            "Rust node started"
        );

        let scanner = if self.config.auto_fulfill {
            let service = service.clone();
            let interval = self.config.bid_scan_interval;
            Some(tokio::spawn(async move {
                if let Err(err) = run_bid_scanner(service, interval).await {
                    error!(error = %err, "Bid scanner stopped with error");
                }
            }))
        } else {
            None
        };

        let server = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());
        server.await.context("run HTTP server")?;

        if let Some(handle) = scanner {
            handle.abort();
        }
        Ok(())
    }
}

async fn run_bid_scanner(
    service: Arc<FulfillmentService>,
    interval: std::time::Duration,
) -> Result<()> {
    let mut next_block: Option<u64> = None;

    loop {
        let latest = service.submission().chain().latest_block_number().await?;
        if next_block.is_none() {
            next_block = Some(latest);
            info!(next_block = latest, "Initialized bid scanner baseline");
            sleep(interval).await;
            continue;
        }

        let from_block = next_block.unwrap();
        if latest >= from_block {
            let events = service
                .submission()
                .chain()
                .scan_bid_placed_logs(from_block, latest)
                .await
                .with_context(|| format!("scan BidPlaced logs from {from_block} to {latest}"))?;
            next_block = Some(latest + 1);
            info!(
                from_block,
                to_block = latest,
                bids = events.len(),
                "Scanned hub blocks for bids"
            );

            for event in events {
                let client = match Address::from_str(&event.client) {
                    Ok(value) => value,
                    Err(err) => {
                        warn!(bid_id = event.bid_id, client = %event.client, error = %err, "Skipping bid with invalid client address");
                        continue;
                    }
                };

                match service.fulfill_bid(event.bid_id, client).await {
                    Ok(response) => {
                        info!(bid_id = event.bid_id, digest = %response.proof_commitment.as_ref().map(|c| c.digest.clone()).unwrap_or_default(), "Auto-fulfillment completed")
                    }
                    Err(err) => {
                        warn!(bid_id = event.bid_id, error = %err, "Auto-fulfillment failed")
                    }
                }
            }
        }

        sleep(interval).await;
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn build_openai_request_body(
    config: &Config,
    openai_model: &str,
    oracle_spec: &OracleSpec,
    input_data: &Value,
    schema: &Value,
) -> Result<Value> {
    let system_prompt = concat!(
        "You are an oracle data shaping engine. When a query asks for current or real-time ",
        "information, use web search and prefer direct live observations over forecasts, ",
        "projections, summaries, or stale secondary reporting. Return strict JSON only, ",
        "matching the provided schema exactly."
    );
    let input_data_string = serde_json::to_string(input_data).context("serialize input data")?;
    let schema_string = serde_json::to_string(schema).context("serialize schema")?;
    let context_chars = system_prompt.len()
        + oracle_spec.query.len()
        + input_data_string.len()
        + schema_string.len();
    if context_chars > config.openai_max_context_chars {
        return Err(anyhow!(
            "request context too large: {} > OPENAI_MAX_CONTEXT_CHARS={} (query={} input={} schema={})",
            context_chars,
            config.openai_max_context_chars,
            oracle_spec.query.len(),
            input_data_string.len(),
            schema_string.len(),
        ));
    }

    let user_prompt = format!(
        "Query:\n{}\n\nInput data (JSON):\n{}\n\nReturn only a JSON object that strictly matches the provided schema.",
        oracle_spec.query,
        input_data_string,
    );

    Ok(json!({
        "model": openai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "max_completion_tokens": config.openai_max_completion_tokens,
        "web_search_options": {
            "search_context_size": "medium"
        },
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "thassa_output",
                "strict": true,
                "schema": schema,
            }
        }
    }))
}

fn derive_openai_model(model: &str) -> Option<String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        trimmed
            .strip_prefix("openai:")
            .unwrap_or(trimmed)
            .to_string(),
    )
}

fn merge_input_data(default_input: Value, override_input: Value) -> Value {
    match (default_input, override_input) {
        (Value::Object(mut base), Value::Object(override_map)) => {
            for (key, value) in override_map {
                base.insert(key, value);
            }
            Value::Object(base)
        }
        (base, Value::Null) => base,
        (_, override_value) => override_value,
    }
}

fn extract_structured_output(attestation_data: &PrimusAttestationData) -> Result<Value> {
    let responses = attestation_data
        .private_data
        .plain_json_response
        .as_ref()
        .ok_or_else(|| {
            anyhow!("Primus attestation data missing private_data.plain_json_response")
        })?;
    let first_response = responses
        .first()
        .ok_or_else(|| anyhow!("Primus attestation data plain_json_response is empty"))?;
    let response_json: Value = serde_json::from_str(&first_response.content)
        .with_context(|| format!("decode attested HTTP response {}", first_response.id))?;
    let content = response_json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("attested OpenAI response missing choices[0].message.content"))?;

    serde_json::from_str::<Value>(content)
        .with_context(|| format!("decode structured output JSON string {content}"))
}

fn validate_structured_output(fields: &[crate::types::FieldSpec], shaped: &Value) -> Result<()> {
    let object = shaped
        .as_object()
        .ok_or_else(|| anyhow!("structured output must be a JSON object"))?;

    for field in fields {
        if !object.contains_key(&field.name) {
            return Err(anyhow!("structured output missing field {}", field.name));
        }
    }

    if object.len() != fields.len() {
        let expected: Vec<_> = fields.iter().map(|field| field.name.as_str()).collect();
        return Err(anyhow!(
            "structured output had unexpected fields; expected exactly {:?}, got {:?}",
            expected,
            object.keys().collect::<Vec<_>>()
        ));
    }

    Ok(())
}

fn derive_nonce(request_timestamp: u64, api_key: &str) -> U256 {
    let mut hasher = Sha256::new();
    hasher.update(request_timestamp.to_be_bytes());
    hasher.update(api_key.as_bytes());
    let digest = hasher.finalize();
    U256::from_big_endian(&digest)
}

fn parse_u256(raw: &str) -> Result<U256> {
    if let Some(value) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        let bytes = hex::decode(value).with_context(|| format!("decode hex nonce {raw}"))?;
        Ok(U256::from_big_endian(&bytes))
    } else {
        U256::from_dec_str(raw).with_context(|| format!("parse decimal nonce {raw}"))
    }
}

fn encode_commitment(commitment: &PreparedProofCommitment) -> Vec<u8> {
    encode(&[
        Token::FixedBytes(commitment.digest.as_bytes().to_vec()),
        Token::Uint(commitment.bid_id),
        Token::Bool(commitment.auto_flow),
        Token::Address(commitment.client),
        Token::Address(commitment.fulfiller),
        Token::FixedBytes(commitment.query_hash.as_bytes().to_vec()),
        Token::FixedBytes(commitment.shape_hash.as_bytes().to_vec()),
        Token::FixedBytes(commitment.model_hash.as_bytes().to_vec()),
        Token::Uint(U256::from(commitment.client_version)),
        Token::Uint(U256::from(commitment.request_timestamp)),
        Token::Uint(U256::from(commitment.expiry)),
        Token::Uint(commitment.nonce),
        Token::FixedBytes(commitment.callback_hash.as_bytes().to_vec()),
    ])
}

fn commitment_json(commitment: &PreparedProofCommitment) -> ProofCommitmentJson {
    ProofCommitmentJson {
        digest: format!("{:#x}", commitment.digest),
        bid_id: commitment.bid_id.to_string(),
        auto_flow: commitment.auto_flow,
        client: commitment.client.to_string(),
        fulfiller: commitment.fulfiller.to_string(),
        query_hash: format!("{:#x}", commitment.query_hash),
        shape_hash: format!("{:#x}", commitment.shape_hash),
        model_hash: format!("{:#x}", commitment.model_hash),
        client_version: commitment.client_version,
        request_timestamp: commitment.request_timestamp,
        expiry: commitment.expiry,
        nonce: commitment.nonce.to_string(),
        callback_hash: format!("{:#x}", commitment.callback_hash),
    }
}

fn update_json(update: &PreparedUpdate) -> UpdateEnvelopeJson {
    UpdateEnvelopeJson {
        client: update.client.to_string(),
        callback_data: hex_prefixed(&update.callback_data),
        query_hash: format!("{:#x}", update.query_hash),
        shape_hash: format!("{:#x}", update.shape_hash),
        model_hash: format!("{:#x}", update.model_hash),
        client_version: update.client_version,
        request_timestamp: update.request_timestamp,
        expiry: update.expiry,
        nonce: update.nonce.to_string(),
        fulfiller: update.fulfiller.to_string(),
    }
}

fn decode_hex_prefixed(raw: &str) -> Result<Vec<u8>> {
    let trimmed = raw.trim_start_matches("0x").trim_start_matches("0X");
    hex::decode(trimmed).with_context(|| format!("decode hex value {raw}"))
}

fn hex_prefixed(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn redacted_attestation_value(attestation: &crate::types::Attestation) -> Result<Value> {
    let mut value = serde_json::to_value(attestation)?;
    redact_attestation_request_headers(&mut value);
    Ok(value)
}

fn redacted_attestation_data_value(attestation_data: &PrimusAttestationData) -> Result<Value> {
    let mut value = serde_json::to_value(attestation_data)?;
    if let Some(private_data) = value.get_mut("privateData") {
        *private_data = json!({
            "redacted": true
        });
    }
    if let Some(public_data) = value.get_mut("publicData").and_then(Value::as_array_mut) {
        for item in public_data {
            if let Some(attestation) = item.get_mut("attestation") {
                redact_attestation_request_headers(attestation);
            }
        }
    }
    Ok(value)
}

fn redact_attestation_request_headers(attestation_value: &mut Value) {
    let Some(requests) = attestation_value
        .get_mut("request")
        .and_then(Value::as_array_mut)
    else {
        return;
    };

    for request in requests {
        let Some(header_value) = request.get_mut("header") else {
            continue;
        };
        let Value::String(raw_header) = header_value else {
            continue;
        };

        let Ok(mut parsed) = serde_json::from_str::<Value>(raw_header) else {
            *raw_header = "[REDACTED]".to_string();
            continue;
        };

        let Some(header_map) = parsed.as_object_mut() else {
            *raw_header = "[REDACTED]".to_string();
            continue;
        };

        for (key, value) in header_map.iter_mut() {
            if key.eq_ignore_ascii_case("authorization")
                || key.eq_ignore_ascii_case("x-api-key")
                || key.eq_ignore_ascii_case("api-key")
            {
                *value = Value::String("[REDACTED]".to_string());
            }
        }

        *raw_header = serde_json::to_string(&parsed).unwrap_or_else(|_| "[REDACTED]".to_string());
    }
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn log_label(bid_id: Option<u64>, client: Address) -> String {
    match bid_id {
        Some(bid_id) => format!("bid={} client={}", bid_id, client),
        None => format!("client={}", client),
    }
}
