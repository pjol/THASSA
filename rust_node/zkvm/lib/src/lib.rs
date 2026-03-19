use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleSpec {
    pub query: String,
    pub expected_shape: String,
    pub model: String,
    pub client_version: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofCommitmentJson {
    pub digest: String,
    pub bid_id: String,
    pub auto_flow: bool,
    pub client: String,
    pub fulfiller: String,
    pub query_hash: String,
    pub shape_hash: String,
    pub model_hash: String,
    pub client_version: u64,
    pub request_timestamp: u64,
    pub expiry: u64,
    pub nonce: String,
    pub callback_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofProgramInput {
    pub oracle_spec: OracleSpec,
    pub attestation_data_json: String,
    pub expected_attestor: String,
    pub allowed_urls: Vec<String>,
    pub openai_request_body_json: String,
    pub api_key: String,
    pub callback_data_hex: String,
    pub commitment: ProofCommitmentJson,
}
