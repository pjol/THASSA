use std::{
    fs,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use sp1_sdk::{
    network::FulfillmentStrategy, HashableKey, Prover, ProverClient, SP1ProofWithPublicValues,
    SP1Stdin, SP1VerifyingKey,
};
use tokio::time::sleep;
use tracing::info;

use crate::{
    config::Config,
    types::{ProofArtifact, ProofJobStatus, ProofJobSummary, ProofProgramInput},
};

#[derive(Clone)]
pub struct ProverService {
    mode: String,
    elf: Vec<u8>,
    timeout: Duration,
    poll_interval: Duration,
}

pub struct GeneratedProof {
    pub artifact: ProofArtifact,
    pub summary: ProofJobSummary,
}

impl ProverService {
    pub fn from_config(config: &Config) -> Result<Self> {
        let elf_path = resolve_elf_path(config)
            .context("SP1_ELF_PATH is required or the proof program ELF must exist in a standard build location")?;
        let elf = fs::read(elf_path).with_context(|| format!("read SP1 ELF {elf_path}"))?;

        Ok(Self {
            mode: config.sp1_prover_mode.to_lowercase(),
            elf,
            timeout: config.sp1_timeout,
            poll_interval: config.sp1_poll_interval,
        })
    }

    pub async fn prove(
        &self,
        bid_id: Option<u64>,
        client: &str,
        input: &ProofProgramInput,
    ) -> Result<GeneratedProof> {
        let mut stdin = SP1Stdin::new();
        stdin.write(&serde_json::to_string(input).context("serialize proof program input")?);

        match self.mode.as_str() {
            "network" => self.prove_network(bid_id, client, stdin).await,
            "local" | "cpu" => self.prove_local(bid_id, client, stdin).await,
            other => Err(anyhow!("unsupported SP1_PROVER mode {other:?}")),
        }
    }

    async fn prove_network(
        &self,
        bid_id: Option<u64>,
        client: &str,
        stdin: SP1Stdin,
    ) -> Result<GeneratedProof> {
        let network_prover = ProverClient::builder().network().private().build();
        let (pk, vk) = network_prover.setup(&self.elf);

        let proof_id = network_prover
            .prove(&pk, &stdin)
            .groth16()
            .timeout(self.timeout)
            .strategy(FulfillmentStrategy::Reserved)
            .request_async()
            .await
            .context("request network proof")?;

        let mut summary = ProofJobSummary {
            job_id: proof_id.to_string(),
            bid_id,
            client: client.to_string(),
            status: ProofJobStatus::PendingProof,
        };

        let started = Instant::now();
        let proof = loop {
            if started.elapsed() > self.timeout {
                summary.status = ProofJobStatus::Failed;
                return Err(anyhow!(
                    "SP1 network proof timed out after {:?}",
                    self.timeout
                ));
            }

            let (_status, proof_opt) = network_prover
                .get_proof_status(proof_id)
                .await
                .context("poll network proof status")?;

            if let Some(proof) = proof_opt {
                info!(job_id = %summary.job_id, "SP1 proof completed");
                break proof;
            }

            sleep(self.poll_interval).await;
        };

        network_prover
            .verify(&proof, &vk)
            .context("verify network proof locally")?;
        summary.status = ProofJobStatus::PendingSubmission;

        Ok(GeneratedProof {
            artifact: encode_artifact(vk, proof, "network")?,
            summary,
        })
    }

    async fn prove_local(
        &self,
        bid_id: Option<u64>,
        client: &str,
        stdin: SP1Stdin,
    ) -> Result<GeneratedProof> {
        let prover = ProverClient::from_env();
        let (pk, vk) = prover.setup(&self.elf);
        let proof = prover
            .prove(&pk, &stdin)
            .groth16()
            .run()
            .context("generate local SP1 proof")?;

        prover.verify(&proof, &vk).context("verify local proof")?;

        Ok(GeneratedProof {
            artifact: encode_artifact(vk, proof, "local")?,
            summary: ProofJobSummary {
                job_id: format!("local-{}", bid_id.unwrap_or_default()),
                bid_id,
                client: client.to_string(),
                status: ProofJobStatus::PendingSubmission,
            },
        })
    }
}

fn resolve_elf_path(config: &Config) -> Option<&str> {
    if let Some(path) = config
        .sp1_elf_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        return Some(path);
    }

    const CANDIDATES: &[&str] = &[
        "artifacts/thassa-program.elf",
        "rust_node/artifacts/thassa-program.elf",
        "program/elf/riscv32im-succinct-zkvm-elf/release/thassa-program",
        "rust_node/program/elf/riscv32im-succinct-zkvm-elf/release/thassa-program",
    ];

    CANDIDATES
        .iter()
        .copied()
        .find(|candidate| std::path::Path::new(candidate).exists())
}

fn encode_artifact(
    vk: SP1VerifyingKey,
    proof: SP1ProofWithPublicValues,
    proof_mode: &str,
) -> Result<ProofArtifact> {
    let verifying_key_hex = vk.bytes32();
    let proof_bytes_hex = format!("0x{}", hex::encode(proof.bytes()));
    let public_values_hex = format!("0x{}", hex::encode(proof.public_values.as_slice()));

    Ok(ProofArtifact {
        proof_bytes_hex,
        public_values_hex,
        verifying_key_hex,
        proof_mode: proof_mode.to_string(),
    })
}
