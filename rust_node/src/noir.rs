use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use ethers::{
    types::{Address, H256, U256},
    utils::keccak256,
};
use serde::Serialize;
use serde_json::Value;
use tokio::{process::Command, time::timeout};
use tracing::info;
use uuid::Uuid;

use crate::{
    format::{AbiEncodingPlan, AbiFieldEncoding},
    primus::recover_attestation_pubkey,
    shape::render_expected_shape_dsl,
    types::{FieldSpec, PreparedProofCommitment, ProofArtifact, ProofJobStatus, ProofJobSummary},
};

pub const PROOF_SCHEME_NOIR: u8 = 3;
pub const NOIR_MAX_FIELDS: usize = 16;
pub const NOIR_MAX_DYNAMIC_BYTES: usize = 256;
pub const NOIR_MAX_CALLBACK_BYTES: usize = 1024;
pub const NOIR_MAX_SHAPE_BYTES: usize = 1024;
pub const NOIR_PREFIX_PUBLIC_INPUTS: usize = 29;

pub const NOIR_MAX_FIELD_NAME_BYTES: usize = 64;
pub const NOIR_MAX_FIELD_TYPE_BYTES: usize = 16;
pub const NOIR_MAX_QUERY_BYTES: usize = 2048;
pub const NOIR_MAX_MODEL_BYTES: usize = 64;
pub const NOIR_MAX_INPUT_DATA_JSON_BYTES: usize = 4096;
pub const NOIR_MAX_OPENAI_BASE_URL_BYTES: usize = 256;
pub const NOIR_MAX_OPENAI_BASE_URL_CHUNKS: usize = (NOIR_MAX_OPENAI_BASE_URL_BYTES + 30) / 31;
pub const NOIR_MAX_OPENAI_ENDPOINT_BYTES: usize = 128;
pub const NOIR_MAX_OPENAI_ENDPOINT_CHUNKS: usize = (NOIR_MAX_OPENAI_ENDPOINT_BYTES + 30) / 31;
pub const NOIR_MAX_RESPONSE_ID_BYTES: usize = 66;
pub const NOIR_MAX_RESPONSE_BODY_BYTES: usize = 8192;

pub const NOIR_MAX_REQUEST_URL_BYTES: usize = 256;
pub const NOIR_MAX_REQUEST_HEADER_BYTES: usize = 1024;
pub const NOIR_MAX_REQUEST_METHOD_BYTES: usize = 8;
pub const NOIR_MAX_REQUEST_BODY_BYTES: usize = 8192;
pub const NOIR_MAX_RESPONSE_KEY_NAME_BYTES: usize = 66;
pub const NOIR_MAX_RESPONSE_PARSE_TYPE_BYTES: usize = 16;
pub const NOIR_MAX_RESPONSE_PARSE_PATH_BYTES: usize = 128;
pub const NOIR_MAX_ATTESTATION_DATA_BYTES: usize = 4096;
pub const NOIR_MAX_ATT_CONDITIONS_BYTES: usize = 2048;
pub const NOIR_MAX_ADDITION_PARAMS_BYTES: usize = 1024;

const NOIR_FIELD_KIND_STATIC: u8 = 0;
const NOIR_FIELD_KIND_DYNAMIC: u8 = 1;
const U128_MASK: U256 = U256([0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0, 0]);

#[derive(Clone, Debug)]
pub struct PrimusAttestationWitness {
    pub attestor_address: Address,
    pub attestor_pubkey_x: [u8; 32],
    pub attestor_pubkey_y: [u8; 32],
    pub signature: [u8; 64],
    pub recipient_address: [u8; 20],
    pub timestamp_millis: u64,
    pub request_url: Vec<u8>,
    pub request_header: Vec<u8>,
    pub request_method: Vec<u8>,
    pub request_body: Vec<u8>,
    pub response_key_name: Vec<u8>,
    pub response_parse_type: Vec<u8>,
    pub response_parse_path: Vec<u8>,
    pub attestation_data: Vec<u8>,
    pub att_conditions: Vec<u8>,
    pub addition_params: Vec<u8>,
    pub response_id: Vec<u8>,
    pub response_body: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct NoirRequestBindingWitness {
    pub expected_shape: String,
    pub query: String,
    pub model: String,
    pub input_data_json: String,
    pub openai_base_url: String,
    pub openai_endpoint: String,
    pub request_url: String,
    pub request_header: String,
    pub request_method: String,
    pub request_body: String,
}

#[derive(Clone, Debug)]
pub struct NoirProofInput {
    pub abi_plan: AbiEncodingPlan,
    pub fields: Vec<FieldSpec>,
    pub request: NoirRequestBindingWitness,
    pub commitment: PreparedProofCommitment,
    pub attestation: PrimusAttestationWitness,
    pub hub_address: Address,
    pub chain_id: u64,
}

#[derive(Clone, Debug)]
pub struct PreparedNoirProof {
    pub callback_data: Vec<u8>,
    pub public_inputs: Vec<U256>,
    pub packed_public_inputs: Vec<u8>,
    witness: NoirWitnessToml,
}

#[derive(Clone)]
pub struct NoirProverService {
    project_dir: PathBuf,
    package_name: String,
    nargo_bin: String,
    bb_bin: String,
    prover_name_prefix: String,
    witness_name_prefix: String,
    timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct GeneratedNoirProof {
    pub artifact: ProofArtifact,
    pub summary: ProofJobSummary,
}

#[derive(Clone, Debug, Serialize)]
struct NoirWitnessToml {
    prefix_public_inputs: Vec<String>,
    url_chunks: Vec<String>,
    endpoint_chunks: Vec<String>,
    hub_address: Vec<u8>,
    chain_id: u64,
    client_address: Vec<u8>,
    bid_id_word: Vec<u8>,
    auto_flow: bool,
    client_version: u64,
    field_count: u32,
    field_name_lengths: Vec<u32>,
    field_names: Vec<Vec<u8>>,
    field_type_lengths: Vec<u32>,
    field_types: Vec<Vec<u8>>,
    field_kinds: Vec<u8>,
    static_words: Vec<Vec<u8>>,
    dynamic_lengths: Vec<u32>,
    dynamic_bytes: Vec<Vec<u8>>,
    query_len: u32,
    query: Vec<u8>,
    model_len: u32,
    model: Vec<u8>,
    input_data_json_len: u32,
    input_data_json: Vec<u8>,
    openai_base_url_len: u32,
    openai_base_url: Vec<u8>,
    openai_endpoint_len: u32,
    openai_endpoint: Vec<u8>,
    attestor_pubkey_x: Vec<u8>,
    attestor_pubkey_y: Vec<u8>,
    attestation_signature: Vec<u8>,
    recipient_address: Vec<u8>,
    attestation_timestamp_millis: u64,
    request_url_len: u32,
    request_url: Vec<u8>,
    request_header_len: u32,
    request_header: Vec<u8>,
    request_method_len: u32,
    request_method: Vec<u8>,
    request_body_len: u32,
    request_body: Vec<u8>,
    response_key_name_len: u32,
    response_key_name: Vec<u8>,
    response_parse_type_len: u32,
    response_parse_type: Vec<u8>,
    response_parse_path_len: u32,
    response_parse_path: Vec<u8>,
    attestation_data_len: u32,
    attestation_data: Vec<u8>,
    att_conditions_len: u32,
    att_conditions: Vec<u8>,
    addition_params_len: u32,
    addition_params: Vec<u8>,
    response_id_len: u32,
    response_id: Vec<u8>,
    response_body_len: u32,
    response_body: Vec<u8>,
}

impl NoirProverService {
    pub fn new(
        project_dir: impl Into<PathBuf>,
        package_name: String,
        nargo_bin: String,
        bb_bin: String,
        prover_name_prefix: String,
        witness_name_prefix: String,
        timeout: Duration,
    ) -> Result<Self> {
        let project_dir = project_dir.into();
        if !project_dir.exists() {
            return Err(anyhow!(
                "Noir project directory does not exist: {}",
                project_dir.display()
            ));
        }

        Ok(Self {
            project_dir,
            package_name,
            nargo_bin,
            bb_bin,
            prover_name_prefix,
            witness_name_prefix,
            timeout,
        })
    }

    pub async fn prove(
        &self,
        bid_id: Option<u64>,
        client: &str,
        input: &PreparedNoirProof,
    ) -> Result<GeneratedNoirProof> {
        let run_id = Uuid::new_v4().simple().to_string();
        let prover_name = format!("{}-{run_id}", self.prover_name_prefix);
        let witness_name = format!("{}-{run_id}", self.witness_name_prefix);
        let prover_path = self.project_dir.join(format!("{prover_name}.toml"));
        let witness_path = self
            .project_dir
            .join("target")
            .join(format!("{witness_name}.gz"));
        let build_artifact = self
            .project_dir
            .join("target")
            .join(format!("{}.json", self.package_name));
        let proof_output_dir = self
            .project_dir
            .join("target")
            .join(format!("proof-{run_id}"));
        fs::create_dir_all(&proof_output_dir)
            .with_context(|| format!("create proof output dir {}", proof_output_dir.display()))?;
        restrict_dir_permissions(&proof_output_dir)?;
        let mut temp_artifacts = NoirTempArtifacts::new(
            vec![prover_path.clone(), witness_path.clone()],
            vec![proof_output_dir.clone()],
        );

        let prover_toml = toml::to_string(&input.witness).context("serialize Noir Prover.toml")?;
        write_private_file(&prover_path, prover_toml.as_bytes())
            .with_context(|| format!("write {}", prover_path.display()))?;

        info!(
            project = %self.project_dir.display(),
            package = %self.package_name,
            witness = %witness_name,
            "Executing Noir witness generation"
        );
        self.run_command(
            &self.nargo_bin,
            &[
                "execute".to_string(),
                "--prover-name".to_string(),
                prover_name.clone(),
                "--force".to_string(),
                witness_name.clone(),
            ],
        )
        .await
        .context("execute Noir circuit")?;
        restrict_file_permissions(&witness_path)?;

        info!(
            artifact = %build_artifact.display(),
            witness = %witness_path.display(),
            "Generating Barretenberg proof"
        );
        self.run_command(
            &self.bb_bin,
            &[
                "prove".to_string(),
                "-b".to_string(),
                build_artifact.display().to_string(),
                "-w".to_string(),
                witness_path.display().to_string(),
                "-o".to_string(),
                proof_output_dir.display().to_string(),
                "--oracle_hash".to_string(),
                "keccak".to_string(),
                "--output_format".to_string(),
                "bytes_and_fields".to_string(),
            ],
        )
        .await
        .context("generate Barretenberg proof")?;

        let proof_path = proof_output_dir.join("proof");
        let public_inputs_path = proof_output_dir.join("public_inputs_fields.json");
        let proof_bytes = fs::read(&proof_path)
            .with_context(|| format!("read proof bytes {}", proof_path.display()))?;
        let public_inputs_raw = fs::read_to_string(&public_inputs_path)
            .with_context(|| format!("read {}", public_inputs_path.display()))?;
        let produced_public_inputs = parse_public_input_fields_json(&public_inputs_raw)
            .context("parse Noir public inputs")?;
        if produced_public_inputs != input.public_inputs {
            return Err(anyhow!(
                "Noir public inputs mismatch: expected {} fields, got {}",
                input.public_inputs.len(),
                produced_public_inputs.len()
            ));
        }

        temp_artifacts.cleanup();

        Ok(GeneratedNoirProof {
            artifact: ProofArtifact {
                proof_bytes_hex: hex_prefixed(&proof_bytes),
                public_values_hex: hex_prefixed(&input.packed_public_inputs),
                verifying_key_hex: "0x".to_string(),
                proof_mode: "local-noir".to_string(),
            },
            summary: ProofJobSummary {
                job_id: format!("noir-{run_id}"),
                bid_id,
                client: client.to_string(),
                status: ProofJobStatus::PendingSubmission,
            },
        })
    }

    async fn run_command(&self, program: &str, args: &[String]) -> Result<()> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&self.project_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = timeout(self.timeout, command.output())
            .await
            .with_context(|| format!("timed out running {program} {}", args.join(" ")))?
            .with_context(|| format!("spawn {program} {}", args.join(" ")))?;

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!(
                "{program} {} failed with status {}.\nstdout:\n{}\nstderr:\n{}",
                args.join(" "),
                output.status,
                stdout.trim(),
                stderr.trim()
            ));
        }

        Ok(())
    }
}

pub fn prepare_noir_proof_input(input: &NoirProofInput) -> Result<PreparedNoirProof> {
    if input.abi_plan.fields.len() > NOIR_MAX_FIELDS {
        return Err(anyhow!(
            "tuple has {} fields, exceeds Noir circuit limit {}",
            input.abi_plan.fields.len(),
            NOIR_MAX_FIELDS
        ));
    }
    if input.fields.len() != input.abi_plan.fields.len() {
        return Err(anyhow!(
            "shape field count {} did not match ABI plan field count {}",
            input.fields.len(),
            input.abi_plan.fields.len()
        ));
    }

    let callback_data = input.abi_plan.encode_callback_data();
    if callback_data.len() > NOIR_MAX_CALLBACK_BYTES {
        return Err(anyhow!(
            "callback payload is {} bytes, exceeds Noir circuit limit {}",
            callback_data.len(),
            NOIR_MAX_CALLBACK_BYTES
        ));
    }

    let callback_hash = H256::from(keccak256(&callback_data));
    if callback_hash != input.commitment.callback_hash {
        return Err(anyhow!(
            "callback hash mismatch before proving: expected {:#x}, got {:#x}",
            input.commitment.callback_hash,
            callback_hash
        ));
    }
    let input_data_hash = H256::from(keccak256(input.request.input_data_json.as_bytes()));
    if input_data_hash != input.commitment.input_data_hash {
        return Err(anyhow!(
            "input data hash mismatch before proving: expected {:#x}, got {:#x}",
            input.commitment.input_data_hash,
            input_data_hash
        ));
    }
    if input.attestation.timestamp_millis / 1000 != input.commitment.request_timestamp {
        return Err(anyhow!(
            "attestation timestamp {}ms did not match commitment request timestamp {}s",
            input.attestation.timestamp_millis,
            input.commitment.request_timestamp
        ));
    }
    ensure_bytes_match(
        "attested request URL",
        &input.attestation.request_url,
        input.request.request_url.as_bytes(),
    )?;
    ensure_bytes_match(
        "attested request header",
        &input.attestation.request_header,
        input.request.request_header.as_bytes(),
    )?;
    ensure_bytes_match(
        "attested request method",
        &input.attestation.request_method,
        input.request.request_method.as_bytes(),
    )?;
    ensure_bytes_match(
        "attested request body",
        &input.attestation.request_body,
        input.request.request_body.as_bytes(),
    )?;
    ensure_hash_matches_public(
        "query",
        input.request.query.as_bytes(),
        input.commitment.query_hash,
    )?;
    ensure_hash_matches_public(
        "model",
        input.request.model.as_bytes(),
        input.commitment.model_hash,
    )?;

    let fulfiller_bytes = address_to_bytes20(input.commitment.fulfiller);
    if input.attestation.recipient_address != fulfiller_bytes {
        return Err(anyhow!(
            "attestation recipient {} did not match commitment fulfiller {}",
            hex_prefixed(&input.attestation.recipient_address),
            input.commitment.fulfiller
        ));
    }

    let rendered_shape = render_expected_shape_dsl(&input.fields)
        .context("render canonical expectedShape from Noir field metadata")?;
    if rendered_shape != input.request.expected_shape {
        return Err(anyhow!(
            "expectedShape witness {:?} did not match canonical field metadata {:?}",
            input.request.expected_shape,
            rendered_shape
        ));
    }
    ensure_hash_matches_public(
        "expectedShape",
        input.request.expected_shape.as_bytes(),
        input.commitment.shape_hash,
    )?;

    let mut field_kinds = [0u8; NOIR_MAX_FIELDS];
    let mut static_words = [[0u8; 32]; NOIR_MAX_FIELDS];
    let mut dynamic_lengths = [0u32; NOIR_MAX_FIELDS];
    let mut dynamic_bytes = [[0u8; NOIR_MAX_DYNAMIC_BYTES]; NOIR_MAX_FIELDS];
    let mut field_name_lengths = [0u32; NOIR_MAX_FIELDS];
    let mut field_names = [[0u8; NOIR_MAX_FIELD_NAME_BYTES]; NOIR_MAX_FIELDS];
    let mut field_type_lengths = [0u32; NOIR_MAX_FIELDS];
    let mut field_types = [[0u8; NOIR_MAX_FIELD_TYPE_BYTES]; NOIR_MAX_FIELDS];

    for (idx, field) in input.abi_plan.fields.iter().enumerate() {
        let schema_field = &input.fields[idx];
        field_name_lengths[idx] = schema_field.name.len() as u32;
        field_names[idx] =
            fit_array::<NOIR_MAX_FIELD_NAME_BYTES>(schema_field.name.as_bytes(), "field_name")?;
        field_type_lengths[idx] = schema_field.solidity_type.len() as u32;
        field_types[idx] = fit_array::<NOIR_MAX_FIELD_TYPE_BYTES>(
            schema_field.solidity_type.as_bytes(),
            "field_type",
        )?;
        match field {
            AbiFieldEncoding::StaticWord(word) => {
                field_kinds[idx] = NOIR_FIELD_KIND_STATIC;
                static_words[idx] = *word;
            }
            AbiFieldEncoding::DynamicBytes(bytes) => {
                if bytes.len() > NOIR_MAX_DYNAMIC_BYTES {
                    return Err(anyhow!(
                        "dynamic field {idx} has {} bytes, exceeds Noir circuit limit {}",
                        bytes.len(),
                        NOIR_MAX_DYNAMIC_BYTES
                    ));
                }
                field_kinds[idx] = NOIR_FIELD_KIND_DYNAMIC;
                dynamic_lengths[idx] = bytes.len() as u32;
                dynamic_bytes[idx][..bytes.len()].copy_from_slice(bytes);
            }
        }
    }

    let (url_chunks, url_chunk_count) = chunk_public_fields::<NOIR_MAX_OPENAI_BASE_URL_CHUNKS>(
        input.request.openai_base_url.as_bytes(),
        "openai base URL",
    )?;
    let (endpoint_chunks, endpoint_chunk_count) =
        chunk_public_fields::<NOIR_MAX_OPENAI_ENDPOINT_CHUNKS>(
            input.request.openai_endpoint.as_bytes(),
            "openai endpoint",
        )?;
    let public_inputs = build_public_inputs(
        &input.commitment,
        input.attestation.attestor_address,
        input.hub_address,
        input.chain_id,
        input.request.openai_base_url.len() as u32,
        url_chunk_count,
        &url_chunks,
        input.request.openai_endpoint.len() as u32,
        endpoint_chunk_count,
        &endpoint_chunks,
    );
    let packed_public_inputs = pack_public_inputs(&public_inputs);
    let prefix_public_inputs = public_inputs[..NOIR_PREFIX_PUBLIC_INPUTS]
        .iter()
        .map(field_to_decimal_string)
        .collect::<Vec<_>>();
    let url_chunks = url_chunks
        .iter()
        .map(field_to_decimal_string)
        .collect::<Vec<_>>();
    let endpoint_chunks = endpoint_chunks
        .iter()
        .map(field_to_decimal_string)
        .collect::<Vec<_>>();
    Ok(PreparedNoirProof {
        callback_data,
        public_inputs,
        packed_public_inputs,
        witness: NoirWitnessToml {
            prefix_public_inputs,
            url_chunks,
            endpoint_chunks,
            hub_address: address_to_bytes20(input.hub_address).to_vec(),
            chain_id: input.chain_id,
            client_address: address_to_bytes20(input.commitment.client).to_vec(),
            bid_id_word: u256_to_bytes32(input.commitment.bid_id).to_vec(),
            auto_flow: input.commitment.auto_flow,
            client_version: input.commitment.client_version,
            field_count: input.abi_plan.fields.len() as u32,
            field_name_lengths: field_name_lengths.to_vec(),
            field_names: field_names.iter().map(|name| name.to_vec()).collect(),
            field_type_lengths: field_type_lengths.to_vec(),
            field_types: field_types.iter().map(|ty| ty.to_vec()).collect(),
            field_kinds: field_kinds.to_vec(),
            static_words: static_words.iter().map(|word| word.to_vec()).collect(),
            dynamic_lengths: dynamic_lengths.to_vec(),
            dynamic_bytes: dynamic_bytes.iter().map(|word| word.to_vec()).collect(),
            query_len: input.request.query.len() as u32,
            query: fit_bytes(
                input.request.query.as_bytes(),
                NOIR_MAX_QUERY_BYTES,
                "query",
            )?,
            model_len: input.request.model.len() as u32,
            model: fit_bytes(
                input.request.model.as_bytes(),
                NOIR_MAX_MODEL_BYTES,
                "model",
            )?,
            input_data_json_len: input.request.input_data_json.len() as u32,
            input_data_json: fit_bytes(
                input.request.input_data_json.as_bytes(),
                NOIR_MAX_INPUT_DATA_JSON_BYTES,
                "input_data_json",
            )?,
            openai_base_url_len: input.request.openai_base_url.len() as u32,
            openai_base_url: fit_bytes(
                input.request.openai_base_url.as_bytes(),
                NOIR_MAX_OPENAI_BASE_URL_BYTES,
                "openai_base_url",
            )?,
            openai_endpoint_len: input.request.openai_endpoint.len() as u32,
            openai_endpoint: fit_bytes(
                input.request.openai_endpoint.as_bytes(),
                NOIR_MAX_OPENAI_ENDPOINT_BYTES,
                "openai_endpoint",
            )?,
            attestor_pubkey_x: input.attestation.attestor_pubkey_x.to_vec(),
            attestor_pubkey_y: input.attestation.attestor_pubkey_y.to_vec(),
            attestation_signature: input.attestation.signature.to_vec(),
            recipient_address: input.attestation.recipient_address.to_vec(),
            attestation_timestamp_millis: input.attestation.timestamp_millis,
            request_url_len: input.attestation.request_url.len() as u32,
            request_url: fit_bytes(
                &input.attestation.request_url,
                NOIR_MAX_REQUEST_URL_BYTES,
                "request_url",
            )?,
            request_header_len: input.attestation.request_header.len() as u32,
            request_header: fit_bytes(
                &input.attestation.request_header,
                NOIR_MAX_REQUEST_HEADER_BYTES,
                "request_header",
            )?,
            request_method_len: input.attestation.request_method.len() as u32,
            request_method: fit_bytes(
                &input.attestation.request_method,
                NOIR_MAX_REQUEST_METHOD_BYTES,
                "request_method",
            )?,
            request_body_len: input.attestation.request_body.len() as u32,
            request_body: fit_bytes(
                &input.attestation.request_body,
                NOIR_MAX_REQUEST_BODY_BYTES,
                "request_body",
            )?,
            response_key_name_len: input.attestation.response_key_name.len() as u32,
            response_key_name: fit_bytes(
                &input.attestation.response_key_name,
                NOIR_MAX_RESPONSE_KEY_NAME_BYTES,
                "response_key_name",
            )?,
            response_parse_type_len: input.attestation.response_parse_type.len() as u32,
            response_parse_type: fit_bytes(
                &input.attestation.response_parse_type,
                NOIR_MAX_RESPONSE_PARSE_TYPE_BYTES,
                "response_parse_type",
            )?,
            response_parse_path_len: input.attestation.response_parse_path.len() as u32,
            response_parse_path: fit_bytes(
                &input.attestation.response_parse_path,
                NOIR_MAX_RESPONSE_PARSE_PATH_BYTES,
                "response_parse_path",
            )?,
            attestation_data_len: input.attestation.attestation_data.len() as u32,
            attestation_data: fit_bytes(
                &input.attestation.attestation_data,
                NOIR_MAX_ATTESTATION_DATA_BYTES,
                "attestation_data",
            )?,
            att_conditions_len: input.attestation.att_conditions.len() as u32,
            att_conditions: fit_bytes(
                &input.attestation.att_conditions,
                NOIR_MAX_ATT_CONDITIONS_BYTES,
                "att_conditions",
            )?,
            addition_params_len: input.attestation.addition_params.len() as u32,
            addition_params: fit_bytes(
                &input.attestation.addition_params,
                NOIR_MAX_ADDITION_PARAMS_BYTES,
                "addition_params",
            )?,
            response_id_len: input.attestation.response_id.len() as u32,
            response_id: fit_bytes(
                &input.attestation.response_id,
                NOIR_MAX_RESPONSE_ID_BYTES,
                "response_id",
            )?,
            response_body_len: input.attestation.response_body.len() as u32,
            response_body: fit_bytes(
                &input.attestation.response_body,
                NOIR_MAX_RESPONSE_BODY_BYTES,
                "response_body",
            )?,
        },
    })
}

pub fn default_noir_project_dir() -> String {
    let candidates = [
        PathBuf::from("noir/flat_tuple"),
        PathBuf::from("rust_node/noir/flat_tuple"),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| PathBuf::from("noir/flat_tuple"))
        .to_string_lossy()
        .to_string()
}

pub fn build_attestation_witness(
    bundle: &crate::types::AttestationBundle,
) -> Result<PrimusAttestationWitness> {
    if bundle.attestation_data.public_data.len() != 1 {
        return Err(anyhow!(
            "Primus attestation bundle must contain exactly one public_data entry; got {}",
            bundle.attestation_data.public_data.len()
        ));
    }
    let public_data = bundle
        .attestation_data
        .public_data
        .first()
        .ok_or_else(|| anyhow!("Primus attestation bundle missing public_data[0]"))?;
    if public_data.attestation.request.len() != 1 {
        return Err(anyhow!(
            "Primus attestation bundle must contain exactly one request; got {}",
            public_data.attestation.request.len()
        ));
    }
    let request = public_data
        .attestation
        .request
        .first()
        .ok_or_else(|| anyhow!("Primus attestation bundle missing request[0]"))?;
    if public_data.attestation.response_resolves.len() != 1 {
        return Err(anyhow!(
            "Primus attestation bundle must contain exactly one response_resolves group; got {}",
            public_data.attestation.response_resolves.len()
        ));
    }
    let response_group = public_data
        .attestation
        .response_resolves
        .first()
        .ok_or_else(|| anyhow!("Primus attestation bundle missing response_resolves[0]"))?;
    if response_group.one_url_response_resolve.len() != 1 {
        return Err(anyhow!(
            "Primus attestation bundle must contain exactly one response resolve; got {}",
            response_group.one_url_response_resolve.len()
        ));
    }
    let response = response_group
        .one_url_response_resolve
        .first()
        .ok_or_else(|| anyhow!("Primus attestation bundle missing response_resolves[0][0]"))?;
    let plain_responses = bundle
        .attestation_data
        .private_data
        .plain_json_response
        .as_ref()
        .ok_or_else(|| {
            anyhow!("Primus attestation bundle missing private_data.plain_json_response")
        })?;
    if plain_responses.len() != 1 {
        return Err(anyhow!(
            "Primus attestation bundle must contain exactly one plain JSON response; got {}",
            plain_responses.len()
        ));
    }
    let plain_response = plain_responses
        .first()
        .ok_or_else(|| anyhow!("Primus attestation bundle plain_json_response is empty"))?;
    let recovered = recover_attestation_pubkey(&public_data.attestation, &public_data.signature)
        .context("recover Primus attestor public key for Noir witness")?;
    let attestor_address = public_data
        .attestor
        .parse::<Address>()
        .context("parse Primus attestor address")?;
    if recovered.address != attestor_address {
        return Err(anyhow!(
            "recovered Primus attestor {} did not match attestation attestor {}",
            recovered.address,
            attestor_address
        ));
    }

    Ok(PrimusAttestationWitness {
        attestor_address,
        attestor_pubkey_x: recovered.public_key_x,
        attestor_pubkey_y: recovered.public_key_y,
        signature: recovered.normalized_signature,
        recipient_address: address_to_bytes20(
            public_data
                .attestation
                .recipient
                .parse::<Address>()
                .context("parse Primus attestation recipient")?,
        ),
        timestamp_millis: public_data.attestation.timestamp,
        request_url: request.url.as_bytes().to_vec(),
        request_header: request.header.as_bytes().to_vec(),
        request_method: request.method.as_bytes().to_vec(),
        request_body: request.body.as_bytes().to_vec(),
        response_key_name: response.key_name.as_bytes().to_vec(),
        response_parse_type: response.parse_type.as_bytes().to_vec(),
        response_parse_path: response.parse_path.as_bytes().to_vec(),
        attestation_data: public_data.attestation.data.as_bytes().to_vec(),
        att_conditions: public_data.attestation.att_conditions.as_bytes().to_vec(),
        addition_params: public_data.attestation.addition_params.as_bytes().to_vec(),
        response_id: plain_response.id.as_bytes().to_vec(),
        response_body: plain_response.content.as_bytes().to_vec(),
    })
}

pub fn write_attestation_log(
    log_dir: impl AsRef<Path>,
    request_id: &str,
    payload: &Value,
) -> Result<PathBuf> {
    let log_dir = log_dir.as_ref();
    fs::create_dir_all(log_dir)
        .with_context(|| format!("create attestation log dir {}", log_dir.display()))?;
    restrict_dir_permissions(log_dir)?;
    let target = log_dir.join(format!("{}.json", safe_log_file_stem(request_id)?));
    let payload = serde_json::to_vec_pretty(payload).context("serialize attestation log")?;
    write_private_file(&target, &payload).with_context(|| format!("write {}", target.display()))?;
    Ok(target)
}

fn build_public_inputs(
    commitment: &PreparedProofCommitment,
    attestor_address: Address,
    hub_address: Address,
    chain_id: u64,
    url_len: u32,
    url_chunk_count: u32,
    url_chunks: &[U256; NOIR_MAX_OPENAI_BASE_URL_CHUNKS],
    endpoint_len: u32,
    endpoint_chunk_count: u32,
    endpoint_chunks: &[U256; NOIR_MAX_OPENAI_ENDPOINT_CHUNKS],
) -> Vec<U256> {
    let mut inputs = Vec::with_capacity(
        NOIR_PREFIX_PUBLIC_INPUTS
            + NOIR_MAX_OPENAI_BASE_URL_CHUNKS
            + NOIR_MAX_OPENAI_ENDPOINT_CHUNKS,
    );
    inputs.push(U256::one());
    push_h256_limbs(&mut inputs, commitment.digest);
    push_u256_limbs(&mut inputs, commitment.bid_id);
    inputs.push(bool_to_u256(commitment.auto_flow));
    inputs.push(address_to_u256(commitment.client));
    inputs.push(address_to_u256(commitment.fulfiller));
    inputs.push(address_to_u256(attestor_address));
    push_h256_limbs(&mut inputs, commitment.query_hash);
    push_h256_limbs(&mut inputs, commitment.shape_hash);
    push_h256_limbs(&mut inputs, commitment.model_hash);
    inputs.push(U256::from(commitment.client_version));
    inputs.push(U256::from(commitment.request_timestamp));
    push_h256_limbs(&mut inputs, commitment.input_data_hash);
    push_h256_limbs(&mut inputs, commitment.response_id);
    push_h256_limbs(&mut inputs, commitment.callback_hash);
    inputs.push(address_to_u256(hub_address));
    inputs.push(U256::from(chain_id));
    inputs.push(U256::from(url_len));
    inputs.push(U256::from(url_chunk_count));
    inputs.push(U256::from(endpoint_len));
    inputs.push(U256::from(endpoint_chunk_count));
    inputs.extend(url_chunks.iter().copied());
    inputs.extend(endpoint_chunks.iter().copied());
    inputs
}

fn chunk_public_fields<const CHUNK_COUNT: usize>(
    raw: &[u8],
    label: &str,
) -> Result<([U256; CHUNK_COUNT], u32)> {
    let mut chunks = [U256::zero(); CHUNK_COUNT];
    let mut chunk_count = 0usize;

    for (idx, chunk) in raw.chunks(31).enumerate() {
        if idx >= CHUNK_COUNT {
            return Err(anyhow!(
                "{label} requires more than {} public chunks",
                CHUNK_COUNT
            ));
        }

        let mut word = [0u8; 32];
        word[1..1 + chunk.len()].copy_from_slice(chunk);
        chunks[idx] = U256::from_big_endian(&word);
        chunk_count = idx + 1;
    }

    if raw.is_empty() {
        chunk_count = 0;
    }

    if chunk_count > CHUNK_COUNT {
        return Err(anyhow!("too many {label} chunks"));
    }

    Ok((chunks, chunk_count as u32))
}

fn push_h256_limbs(target: &mut Vec<U256>, value: H256) {
    let raw = U256::from_big_endian(value.as_bytes());
    push_u256_limbs(target, raw);
}

fn push_u256_limbs(target: &mut Vec<U256>, value: U256) {
    target.push(value >> 128);
    target.push(value & U128_MASK);
}

fn address_to_u256(value: Address) -> U256 {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(value.as_bytes());
    U256::from_big_endian(&word)
}

fn address_to_bytes20(value: Address) -> [u8; 20] {
    let mut out = [0u8; 20];
    out.copy_from_slice(value.as_bytes());
    out
}

fn u256_to_bytes32(value: U256) -> [u8; 32] {
    let mut out = [0u8; 32];
    value.to_big_endian(&mut out);
    out
}

fn bool_to_u256(value: bool) -> U256 {
    if value {
        U256::one()
    } else {
        U256::zero()
    }
}

fn field_to_decimal_string(value: &U256) -> String {
    value.to_string()
}

fn ensure_bytes_match(label: &str, actual: &[u8], expected: &[u8]) -> Result<()> {
    if actual == expected {
        return Ok(());
    }

    Err(anyhow!(
        "{label} mismatch before proving: expected {} bytes hash {:#x}, got {} bytes hash {:#x}",
        expected.len(),
        H256::from(keccak256(expected)),
        actual.len(),
        H256::from(keccak256(actual))
    ))
}

fn ensure_hash_matches_public(label: &str, raw: &[u8], expected: H256) -> Result<()> {
    let actual = H256::from(keccak256(raw));
    if actual == expected {
        return Ok(());
    }

    Err(anyhow!(
        "{label} hash mismatch before proving: expected {:#x}, got {:#x}",
        expected,
        actual
    ))
}

fn fit_bytes(value: &[u8], max_len: usize, label: &str) -> Result<Vec<u8>> {
    if value.len() > max_len {
        return Err(anyhow!(
            "{label} length {} exceeds Noir circuit limit {}",
            value.len(),
            max_len
        ));
    }

    let mut out = vec![0u8; max_len];
    out[..value.len()].copy_from_slice(value);
    Ok(out)
}

fn fit_array<const N: usize>(value: &[u8], label: &str) -> Result<[u8; N]> {
    if value.len() > N {
        return Err(anyhow!(
            "{label} length {} exceeds Noir circuit limit {}",
            value.len(),
            N
        ));
    }

    let mut out = [0u8; N];
    out[..value.len()].copy_from_slice(value);
    Ok(out)
}

fn pack_public_inputs(public_inputs: &[U256]) -> Vec<u8> {
    let mut out = Vec::with_capacity(public_inputs.len() * 32);
    for value in public_inputs {
        let mut word = [0u8; 32];
        value.to_big_endian(&mut word);
        out.extend_from_slice(&word);
    }
    out
}

fn parse_public_input_fields_json(raw: &str) -> Result<Vec<U256>> {
    let values: Vec<String> =
        serde_json::from_str(raw).context("decode public_inputs_fields.json")?;
    values
        .iter()
        .map(|value| parse_public_field(value))
        .collect()
}

fn parse_public_field(raw: &str) -> Result<U256> {
    if let Some(trimmed) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        let bytes =
            hex::decode(trimmed).with_context(|| format!("decode public input hex {raw}"))?;
        Ok(U256::from_big_endian(&bytes))
    } else {
        U256::from_dec_str(raw).with_context(|| format!("parse public input decimal {raw}"))
    }
}

fn hex_prefixed(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn safe_log_file_stem(request_id: &str) -> Result<String> {
    let trimmed = request_id.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("attestation request id cannot be empty"));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(anyhow!(
            "attestation request id contains unsafe path characters"
        ));
    }

    Ok(trimmed.to_string())
}

fn write_private_file(path: &Path, payload: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(payload)?;
        file.sync_all().ok();
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path)?;
        file.write_all(payload)?;
        file.sync_all().ok();
        Ok(())
    }
}

fn restrict_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .with_context(|| format!("restrict permissions on {}", path.display()))?;
        }
    }

    Ok(())
}

fn restrict_dir_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("restrict permissions on {}", path.display()))?;
        }
    }

    Ok(())
}

struct NoirTempArtifacts {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
    cleaned: bool,
}

impl NoirTempArtifacts {
    fn new(files: Vec<PathBuf>, dirs: Vec<PathBuf>) -> Self {
        Self {
            files,
            dirs,
            cleaned: false,
        }
    }

    fn cleanup(&mut self) {
        for file in &self.files {
            let _ = fs::remove_file(file);
        }
        for dir in self.dirs.iter().rev() {
            let _ = fs::remove_dir_all(dir);
        }
        self.cleaned = true;
    }
}

impl Drop for NoirTempArtifacts {
    fn drop(&mut self) {
        if !self.cleaned {
            self.cleanup();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        prepare_noir_proof_input, NoirProofInput, NoirRequestBindingWitness,
        PrimusAttestationWitness, NOIR_MAX_OPENAI_BASE_URL_CHUNKS,
        NOIR_MAX_OPENAI_ENDPOINT_CHUNKS, NOIR_PREFIX_PUBLIC_INPUTS,
    };
    use crate::{
        format::{AbiEncodingPlan, AbiFieldEncoding},
        types::{FieldSpec, PreparedProofCommitment},
    };
    use ethers::types::{Address, H256, U256};
    use ethers::utils::keccak256;

    #[test]
    fn prepares_public_inputs_and_callback_hash() {
        let plan = AbiEncodingPlan {
            fields: vec![
                AbiFieldEncoding::StaticWord([0x11; 32]),
                AbiFieldEncoding::DynamicBytes(b"hello".to_vec()),
            ],
        };
        let input = NoirProofInput {
            abi_plan: plan.clone(),
            fields: vec![
                FieldSpec {
                    name: "first".to_string(),
                    solidity_type: "bytes32".to_string(),
                    json_type: None,
                    description: None,
                    optional: None,
                },
                FieldSpec {
                    name: "second".to_string(),
                    solidity_type: "string".to_string(),
                    json_type: None,
                    description: None,
                    optional: None,
                },
            ],
            request: NoirRequestBindingWitness {
                expected_shape: "tuple(first:bytes32,second:string)".to_string(),
                query: "What is the value?".to_string(),
                model: "gpt-5.4".to_string(),
                input_data_json: "{}".to_string(),
                openai_base_url: "https://api.openai.com/v1".to_string(),
                openai_endpoint: "/chat/completions".to_string(),
                request_url: "https://api.openai.com/v1/chat/completions".to_string(),
                request_header: r#"{"Accept-Encoding":"identity","Authorization":"Bearer test","Content-Type":"application/json"}"#.to_string(),
                request_method: "POST".to_string(),
                request_body: "{}".to_string(),
            },
            commitment: PreparedProofCommitment {
                llm_fulfilled: true,
                digest: H256::from_low_u64_be(1),
                bid_id: U256::from(2),
                auto_flow: true,
                client: Address::from_low_u64_be(3),
                fulfiller: Address::from_low_u64_be(4),
                query_hash: H256::from(keccak256(b"What is the value?")),
                shape_hash: H256::from(keccak256(b"tuple(first:bytes32,second:string)")),
                model_hash: H256::from(keccak256(b"gpt-5.4")),
                input_data_hash: H256::from(keccak256(b"{}")),
                response_id: H256::from_low_u64_be(13),
                client_version: 8,
                request_timestamp: 9,
                callback_hash: H256::from(keccak256(plan.encode_callback_data())),
            },
            attestation: PrimusAttestationWitness {
                attestor_address: Address::from_low_u64_be(12),
                attestor_pubkey_x: [0u8; 32],
                attestor_pubkey_y: [0u8; 32],
                signature: [0u8; 64],
                recipient_address: {
                    let mut out = [0u8; 20];
                    out.copy_from_slice(Address::from_low_u64_be(4).as_bytes());
                    out
                },
                timestamp_millis: 9_000,
                request_url: b"https://api.openai.com/v1/chat/completions".to_vec(),
                request_header: br#"{"Accept-Encoding":"identity","Authorization":"Bearer test","Content-Type":"application/json"}"#.to_vec(),
                request_method: b"POST".to_vec(),
                request_body: b"{}".to_vec(),
                response_key_name: b"0x000000000000000000000000000000000000000000000000000000000000000d".to_vec(),
                response_parse_type: b"json".to_vec(),
                response_parse_path: b"$.choices[0].message.content".to_vec(),
                attestation_data: b"{}".to_vec(),
                att_conditions: Vec::new(),
                addition_params: Vec::new(),
                response_id: b"0x000000000000000000000000000000000000000000000000000000000000000d".to_vec(),
                response_body: br#"{"choices":[{"message":{"content":"{\"second\":\"hello\",\"first\":\"0x1111111111111111111111111111111111111111111111111111111111111111\"}"}}]}"#.to_vec(),
            },
            hub_address: Address::from_low_u64_be(14),
            chain_id: 31337,
        };

        let prepared = prepare_noir_proof_input(&input).unwrap();

        assert_eq!(
            prepared.public_inputs.len(),
            NOIR_PREFIX_PUBLIC_INPUTS
                + NOIR_MAX_OPENAI_BASE_URL_CHUNKS
                + NOIR_MAX_OPENAI_ENDPOINT_CHUNKS
        );
        assert_eq!(prepared.callback_data, plan.encode_callback_data());
        assert_eq!(prepared.public_inputs[0], U256::one());
    }
}
