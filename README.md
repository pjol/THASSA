<p align="center">
  <img src="./Thassa%20Logo.svg" alt="THASSA logo" width="220" />
</p>

<h1 align="center">THASSA</h1>

<p align="center">
  <strong>Proof-oriented oracle fulfillment with structured AI outputs.</strong>
</p>

<p align="center">
  Solidity contracts, a Go demo node, and a weather demo frontend for local iteration.
</p>

## Overview

THASSA is an oracle protocol for requesting structured offchain data updates and settling them onchain.

At a high level:

1. A requester places a bid against an oracle contract.
2. A node picks up the request, resolves the upstream query, shapes the data into the oracle's expected callback format, and prepares a fulfillment artifact.
3. The hub verifies the fulfillment path and unlocks the bid if the submission is valid.
4. The oracle updates onchain state, and downstream applications read the fresh snapshot directly from the contract.

This repository currently contains both:

- the current demo operator path in `node/`
- the in-progress production rewrite in `rust_node/`

The production architecture and open implementation notes live in [production_implementation.md](/Users/coding/THASSA/production_implementation.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| `contracts/` | Solidity hub, oracle, verifier contracts, tests, and deploy scripts |
| `node/` | Current demo node used for local iteration and auto-fulfillment |
| `rust_node/` | Experimental production-oriented rewrite under active development |
| `frontend/` | Next.js weather demo UI for reading oracle state and placing auto-update bids |
| `DATA_SHAPING_GUIDE.txt` | Data-shaping conventions and schema DSL guidance |
| `production_implementation.md` | Production roadmap, status, and remaining work |

## Key Components

| Component | Role |
| --- | --- |
| `ThassaHub` | Bid accounting, verifier dispatch, payout unlocking, callback execution |
| `ThassaSignatureVerifier` | Current demo verifier module that checks a trusted fulfiller signature |
| `ThassaSP1Verifier` | Production-oriented verifier module for SP1 proof verification |
| `ThassaSanFranciscoWeatherOracle` | Demo oracle that stores the latest San Francisco weather report |
| `node` | Current demo backend for local fulfillment and auto-update handling |
| `rust_node` | Experimental production backend rewrite; not ready for current use |
| `frontend` | Demo operator UI for viewing weather state and requesting auto-updates |

## Dependencies

### Core development dependencies

- Foundry (`forge`, `cast`, `anvil`)
- Go
- Node.js / npm

### Additional dependencies for the experimental proof-backed path

- OpenAI API access
- Primus app credentials
- Succinct prover-network credentials
- Access to a deployed SP1 verifier contract plus the program verification key used by `ThassaSP1Verifier`

### First-time setup

```bash
git submodule update --init --recursive

cd frontend && npm install
```

If you plan to work on `rust_node/`, also install Rust/Cargo, the SP1 toolchain described in the Succinct docs, and the bridge dependencies in `rust_node/bridge`.

## Demo Boot Sequence

The sequence below is the intended local demo path for:

- Anvil
- contract deployment
- the Go demo node
- the weather frontend

### 1. Start a local chain

```bash
anvil
```

Keep this terminal open. Use funded Anvil accounts for:

- a deployer
- a demo requester
- a node fulfiller

Recommended mapping:

- `DEPLOYER_PRIVATE_KEY` = one funded Anvil private key
- `USER_ACCOUNT_PUBLIC_KEY` = the address for the key the frontend will use
- `NODE_PRIVATE_KEY` = another funded Anvil private key for the demo node

### 2. Prepare contract deployment env

```bash
cp contracts/.env.example contracts/.env
```

Fill in:

- `DEPLOY_RPC_URL`
- `DEPLOYER_PRIVATE_KEY`
- `NODE_SIGNER_PUBLIC_KEY`
- `USER_ACCOUNT_PUBLIC_KEY`

Notes:

- `ORACLE_MODEL` defaults to `openai:gpt-5.4`
- the demo deploy script uses `ThassaSignatureVerifier` and binds it to `NODE_SIGNER_PUBLIC_KEY`

### 3. Deploy the contracts

```bash
cd contracts
./script/deploy_thassa.sh
```

The script deploys:

- `MockCoin`
- `ThassaSignatureVerifier`
- `ThassaHub`
- `ThassaSanFranciscoWeatherOracle`

Copy the printed `ThassaHub` and `ThassaSanFranciscoWeatherOracle` addresses. You will use them in the demo node and frontend env files.

If you only need to deploy a fresh weather oracle against an existing hub:

```bash
./script/deploy_weather_oracle.sh
```

### 4. Sync frontend ABIs after Solidity changes

```bash
cd ../frontend
npm run export:abis
```

This rebuilds the contract artifacts and refreshes the frontend ABI files in `frontend/abi`.

### 5. Configure and run the Go demo node

```bash
cd ../node
cp .env.example .env
```

At minimum, update:

- `THASSA_RPC_URL`
- `DEFAULT_THASSA_HUB`
- `NODE_PRIVATE_KEY`
- `OPENAI_API_KEY`

Then start the node:

```bash
go run ./cmd/server
```

Useful defaults already wired in:

- the node scans bids every `2` seconds
- `GET /healthz`
- `POST /v1/update`

Note:

- this is the current demo path to use for local iteration
- `rust_node/` is still under active construction and should not be treated as the runnable demo backend

### 6. Configure and run the weather frontend

```bash
cd ../frontend
cp .env.example .env.local
```

Fill in:

- `NEXT_PUBLIC_RPC_URL`
- `NEXT_PUBLIC_HUB_ADDRESS`
- `NEXT_PUBLIC_WEATHER_ORACLE_ADDRESS`
- `NEXT_PUBLIC_DEMO_PRIVATE_KEY`

The demo private key should correspond to the address you used for `USER_ACCOUNT_PUBLIC_KEY` during contract deployment.

Then run:

```bash
npm run dev
```

Open `http://localhost:3000`.

### 7. Walk the demo

Once everything is up:

1. Open the frontend and confirm it can read `latestWeather()`.
2. Verify the oracle metadata shown in the UI matches the deployed contract.
3. Submit an auto-update bid from the frontend.
4. The frontend will approve `MockCoin` to the weather oracle before calling `oracle.placeBid(...)`.
5. The Go demo node should detect the bid, attempt fulfillment, and submit the update path.
6. Refresh the frontend and confirm the onchain weather snapshot changes.

## Demo Details

The currently supported demo path is the legacy `node/` backend, not `rust_node/`.

The frontend and Anvil setup are local, but the demo fulfillment path still depends on external services:

- OpenAI for the upstream model call

The production proof-backed path under `rust_node/` adds Primus and Succinct dependencies, but that path is not ready for active use yet.

So "local demo" here means local chain, local UI, and local operator processes, not a fully sealed offline stack.

## Key Trust Assumptions

### Demo assumptions

- The weather frontend intentionally exposes `NEXT_PUBLIC_DEMO_PRIVATE_KEY` in browser code.
- `MockCoin` is demo-only payment infrastructure for local testing.
- The current runnable demo backend is `node/`.
- Local operators are responsible for setting correct contract addresses and env configuration.
- If the frontend, node, or deploy env points at the wrong chain or wrong addresses, the demo can look healthy while reading or submitting against the wrong contracts.

### Production-path assumptions

- The long-term target trust anchor is the SP1 proof checked by [ThassaSP1Verifier.sol](/Users/coding/THASSA/contracts/src/ThassaSP1Verifier.sol), not a centralized signer.
- The zkVM program is expected to verify Primus attestation data, reconstruct the shaped callback payload, bind the fulfiller, and commit the public values the hub checks.
- The verifier must be configured with the correct SP1 verifier contract and the correct program VKey.
- The current Primus execution path in `rust_node/` still uses a small JS bridge because attestation generation support is JS-native today.
- That entire production path is still under construction and should be treated as implementation work, not the active demo backend.

### Operational assumptions

- OpenAI, Primus, and Succinct credentials are all sensitive and should be treated as operator secrets.
- The frontend demo key is not a secret in the local demo and must never be reused in any real environment.
- Auto-fulfillment depends on the node staying online, funded for gas, and pointed at the same chain as the frontend and contracts.

## Suggested Reading

- [production_implementation.md](/Users/coding/THASSA/production_implementation.md)
- [DATA_SHAPING_GUIDE.txt](/Users/coding/THASSA/DATA_SHAPING_GUIDE.txt)
- [contracts/README.md](/Users/coding/THASSA/contracts/README.md)
- [rust_node/README.md](/Users/coding/THASSA/rust_node/README.md)
- [frontend/README.md](/Users/coding/THASSA/frontend/README.md)

## Status

The repo is in an active transition from a centralized demo signer model toward a proof-backed Primus + SP1 pipeline.

Today, the right mental model is:

- `contracts/`, `node/`, and `frontend/` are the current local demo path
- `rust_node/` is the production-oriented rewrite under active development and not ready for use
- [production_implementation.md](/Users/coding/THASSA/production_implementation.md) is the authoritative place to track what is implemented versus what still needs end-to-end validation
