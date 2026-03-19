use std::{str::FromStr, sync::Arc};

use anyhow::{anyhow, Context, Result};
use ethers::{
    contract::Contract,
    middleware::SignerMiddleware,
    providers::{Http, Provider},
    signers::{LocalWallet, Signer},
    types::{Address, Bytes, TransactionReceipt, H256, U256},
};
use tracing::info;

use crate::{
    config::Config,
    contracts::{ChainContracts, ContractArtifacts},
    types::{PreparedProofEnvelope, PreparedUpdate, SubmissionRecord},
};

#[derive(Clone)]
pub struct SubmissionService {
    chain: ChainContracts,
    signer: Arc<SignerMiddleware<Provider<Http>, LocalWallet>>,
}

impl SubmissionService {
    pub async fn from_config(config: &Config, artifacts: ContractArtifacts) -> Result<Self> {
        let provider = Provider::<Http>::try_from(config.rpc_url.as_str())
            .with_context(|| format!("connect provider {}", config.rpc_url))?;
        let chain = ChainContracts::new(
            provider.clone(),
            artifacts,
            Address::from_str(&config.hub_address).context("parse DEFAULT_THASSA_HUB")?,
        );

        let wallet = config
            .node_private_key
            .parse::<LocalWallet>()
            .context("parse NODE_PRIVATE_KEY")?
            .with_chain_id(config.chain_id);

        let signer = Arc::new(SignerMiddleware::new(provider, wallet));
        Ok(Self { chain, signer })
    }

    pub fn wallet_address(&self) -> Address {
        self.signer.address()
    }

    pub fn chain(&self) -> &ChainContracts {
        &self.chain
    }

    pub async fn compute_update_digest(
        &self,
        update: &PreparedUpdate,
        bid_id: u64,
        auto_flow: bool,
    ) -> Result<H256> {
        let contract = self.signer_hub();
        contract
            .method::<_, H256>(
                "computeUpdateDigest",
                (prepared_update_tuple(update), U256::from(bid_id), auto_flow),
            )?
            .call()
            .await
            .map_err(Into::into)
    }

    pub async fn ensure_manual_update_allowance(&self) -> Result<()> {
        let fee = self.chain.read_base_protocol_fee().await?;
        self.ensure_allowance(fee).await
    }

    pub async fn ensure_auto_update_allowance(&self) -> Result<()> {
        let amount = self.chain.read_auto_flow_lockup().await?;
        self.ensure_allowance(amount).await
    }

    async fn ensure_allowance(&self, required: U256) -> Result<()> {
        let owner = self.wallet_address();
        let spender = self.chain.hub_address;
        let token = self.chain.read_payment_token().await?;
        let allowance = self
            .chain
            .read_payment_token_allowance(token, owner, spender)
            .await?;
        if allowance >= required {
            info!(owner = %owner, spender = %spender, allowance = %allowance, required = %required, "ERC20 allowance already sufficient");
            return Ok(());
        }

        let token_contract = self.signer_erc20(token);
        info!(owner = %owner, spender = %spender, allowance = %allowance, required = %required, "Updating ERC20 allowance for hub");

        if self
            .approve_amount(&token_contract, spender, U256::MAX)
            .await
            .is_err()
        {
            info!(spender = %spender, "Retrying approval with reset-to-zero flow");
            self.approve_amount(&token_contract, spender, U256::zero())
                .await?;
            self.approve_amount(&token_contract, spender, U256::MAX)
                .await?;
        }

        let post = self
            .chain
            .read_payment_token_allowance(token, owner, spender)
            .await?;
        if post < required {
            return Err(anyhow!(
                "allowance still below required amount after approval: {post} < {required}"
            ));
        }

        info!(owner = %owner, spender = %spender, allowance = %post, "ERC20 allowance updated");
        Ok(())
    }

    async fn approve_amount(
        &self,
        token_contract: &Contract<SignerMiddleware<Provider<Http>, LocalWallet>>,
        spender: Address,
        amount: U256,
    ) -> Result<TransactionReceipt> {
        let call = token_contract.method::<_, bool>("approve", (spender, amount))?;
        let pending = call.send().await.context("send approve transaction")?;
        let tx_hash = pending.tx_hash();
        let receipt = pending
            .await
            .context("wait approve transaction")?
            .ok_or_else(|| anyhow!("approve transaction {tx_hash:?} dropped from mempool"))?;
        if receipt.status != Some(1u64.into()) {
            return Err(anyhow!("approve transaction reverted: {tx_hash:?}"));
        }
        Ok(receipt)
    }

    pub async fn submit_manual_update(
        &self,
        update: &PreparedUpdate,
        proof: &PreparedProofEnvelope,
    ) -> Result<SubmissionRecord> {
        self.ensure_manual_update_allowance().await?;
        let contract = self.signer_hub();
        let call = contract.method::<_, H256>(
            "submitManualUpdate",
            (prepared_update_tuple(update), prepared_proof_tuple(proof)),
        )?;
        let pending = call
            .send()
            .await
            .context("send submitManualUpdate transaction")?;
        let tx_hash = pending.tx_hash();
        let receipt = pending
            .await
            .context("wait submitManualUpdate transaction")?
            .ok_or_else(|| {
                anyhow!("submitManualUpdate transaction {tx_hash:?} dropped from mempool")
            })?;
        if receipt.status != Some(1u64.into()) {
            return Err(anyhow!(
                "submitManualUpdate transaction reverted: {tx_hash:?}"
            ));
        }
        info!(tx_hash = %tx_hash, "Manual update submitted");
        Ok(SubmissionRecord {
            mode: "manual".to_string(),
            target: self.chain.hub_address.to_string(),
            tx_hash: Some(format!("{tx_hash:#x}")),
            note: None,
        })
    }

    pub async fn submit_auto_update(
        &self,
        bid_id: u64,
        update: &PreparedUpdate,
        proof: &PreparedProofEnvelope,
    ) -> Result<SubmissionRecord> {
        self.ensure_auto_update_allowance().await?;
        let contract = self.signer_hub();
        let call = contract.method::<_, H256>(
            "submitAutoUpdate",
            (
                U256::from(bid_id),
                prepared_update_tuple(update),
                prepared_proof_tuple(proof),
            ),
        )?;
        let pending = call
            .send()
            .await
            .context("send submitAutoUpdate transaction")?;
        let tx_hash = pending.tx_hash();
        let receipt = pending
            .await
            .context("wait submitAutoUpdate transaction")?
            .ok_or_else(|| {
                anyhow!("submitAutoUpdate transaction {tx_hash:?} dropped from mempool")
            })?;
        if receipt.status != Some(1u64.into()) {
            return Err(anyhow!(
                "submitAutoUpdate transaction reverted: {tx_hash:?}"
            ));
        }
        info!(tx_hash = %tx_hash, bid_id, "Auto update submitted");
        Ok(SubmissionRecord {
            mode: "auto".to_string(),
            target: self.chain.hub_address.to_string(),
            tx_hash: Some(format!("{tx_hash:#x}")),
            note: None,
        })
    }

    fn signer_hub(&self) -> Contract<SignerMiddleware<Provider<Http>, LocalWallet>> {
        Contract::new(
            self.chain.hub_address,
            self.chain.artifacts.hub_abi.clone(),
            self.signer.clone(),
        )
    }

    fn signer_erc20(
        &self,
        token: Address,
    ) -> Contract<SignerMiddleware<Provider<Http>, LocalWallet>> {
        Contract::new(
            token,
            self.chain.artifacts.erc20_abi.clone(),
            self.signer.clone(),
        )
    }
}

fn prepared_update_tuple(
    update: &PreparedUpdate,
) -> (
    Address,
    Bytes,
    H256,
    H256,
    H256,
    u64,
    u64,
    u64,
    U256,
    Address,
) {
    (
        update.client,
        Bytes::from(update.callback_data.clone()),
        update.query_hash,
        update.shape_hash,
        update.model_hash,
        update.client_version,
        update.request_timestamp,
        update.expiry,
        update.nonce,
        update.fulfiller,
    )
}

fn prepared_proof_tuple(proof: &PreparedProofEnvelope) -> (u8, Bytes, Bytes) {
    (
        proof.scheme,
        Bytes::from(proof.public_values.clone()),
        Bytes::from(proof.proof.clone()),
    )
}
