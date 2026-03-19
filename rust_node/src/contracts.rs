use std::{path::Path, sync::Arc};

use anyhow::{anyhow, Context, Result};
use ethers::{
    abi::{Abi, RawLog, Token},
    contract::Contract,
    providers::{Http, Middleware, Provider},
    types::{Address, BlockNumber, Filter, Log, U256},
};
use serde::{Deserialize, Serialize};

use crate::types::{BidPlacedEvent, OracleSpec};

#[derive(Clone)]
pub struct ContractArtifacts {
    pub hub_abi: Abi,
    pub oracle_abi: Abi,
    pub erc20_abi: Abi,
}

impl ContractArtifacts {
    pub fn load(abi_dir: impl AsRef<Path>) -> Result<Self> {
        let abi_dir = abi_dir.as_ref();
        Ok(Self {
            hub_abi: load_abi(abi_dir.join("ThassaHub.abi.json"))?,
            oracle_abi: load_abi(abi_dir.join("ThassaOracle.abi.json"))?,
            erc20_abi: load_abi(abi_dir.join("ERC20.abi.json"))
                .unwrap_or_else(|_| default_erc20_abi()),
        })
    }
}

#[derive(Clone)]
pub struct ChainContracts {
    provider: Arc<Provider<Http>>,
    pub artifacts: ContractArtifacts,
    pub hub_address: Address,
}

impl ChainContracts {
    pub fn new(
        provider: Provider<Http>,
        artifacts: ContractArtifacts,
        hub_address: Address,
    ) -> Self {
        Self {
            provider: Arc::new(provider),
            artifacts,
            hub_address,
        }
    }

    pub fn provider(&self) -> Arc<Provider<Http>> {
        self.provider.clone()
    }

    pub fn hub(&self) -> Contract<Provider<Http>> {
        Contract::new(
            self.hub_address,
            self.artifacts.hub_abi.clone(),
            self.provider.clone(),
        )
    }

    pub fn oracle(&self, address: Address) -> Contract<Provider<Http>> {
        Contract::new(
            address,
            self.artifacts.oracle_abi.clone(),
            self.provider.clone(),
        )
    }

    pub fn erc20(&self, address: Address) -> Contract<Provider<Http>> {
        Contract::new(
            address,
            self.artifacts.erc20_abi.clone(),
            self.provider.clone(),
        )
    }

    pub async fn latest_block_number(&self) -> Result<u64> {
        Ok(self.provider.get_block_number().await?.as_u64())
    }

    pub async fn read_payment_token(&self) -> Result<Address> {
        let contract = self.hub();
        contract
            .method::<_, Address>("paymentToken", ())?
            .call()
            .await
            .map_err(Into::into)
    }

    pub async fn read_auto_flow_lockup(&self) -> Result<U256> {
        let contract = self.hub();
        contract
            .method::<_, U256>("autoFlowLockup", ())?
            .call()
            .await
            .map_err(Into::into)
    }

    pub async fn read_base_protocol_fee(&self) -> Result<U256> {
        let contract = self.hub();
        contract
            .method::<_, U256>("baseProtocolFee", ())?
            .call()
            .await
            .map_err(Into::into)
    }

    pub async fn read_bid(&self, bid_id: U256) -> Result<HubBid> {
        let contract = self.hub();
        let result: (Address, Address, U256, bool) = contract
            .method::<_, (Address, Address, U256, bool)>("getBid", bid_id)?
            .call()
            .await?;
        Ok(HubBid {
            requester: result.0,
            client: result.1,
            amount: result.2,
            is_open: result.3,
        })
    }

    pub async fn read_oracle_spec(&self, oracle: Address) -> Result<OracleSpec> {
        let contract = self.oracle(oracle);
        let result: (String, String, String, u64) = contract
            .method::<_, (String, String, String, u64)>("oracleSpec", ())?
            .call()
            .await?;
        Ok(OracleSpec {
            query: result.0,
            expected_shape: result.1,
            model: result.2,
            client_version: result.3,
        })
    }

    pub async fn read_payment_token_allowance(
        &self,
        token: Address,
        owner: Address,
        spender: Address,
    ) -> Result<U256> {
        let contract = self.erc20(token);
        contract
            .method::<_, U256>("allowance", (owner, spender))?
            .call()
            .await
            .map_err(Into::into)
    }

    pub async fn scan_bid_placed_logs(
        &self,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<BidPlacedEvent>> {
        let event = self
            .artifacts
            .hub_abi
            .event("BidPlaced")
            .context("hub ABI missing BidPlaced event")?;

        let filter = Filter::new()
            .address(self.hub_address)
            .topic0(event.signature())
            .from_block(BlockNumber::Number(from_block.into()))
            .to_block(BlockNumber::Number(to_block.into()));

        let logs = self.provider.get_logs(&filter).await?;
        let mut decoded = Vec::with_capacity(logs.len());

        for log in logs {
            let parsed = event.parse_log(RawLog {
                topics: log.topics.clone(),
                data: log.data.to_vec(),
            })?;
            decoded.push(decode_bid_placed_log(log, parsed.params)?);
        }

        Ok(decoded)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HubBid {
    pub requester: Address,
    pub client: Address,
    pub amount: U256,
    pub is_open: bool,
}

pub fn load_abi(path: impl AsRef<Path>) -> Result<Abi> {
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("read ABI file {}", path.as_ref().display()))?;
    Ok(serde_json::from_str(&raw)
        .with_context(|| format!("parse ABI file {}", path.as_ref().display()))?)
}

fn default_erc20_abi() -> Abi {
    serde_json::from_str(
        r#"[
            {"type":"function","name":"allowance","stateMutability":"view","inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
            {"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]}
        ]"#,
    )
    .expect("default ERC20 ABI is valid")
}

fn decode_bid_placed_log(log: Log, params: Vec<ethers::abi::LogParam>) -> Result<BidPlacedEvent> {
    let mut bid_id = None;
    let mut requester = None;
    let mut client = None;
    let mut amount = None;

    for param in params {
        match param.name.as_str() {
            "bidId" => bid_id = Some(token_to_u64(param.value)?),
            "requester" => requester = Some(token_to_address(param.value)?),
            "client" => client = Some(token_to_address(param.value)?),
            "amount" => amount = Some(token_to_u256(param.value)?),
            _ => {}
        }
    }

    Ok(BidPlacedEvent {
        bid_id: bid_id.ok_or_else(|| anyhow!("missing bidId"))?,
        requester: requester
            .ok_or_else(|| anyhow!("missing requester"))?
            .to_string(),
        client: client.ok_or_else(|| anyhow!("missing client"))?.to_string(),
        amount: amount.ok_or_else(|| anyhow!("missing amount"))?.to_string(),
        tx_hash: log.transaction_hash.unwrap_or_default().to_string(),
        block_number: log.block_number.unwrap_or_default().as_u64(),
    })
}

fn token_to_u64(token: Token) -> Result<u64> {
    match token {
        Token::Uint(value) => Ok(value.as_u64()),
        other => Err(anyhow!("expected uint token, got {other:?}")),
    }
}

fn token_to_u256(token: Token) -> Result<U256> {
    match token {
        Token::Uint(value) => Ok(value),
        other => Err(anyhow!("expected uint token, got {other:?}")),
    }
}

fn token_to_address(token: Token) -> Result<Address> {
    match token {
        Token::Address(value) => Ok(value),
        other => Err(anyhow!("expected address token, got {other:?}")),
    }
}
