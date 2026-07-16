use std::{str::FromStr, sync::Arc};

use anyhow::{anyhow, Context, Result};
use ethers::{
    abi::{encode, Token},
    types::{Address, H256, U256},
    utils::keccak256,
};
use serde_json::{json, Value};
use tokio::time::sleep;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    config::Config,
    contracts::ContractArtifacts,
    format::build_abi_encoding_plan,
    noir::{
        build_attestation_witness, prepare_noir_proof_input, write_attestation_log, NoirProofInput,
        NoirRequestBindingWitness, PROOF_SCHEME_NOIR,
    },
    primus::{AlgorithmUrls, CommandAlgorithmBridge, HttpAlgorithmBridge, PrimusClient},
    prover::{GeneratedProof, ProofRequest, ProverService},
    shape::{
        build_json_schema, canonical_shape, parse_expected_shape_dsl, render_expected_shape_dsl,
    },
    submission::SubmissionService,
    types::{
        HashCommitments, OracleSpec, PreparedProofCommitment, PreparedProofEnvelope,
        PreparedUpdate, PrimusAttestationData, ProofCommitmentJson, ProofEnvelopeJson,
        ProofProgramInput, ResponseResolveSpec, UpdateEnvelopeJson, UpdateRequest, UpdateResponse,
    },
};

const OPENAI_CHAT_COMPLETIONS_ENDPOINT: &str = "/chat/completions";
const REQUIRED_OPENAI_CONTEXT_CHARS: usize = 10_000;
const OPENAI_REQUEST_METHOD: &str = "POST";

#[derive(Clone)]
pub struct FulfillmentService {
    config: Arc<Config>,
    submission: SubmissionService,
    primus: PrimusClient,
    prover: Arc<ProverService>,
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
        let mut bid_input_data_hash = None;
        let mut response_id = H256::zero();
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
            bid_input_data_hash = Some(bid.input_data_hash);
            response_id = bid.response_id;
        }

        let oracle_spec = self
            .submission
            .chain()
            .read_oracle_spec(job.client)
            .await
            .context("read oracle spec")?;
        let proof_scheme = self.prover.scheme();
        info!(label = %label, model = %oracle_spec.model, client_version = oracle_spec.client_version, "Loaded oracle spec");
        if proof_scheme == PROOF_SCHEME_NOIR
            && job.submit_on_chain
            && !self.config.noir_onchain_submission_enabled
        {
            return Err(anyhow!(
                "Noir on-chain submission is disabled; set NOIR_ONCHAIN_SUBMISSION_ENABLED=true only after deploying and validating the ThassaNoirVerifier module"
            ));
        }

        let fields = parse_expected_shape_dsl(&oracle_spec.expected_shape)
            .with_context(|| format!("parse expectedShape {}", oracle_spec.expected_shape))?;
        let normalized_expected_shape =
            render_expected_shape_dsl(&fields).context("render normalized expectedShape")?;
        if proof_scheme == PROOF_SCHEME_NOIR
            && normalized_expected_shape != oracle_spec.expected_shape
        {
            return Err(anyhow!(
                "Noir backend requires canonical exact expectedShape; onchain value {:?} normalizes to {:?}",
                oracle_spec.expected_shape,
                normalized_expected_shape
            ));
        }
        let schema = build_json_schema(&fields).context("build JSON schema")?;
        let canonical_shape = canonical_shape(&fields).context("canonicalize expected shape")?;
        info!(label = %label, expected_shape = %oracle_spec.expected_shape, canonical_shape = %canonical_shape, "Derived shaping schema");

        let input_data = merge_input_data(self.config.default_input_data.clone(), job.input_data);
        let input_data_string =
            serde_json::to_string(&input_data).context("serialize input data JSON")?;
        let input_data_hash = H256::from(keccak256(input_data_string.as_bytes()));
        if let Some(expected) = bid_input_data_hash {
            if expected != input_data_hash {
                return Err(anyhow!(
                    "bid input data hash mismatch: expected {expected:#x}, got {input_data_hash:#x}"
                ));
            }
        }
        if !job.auto_flow {
            response_id = H256::from(keccak256(Uuid::new_v4().as_bytes()));
        }
        let response_id_string = format!("{response_id:#x}");
        let openai_model = derive_openai_model(&oracle_spec.model)
            .ok_or_else(|| anyhow!("cannot derive OpenAI model from {}", oracle_spec.model))?;
        let noir_model_witness = if proof_scheme == PROOF_SCHEME_NOIR {
            Some(derive_noir_model_witness(
                &oracle_spec.model,
                &openai_model,
            )?)
        } else {
            None
        };
        let openai_base_url = self
            .config
            .openai_base_url
            .trim_end_matches('/')
            .to_string();
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
        let openai_request_header = build_openai_request_header(api_key);
        let request_header_string = serde_json::to_string(&openai_request_header)
            .context("serialize OpenAI request header")?;
        let request_spec = json!({
            "url": format!("{openai_base_url}{OPENAI_CHAT_COMPLETIONS_ENDPOINT}"),
            "method": OPENAI_REQUEST_METHOD,
            "header": openai_request_header,
            "body": openai_request_body,
        });
        let openai_url = format!("{openai_base_url}{OPENAI_CHAT_COMPLETIONS_ENDPOINT}");
        let response_resolves = serde_json::to_value(vec![ResponseResolveSpec {
            key_name: response_id_string.clone(),
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
        persist_attestation_log(&self.config, &label, &attestation_bundle)?;

        let structured_output = extract_structured_output(&attestation_bundle.attestation_data)?;
        validate_structured_output(&fields, &structured_output)?;
        info!(label = %label, structured_output = %structured_output, "Structured output extracted from attestation");

        let abi_plan = build_abi_encoding_plan(&fields, &structured_output)
            .context("build ABI tuple plan from structured output")?;
        let callback_data = abi_plan.encode_callback_data();
        let callback_hash = H256::from(keccak256(&callback_data));
        info!(label = %label, callback_hash = %callback_hash, callback_size = callback_data.len(), "Callback payload encoded");

        let verified_request_timestamp = attestation_bundle.attestation.timestamp / 1000;
        if let Some(request_timestamp) = job.request_timestamp {
            if request_timestamp != verified_request_timestamp {
                return Err(anyhow!(
                    "requested timestamp {} did not match attested Primus timestamp {}",
                    request_timestamp,
                    verified_request_timestamp
                ));
            }
        }

        let request_timestamp = verified_request_timestamp;
        let query_hash = H256::from(keccak256(oracle_spec.query.as_bytes()));
        let shape_hash = H256::from(keccak256(oracle_spec.expected_shape.as_bytes()));
        let model_hash = H256::from(keccak256(oracle_spec.model.as_bytes()));

        let prepared_update = PreparedUpdate {
            client: job.client,
            callback_data: callback_data.clone(),
            input_data: input_data_string.as_bytes().to_vec(),
            response_id,
            query_hash,
            shape_hash,
            model_hash,
            client_version: oracle_spec.client_version,
            request_timestamp,
            fulfiller,
        };
        let digest = self
            .submission
            .compute_update_digest(&prepared_update, bid_id_value, job.auto_flow)
            .await
            .context("compute update digest from hub")?;
        info!(label = %label, digest = %digest, input_data_hash = %input_data_hash, response_id = %response_id, request_timestamp, "Computed hub update digest");

        let commitment = PreparedProofCommitment {
            llm_fulfilled: true,
            digest,
            bid_id: U256::from(bid_id_value),
            auto_flow: job.auto_flow,
            client: job.client,
            fulfiller,
            query_hash,
            shape_hash,
            model_hash,
            input_data_hash,
            response_id,
            client_version: oracle_spec.client_version,
            request_timestamp,
            callback_hash,
        };
        let expected_public_values = encode_commitment(&commitment);
        let commitment_json = commitment_json(&commitment);
        let (proof_request, expected_public_values) = if proof_scheme == PROOF_SCHEME_NOIR {
            let attestation_witness = build_attestation_witness(&attestation_bundle)
                .context("build Primus attestation witness for Noir")?;
            let noir_input = prepare_noir_proof_input(&NoirProofInput {
                abi_plan: abi_plan.clone(),
                fields: fields.clone(),
                request: NoirRequestBindingWitness {
                    expected_shape: normalized_expected_shape.clone(),
                    query: oracle_spec.query.clone(),
                    model: noir_model_witness
                        .clone()
                        .context("missing Noir model witness")?,
                    input_data_json: input_data_string.clone(),
                    openai_base_url: openai_base_url.clone(),
                    openai_endpoint: OPENAI_CHAT_COMPLETIONS_ENDPOINT.to_string(),
                    request_url: openai_url.clone(),
                    request_header: request_header_string.clone(),
                    request_method: OPENAI_REQUEST_METHOD.to_string(),
                    request_body: request_body_string.clone(),
                },
                commitment: commitment.clone(),
                attestation: attestation_witness,
                hub_address: self.submission.chain().hub_address,
                chain_id: self.config.chain_id,
            })
            .context("prepare Noir witness/public inputs")?;
            let expected_public_values = noir_input.packed_public_inputs.clone();
            (
                ProofRequest {
                    sp1_input: None,
                    noir_input: Some(noir_input),
                },
                expected_public_values,
            )
        } else {
            let proof_input = ProofProgramInput {
                oracle_spec: oracle_spec.clone(),
                attestation_data_json: attestation_bundle.attestation_data_json.clone(),
                expected_attestor: self.config.primus_attestor_address.clone(),
                allowed_urls: vec![openai_url],
                input_data_json: input_data_string.clone(),
                openai_request_body_json: request_body_string.clone(),
                callback_data_hex: hex_prefixed(&callback_data),
                commitment: commitment_json.clone(),
            };
            (
                ProofRequest {
                    sp1_input: Some(proof_input),
                    noir_input: None,
                },
                expected_public_values,
            )
        };

        info!(label = %label, backend = %self.prover.backend_label(), "Requesting proof generation");
        let GeneratedProof {
            artifact,
            mut summary,
        } = self
            .prover
            .prove(job.bid_id, &job.client.to_string(), &proof_request)
            .await
            .with_context(|| format!("generate {} proof", self.prover.backend_label()))?;
        let proof_public_values = decode_hex_prefixed(&artifact.public_values_hex)?;
        if proof_public_values != expected_public_values {
            return Err(anyhow!(
                "proof public values mismatch: expected {} got {}",
                hex_prefixed(&expected_public_values),
                artifact.public_values_hex
            ));
        }
        info!(
            label = %label,
            proof_job = %summary.job_id,
            proof_mode = %artifact.proof_mode,
            backend = %self.prover.backend_label(),
            "Proof completed and public values matched expected commitment"
        );

        let prepared_proof = PreparedProofEnvelope {
            scheme: proof_scheme,
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
                scheme: proof_scheme,
                public_values: hex_prefixed(&proof_public_values),
                proof: artifact.proof_bytes_hex.clone(),
            }),
            proof_commitment: Some(commitment_json),
            hash_commitments: HashCommitments {
                query_hash: format!("{query_hash:#x}"),
                shape_hash: format!("{shape_hash:#x}"),
                model_hash: format!("{model_hash:#x}"),
                input_data_hash: format!("{input_data_hash:#x}"),
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
        if is_noir_backend(&config.proof_backend) && config.noir_onchain_submission_enabled {
            let expected_attestor = Address::from_str(&config.primus_attestor_address)
                .context("parse PRIMUS_ATTESTOR_ADDRESS")?;
            submission
                .ensure_noir_verifier_ready(expected_attestor)
                .await
                .context("validate Noir on-chain verifier gate")?;
        }

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
            let backfill_blocks = self.config.bid_scan_backfill_blocks;
            let max_block_range = self.config.bid_scan_max_block_range.max(1);
            let max_attempts = self.config.bid_fulfillment_max_attempts.max(1);
            Some(tokio::spawn(async move {
                if let Err(err) = run_bid_scanner(
                    service,
                    interval,
                    backfill_blocks,
                    max_block_range,
                    max_attempts,
                )
                .await
                {
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
    backfill_blocks: u64,
    max_block_range: u64,
    max_attempts: u32,
) -> Result<()> {
    let mut next_block: Option<u64> = None;

    loop {
        let latest = match service.submission().chain().latest_block_number().await {
            Ok(latest) => latest,
            Err(err) => {
                warn!(error = %err, "Bid scanner failed to read latest block; will retry");
                sleep(interval).await;
                continue;
            }
        };
        if next_block.is_none() {
            let start = latest.saturating_sub(backfill_blocks);
            next_block = Some(start);
            info!(
                latest,
                next_block = start,
                backfill_blocks,
                "Initialized bid scanner baseline"
            );
        }

        let from_block = next_block.unwrap();
        if latest >= from_block {
            let to_block = latest.min(from_block.saturating_add(max_block_range - 1));
            let events = match service
                .submission()
                .chain()
                .scan_bid_placed_logs(from_block, to_block)
                .await
            {
                Ok(events) => events,
                Err(err) => {
                    warn!(
                        from_block,
                        to_block,
                        error = %err,
                        "Bid scanner log scan failed; keeping cursor for retry"
                    );
                    sleep(interval).await;
                    continue;
                }
            };
            next_block = to_block.checked_add(1);
            info!(
                from_block,
                to_block,
                latest,
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

                match fulfill_bid_with_retries(
                    &service,
                    event.bid_id,
                    client,
                    max_attempts,
                    interval,
                )
                .await
                {
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

async fn fulfill_bid_with_retries(
    service: &FulfillmentService,
    bid_id: u64,
    client: Address,
    max_attempts: u32,
    retry_delay: std::time::Duration,
) -> Result<UpdateResponse> {
    let mut attempt = 1;
    loop {
        match service.fulfill_bid(bid_id, client).await {
            Ok(response) => return Ok(response),
            Err(err) if attempt < max_attempts => {
                warn!(
                    bid_id,
                    attempt,
                    max_attempts,
                    error = %err,
                    "Auto-fulfillment attempt failed; retrying"
                );
                attempt += 1;
                sleep(retry_delay).await;
            }
            Err(err) => return Err(err),
        }
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn build_openai_request_header(api_key: &str) -> Value {
    json!({
        "Accept-Encoding": "identity",
        "Authorization": format!("Bearer {api_key}"),
        "Content-Type": "application/json"
    })
}

fn build_openai_request_body(
    config: &Config,
    openai_model: &str,
    oracle_spec: &OracleSpec,
    input_data: &Value,
    schema: &Value,
) -> Result<Value> {
    if config.openai_max_context_chars != REQUIRED_OPENAI_CONTEXT_CHARS {
        return Err(anyhow!(
            "OPENAI_MAX_CONTEXT_CHARS must be {} for the current attested request policy; got {}",
            REQUIRED_OPENAI_CONTEXT_CHARS,
            config.openai_max_context_chars
        ));
    }

    let input_data_string = serde_json::to_string(input_data).context("serialize input data")?;
    let schema_string = serde_json::to_string(schema).context("serialize schema")?;
    let context_chars = oracle_spec.query.len() + input_data_string.len() + schema_string.len();
    if context_chars > REQUIRED_OPENAI_CONTEXT_CHARS {
        return Err(anyhow!(
            "request context too large: {} > OPENAI_MAX_CONTEXT_CHARS={} (query={} input={} schema={})",
            context_chars,
            REQUIRED_OPENAI_CONTEXT_CHARS,
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
            {"role": "user", "content": user_prompt}
        ],
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

fn derive_noir_model_witness(model_spec: &str, openai_model: &str) -> Result<String> {
    let trimmed_spec = model_spec.trim();
    if trimmed_spec.is_empty() {
        return Err(anyhow!("Noir backend requires a non-empty oracle model spec"));
    }

    let derived_openai_model = derive_openai_model(trimmed_spec)
        .ok_or_else(|| anyhow!("cannot derive OpenAI model from Noir model spec {trimmed_spec:?}"))?;
    if derived_openai_model != openai_model {
        return Err(anyhow!(
            "Noir model witness mismatch: oracle spec {:?} derives OpenAI model {:?}, but request builder selected {:?}",
            trimmed_spec,
            derived_openai_model,
            openai_model,
        ));
    }

    Ok(trimmed_spec.to_string())
}

fn is_noir_backend(proof_backend: &str) -> bool {
    proof_backend.trim().eq_ignore_ascii_case("noir")
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

fn encode_commitment(commitment: &PreparedProofCommitment) -> Vec<u8> {
    encode(&[
        Token::Bool(commitment.llm_fulfilled),
        Token::FixedBytes(commitment.digest.as_bytes().to_vec()),
        Token::Uint(commitment.bid_id),
        Token::Bool(commitment.auto_flow),
        Token::Address(commitment.client),
        Token::Address(commitment.fulfiller),
        Token::FixedBytes(commitment.query_hash.as_bytes().to_vec()),
        Token::FixedBytes(commitment.shape_hash.as_bytes().to_vec()),
        Token::FixedBytes(commitment.model_hash.as_bytes().to_vec()),
        Token::FixedBytes(commitment.input_data_hash.as_bytes().to_vec()),
        Token::FixedBytes(commitment.response_id.as_bytes().to_vec()),
        Token::Uint(U256::from(commitment.client_version)),
        Token::Uint(U256::from(commitment.request_timestamp)),
        Token::FixedBytes(commitment.callback_hash.as_bytes().to_vec()),
    ])
}

fn commitment_json(commitment: &PreparedProofCommitment) -> ProofCommitmentJson {
    ProofCommitmentJson {
        llm_fulfilled: commitment.llm_fulfilled,
        digest: format!("{:#x}", commitment.digest),
        bid_id: commitment.bid_id.to_string(),
        auto_flow: commitment.auto_flow,
        client: commitment.client.to_string(),
        fulfiller: commitment.fulfiller.to_string(),
        query_hash: format!("{:#x}", commitment.query_hash),
        shape_hash: format!("{:#x}", commitment.shape_hash),
        model_hash: format!("{:#x}", commitment.model_hash),
        input_data_hash: format!("{:#x}", commitment.input_data_hash),
        response_id: format!("{:#x}", commitment.response_id),
        client_version: commitment.client_version,
        request_timestamp: commitment.request_timestamp,
        callback_hash: format!("{:#x}", commitment.callback_hash),
    }
}

fn update_json(update: &PreparedUpdate) -> UpdateEnvelopeJson {
    UpdateEnvelopeJson {
        client: update.client.to_string(),
        callback_data: hex_prefixed(&update.callback_data),
        input_data: hex_prefixed(&update.input_data),
        response_id: format!("{:#x}", update.response_id),
        query_hash: format!("{:#x}", update.query_hash),
        shape_hash: format!("{:#x}", update.shape_hash),
        model_hash: format!("{:#x}", update.model_hash),
        client_version: update.client_version,
        request_timestamp: update.request_timestamp,
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

fn persist_attestation_log(
    config: &Config,
    label: &str,
    bundle: &crate::types::AttestationBundle,
) -> Result<()> {
    let mode = config.attestation_log_mode.trim().to_ascii_lowercase();
    match mode.as_str() {
        "" | "redacted" => {
            let payload = redacted_attestation_bundle_value(bundle)?;
            let path =
                write_attestation_log(&config.attestation_log_dir, &bundle.request_id, &payload)
                    .with_context(|| {
                        format!(
                            "persist redacted Primus attestation log {}",
                            bundle.request_id
                        )
                    })?;
            info!(
                label = %label,
                request_id = %bundle.request_id,
                path = %path.display(),
                "Stored redacted Primus attestation bundle"
            );
        }
        "full" => {
            let payload = serde_json::to_value(bundle)?;
            let path =
                write_attestation_log(&config.attestation_log_dir, &bundle.request_id, &payload)
                    .with_context(|| {
                        format!("persist full Primus attestation log {}", bundle.request_id)
                    })?;
            warn!(
                label = %label,
                request_id = %bundle.request_id,
                path = %path.display(),
                "Stored full unredacted Primus attestation bundle"
            );
        }
        "off" | "none" | "disabled" => {
            info!(
                label = %label,
                request_id = %bundle.request_id,
                "Primus attestation bundle logging disabled"
            );
        }
        other => {
            return Err(anyhow!(
                "unsupported ATTESTATION_LOG_MODE {other:?}; expected redacted, full, or off"
            ));
        }
    }

    Ok(())
}

fn redacted_attestation_bundle_value(bundle: &crate::types::AttestationBundle) -> Result<Value> {
    let mut value = serde_json::to_value(bundle)?;
    redact_secret_keys_recursive(&mut value);

    if let Some(attestation_data_json) = value.get_mut("attestationDataJson") {
        *attestation_data_json = Value::String("[REDACTED]".to_string());
    }
    if let Some(private_data) = value
        .get_mut("attestationData")
        .and_then(|data| data.get_mut("privateData"))
    {
        *private_data = json!({
            "redacted": true
        });
    }
    if let Some(encoded_data) = value
        .get_mut("attestationResult")
        .and_then(|result| result.get_mut("content"))
        .and_then(|content| content.get_mut("encodedData"))
    {
        *encoded_data = Value::String("[REDACTED]".to_string());
    }
    let sign_params = value
        .get_mut("attestationParams")
        .and_then(|params| params.get_mut("appParameters"))
        .and_then(|app| app.get_mut("appSignParameters"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    if let Some(sign_params) = sign_params {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&sign_params) {
            redact_secret_keys_recursive(&mut parsed);
            if let Some(target) = value
                .get_mut("attestationParams")
                .and_then(|params| params.get_mut("appParameters"))
                .and_then(|app| app.get_mut("appSignParameters"))
            {
                *target = Value::String(
                    serde_json::to_string(&parsed).unwrap_or_else(|_| "[REDACTED]".to_string()),
                );
            }
        }
    }

    Ok(value)
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

fn redact_secret_keys_recursive(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_secret_header_key(key) {
                    *child = Value::String("[REDACTED]".to_string());
                    continue;
                }

                if key.eq_ignore_ascii_case("header") {
                    redact_header_string(child);
                } else {
                    redact_secret_keys_recursive(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_secret_keys_recursive(item);
            }
        }
        _ => {}
    }
}

fn redact_header_string(value: &mut Value) {
    let Value::String(raw) = value else {
        redact_secret_keys_recursive(value);
        return;
    };

    let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    redact_secret_keys_recursive(&mut parsed);
    *raw = serde_json::to_string(&parsed).unwrap_or_else(|_| "[REDACTED]".to_string());
}

fn is_secret_header_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("authorization")
        || key.eq_ignore_ascii_case("x-api-key")
        || key.eq_ignore_ascii_case("api-key")
}

fn log_label(bid_id: Option<u64>, client: Address) -> String {
    match bid_id {
        Some(bid_id) => format!("bid={} client={}", bid_id, client),
        None => format!("client={}", client),
    }
}
