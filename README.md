<p align="center">
  <img src="./Thassa%20Logo.svg" alt="THASSA logo" width="220" />
</p>

<h1 align="center">THASSA</h1>

<p align="center">
  <strong>Social prediction markets, settled by a proof-of-authority oracle.</strong>
</p>

<p align="center">
  An Instagram-style social platform where any post can carry a prediction market — plus the
  Solidity settlement layer, oracle node, and market contracts underneath it.
</p>

## Overview

THASSA has two layers:

1. **Settlement layer** — an oracle system for requesting structured offchain data updates and
   settling them onchain. Updates are produced by our own centralized node, which signs response
   blobs; an onchain **proof-of-authority verifier** (`ThassaPoAVerifier`, an owner-managed
   signer set) validates the signature before the hub releases payment and dispatches the
   callback. The earlier zkTLS/Noir/SP1 proof paths are retained under `rust_node/` as legacy
   experiments but are no longer the trust anchor.
2. **Platform layer** — the Thassa app: a full-featured social network (posts, stories, reels,
   DMs) with a Kalshi-style twist: users attach prediction markets to their posts. Markets run on
   an onchain order book (`ThassaMarkets`) and settle through the oracle callback. Orders are
   gasless for users (EIP-712 signed, funded via EIP-3009 `receiveWithAuthorization`, batched by
   the backend relayer). Go backend, Next.js web app, Expo mobile app.

The authoritative platform specification is [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md).

## Oracle protocol flow

At a high level:

1. A requester places a bid against an oracle contract.
2. A node picks up the request, resolves the upstream query, shapes the data into the oracle's expected callback format, and prepares a fulfillment artifact.
3. The hub verifies the fulfillment path and unlocks the bid if the submission is valid.
4. The oracle updates onchain state, and downstream applications read the fresh snapshot directly from the contract.

## Repository Map

| Path | Purpose |
| --- | --- |
| `contracts/` | Solidity hub, oracle, PoA verifier, and prediction-market contracts, tests, deploy scripts |
| `node/` | The proof-of-authority oracle node (signs and submits settlement updates) |
| `backend/` | Go platform backend: social + markets API, relayer/batcher, indexer, media pipeline, WebSockets |
| `web/` | Next.js web app (Instagram-style UI + markets, wallet, DMs) |
| `mobile/` | Expo mobile app (full feature parity with web) |
| `docs/PLATFORM_SPEC.md` | Authoritative platform specification |
| `frontend/` | Legacy Next.js weather demo UI for the oracle layer |
| `rust_node/` | Legacy zkTLS/Noir/SP1 experimental path (not the active trust model) |
| `DATA_SHAPING_GUIDE.txt` | Data-shaping conventions and schema DSL guidance |
| `production_implementation.md` | Historical production roadmap for the zk path (superseded by the PoA pivot) |

## Key Components

| Component | Role |
| --- | --- |
| `ThassaHub` | Bid accounting, verifier dispatch, payout unlocking, callback execution |
| `ThassaPoAVerifier` | **Canonical verifier module**: proof-of-authority signer set validating node-signed updates |
| `ThassaMarkets` | All prediction markets: onchain order book, batched gasless orders, fees, oracle-settled outcomes |
| `ThassaSignatureVerifier` | Single-signer predecessor of the PoA verifier (kept for tests/compat) |
| `ThassaSanFranciscoWeatherOracle` | Demo oracle that stores the latest San Francisco weather report |
| `node` | The PoA oracle node: fulfills settlement queries and signs response blobs |
| `backend` | Platform API + relayer + indexer + settlement runner |
| `web` / `mobile` | The Thassa app (Next.js / Expo) |
| `ThassaNoirVerifier` / `ThassaSP1Verifier` / `rust_node` | Legacy zk experiments; not the active trust model |
| `frontend` | Legacy demo operator UI for the weather oracle |

## Platform Quick Start

One command brings up the entire platform against a local fork of Tempo:

```bash
cp .env.boot.example .env.boot   # set TEMPO_FORK_RPC_URL, PRIVY_APP_ID, OPENAI_API_KEY, etc.
./boot.sh
```

`boot.sh` starts postgres + minio, launches anvil (forking Tempo when `TEMPO_FORK_RPC_URL` is
set), **prank-funds** every configured address (`FUND_ADDRESSES` + the deployer/node/relayer/dev
keys) with gas via `anvil_setBalance` and payment tokens via whale impersonation or `MockUSD`
mint, deploys the contracts (hub, `ThassaPoAVerifier` with the node signer registered,
`ThassaMarkets`), wires the deployed addresses into `backend/.env`, `node/.env`, `web/.env.local`,
and `mobile/.env`, and then starts the backend, the PoA oracle node, the web app, and the Expo
dev server. Logs land in `logs/`; ctrl-C stops the app processes.

The platform spec — architecture, contract interfaces, API, state vocabulary, fees, security
model — lives in [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md).

## Dependencies

### Core development dependencies

- Foundry (`forge`, `cast`, `anvil`)
- Go
- Node.js / npm

### Additional dependencies for the experimental proof-backed path

- OpenAI API access
- Primus app credentials
- Noir / Barretenberg (`nargo`, `bb`) for local proof generation
- Access to a deployed Noir verifier contract for `ThassaNoirVerifier`
- The expected Primus attestor address for both the node config and `ThassaNoirVerifier`
- Optional Succinct prover-network credentials if you still want to exercise the legacy SP1 path

### First-time setup

```bash
git submodule update --init --recursive

cd frontend && npm install
```

If you plan to work on `rust_node/`, also install Rust/Cargo, Noir/Barretenberg, and the bridge dependencies in `rust_node/bridge`. The SP1 toolchain is now only needed for the legacy fallback path.

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

The production proof-backed path under `rust_node/` adds Primus and Noir dependencies, but that path is still under active bring-up.

So "local demo" here means local chain, local UI, and local operator processes, not a fully sealed offline stack.

## Key Trust Assumptions

### Demo assumptions

- The weather frontend intentionally exposes `NEXT_PUBLIC_DEMO_PRIVATE_KEY` in browser code.
- `MockCoin` is demo-only payment infrastructure for local testing.
- The current runnable demo backend is `node/`.
- Local operators are responsible for setting correct contract addresses and env configuration.
- If the frontend, node, or deploy env points at the wrong chain or wrong addresses, the demo can look healthy while reading or submitting against the wrong contracts.

### Production-path assumptions

- The current proof-backed target trust anchor is the Noir proof checked by [ThassaNoirVerifier.sol](/Users/coding/THASSA/contracts/src/ThassaNoirVerifier.sol), not a centralized signer.
- The proof circuit now verifies the Primus attestation signature and signed request/response hashes, then reconstructs the shaped callback payload and exposes it through verifier-readable public inputs.
- The verifier must be configured with the correct Noir verifier contract, expected Primus attestor, and the public-input layout expected by `ThassaNoirVerifier`.
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

The repo has pivoted **away** from the zkTLS/Noir proof pipeline and **toward** a
proof-of-authority settlement model powering the Thassa social prediction-market platform.

Today, the right mental model is:

- `contracts/` + `node/` are the settlement layer: PoA-verified oracle updates via `ThassaHub`,
  with `ThassaMarkets` as the flagship consumer
- `backend/`, `web/`, and `mobile/` are the platform: [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md)
  is the authoritative spec
- `rust_node/` and the Noir/SP1 verifiers are legacy experiments retained for reference;
  [production_implementation.md](production_implementation.md) documents that superseded direction
