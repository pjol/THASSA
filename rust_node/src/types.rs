use ethers::types::{Address, H256, U256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use thassa_zkvm_lib::{OracleSpec, ProofCommitmentJson, ProofProgramInput};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpec {
    pub name: String,
    pub solidity_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub url: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseResolveSpec {
    pub key_name: String,
    pub parse_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttMode {
    pub algorithm_type: String,
    #[serde(default = "default_result_type")]
    pub result_type: String,
}

fn default_result_type() -> String {
    "plain".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttRequest {
    pub app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_resolves: Option<Value>,
    pub user_address: String,
    pub timestamp: u64,
    pub att_mode: AttMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub att_conditions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addition_params: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_cipher: Option<String>,
    #[serde(default)]
    pub no_proxy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_interval: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedAttRequest {
    pub att_request: AttRequest,
    pub app_signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgorithmParams {
    pub source: String,
    pub requestid: String,
    #[serde(rename = "padoUrl")]
    pub pado_url: String,
    #[serde(rename = "proxyUrl")]
    pub proxy_url: String,
    #[serde(rename = "getdatatime")]
    pub get_data_time: String,
    #[serde(rename = "credVersion")]
    pub cred_version: String,
    #[serde(rename = "modelType")]
    pub model_type: String,
    pub user: Value,
    #[serde(rename = "authUseridHash")]
    pub auth_userid_hash: String,
    #[serde(rename = "appParameters")]
    pub app_parameters: Value,
    #[serde(rename = "reqType")]
    pub req_type: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses: Option<Value>,
    #[serde(rename = "templateId", skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(rename = "PADOSERVERURL", skip_serializing_if = "Option::is_none")]
    pub pado_server_url: Option<String>,
    #[serde(
        rename = "padoExtensionVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub pado_extension_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cipher: Option<String>,
    #[serde(rename = "requestIntervalMs", skip_serializing_if = "Option::is_none")]
    pub request_interval_ms: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusRequestData {
    pub url: String,
    pub header: String,
    pub method: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusResponseResolve {
    pub key_name: String,
    pub parse_type: String,
    pub parse_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusOneUrlResponseResolve {
    pub one_url_response_resolve: Vec<PrimusResponseResolve>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attestation {
    pub recipient: String,
    pub request: Vec<PrimusRequestData>,
    pub response_resolves: Vec<PrimusOneUrlResponseResolve>,
    pub data: String,
    pub att_conditions: String,
    pub timestamp: u64,
    pub addition_params: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusPublicData {
    pub attestation: Attestation,
    pub attestor: String,
    pub signature: String,
    pub report_tx_hash: String,
    pub task_id: String,
    pub attestation_time: u64,
    pub attestor_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusPlainJsonResponse {
    pub id: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusPrivateData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aes_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plain_json_response: Option<Vec<PrimusPlainJsonResponse>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimusAttestationData {
    pub verification_type: String,
    pub public_data: Vec<PrimusPublicData>,
    pub private_data: PrimusPrivateData,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationContent {
    pub balance_greater_than_base_value: Option<String>,
    pub signature: Option<String>,
    pub encoded_data: Option<String>,
    pub extra_data: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationResult {
    pub retcode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<AttestationContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationBundle {
    pub request_id: String,
    pub attestation_params: Value,
    pub attestation_result: Value,
    pub attestation_data_json: String,
    pub attestation_data: PrimusAttestationData,
    pub attestation: Attestation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BidPlacedEvent {
    pub bid_id: u64,
    pub requester: String,
    pub client: String,
    pub amount: String,
    pub tx_hash: String,
    pub block_number: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub client: String,
    #[serde(default)]
    pub bid_id: Option<u64>,
    #[serde(default)]
    pub auto_flow: Option<bool>,
    #[serde(default)]
    pub submit_on_chain: Option<bool>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    #[serde(default)]
    pub request_timestamp: Option<u64>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub input_data: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofEnvelopeJson {
    pub scheme: u8,
    pub public_values: String,
    pub proof: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEnvelopeJson {
    pub client: String,
    pub callback_data: String,
    pub query_hash: String,
    pub shape_hash: String,
    pub model_hash: String,
    pub client_version: u64,
    pub request_timestamp: u64,
    pub expiry: u64,
    pub nonce: String,
    pub fulfiller: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashCommitments {
    pub query_hash: String,
    pub shape_hash: String,
    pub model_hash: String,
    pub request_body_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofJobSummary {
    pub job_id: String,
    pub bid_id: Option<u64>,
    pub client: String,
    pub status: ProofJobStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofArtifact {
    pub proof_bytes_hex: String,
    pub public_values_hex: String,
    pub verifying_key_hex: String,
    pub proof_mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionRecord {
    pub mode: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResponse {
    pub oracle_spec: OracleSpec,
    pub expected_shape: String,
    pub canonical_shape: String,
    pub structured_output: Value,
    pub callback_data: String,
    pub update: UpdateEnvelopeJson,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<ProofEnvelopeJson>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_commitment: Option<ProofCommitmentJson>,
    pub hash_commitments: HashCommitments,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation_data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revealed_data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_job: Option<ProofJobSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission: Option<SubmissionRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProofJobStatus {
    PendingAttestation,
    PendingProof,
    PendingSubmission,
    Submitted,
    Failed,
}

impl std::fmt::Display for ProofJobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ProofJobStatus::PendingAttestation => "pending_attestation",
            ProofJobStatus::PendingProof => "pending_proof",
            ProofJobStatus::PendingSubmission => "pending_submission",
            ProofJobStatus::Submitted => "submitted",
            ProofJobStatus::Failed => "failed",
        })
    }
}

#[derive(Clone, Debug)]
pub struct PreparedUpdate {
    pub client: Address,
    pub callback_data: Vec<u8>,
    pub query_hash: H256,
    pub shape_hash: H256,
    pub model_hash: H256,
    pub client_version: u64,
    pub request_timestamp: u64,
    pub expiry: u64,
    pub nonce: U256,
    pub fulfiller: Address,
}

#[derive(Clone, Debug)]
pub struct PreparedProofEnvelope {
    pub scheme: u8,
    pub public_values: Vec<u8>,
    pub proof: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct PreparedProofCommitment {
    pub digest: H256,
    pub bid_id: U256,
    pub auto_flow: bool,
    pub client: Address,
    pub fulfiller: Address,
    pub query_hash: H256,
    pub shape_hash: H256,
    pub model_hash: H256,
    pub client_version: u64,
    pub request_timestamp: u64,
    pub expiry: u64,
    pub nonce: U256,
    pub callback_hash: H256,
}
