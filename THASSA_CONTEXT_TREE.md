# THASSA Context Tree

Last reviewed: 2026-07-16

> **PIVOT (2026-07-16):** THASSA no longer targets zkTLS/Noir-proved settlement. The zkTLS
> attestor was judged an unnecessary dependency. The canonical settlement path is now
> **proof-of-authority**: our own centralized node signs response blobs and the hub verifies them
> through `ThassaPoAVerifier` (owner-managed signer set, scheme 1). Everything below describing
> the Primus/Noir/SP1 pipeline is retained as historical context for the legacy `rust_node/`
> path. On top of the PoA settlement mechanism we are building the Thassa **platform** — an
> Instagram-style social app with attachable prediction markets (`ThassaMarkets` contract,
> Go backend in `backend/`, Next.js `web/`, Expo `mobile/`). The authoritative spec is
> [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md).

## Project Goal (current)

Build a social prediction-market platform (posts, stories, reels, DMs + Kalshi-style markets
attached to posts) on a PoA-settled oracle:

```text
market contract (ThassaOracle extension)
  -> hub contract (escrow, digest, callback)
  -> PoA node (LLM-resolved settlement query, signed response blob)
  -> ThassaPoAVerifier (signer-set ECDSA check)
  -> onchain settlement callback (settled + direction)
```

## Historical Project Goal (superseded)

Use zkTLS-verified LLM calls to create zk proofs of LLM-derived structured data that can be used as onchain oracle data.

Target flow:

```text
contract extension
  -> hub contract
  -> verifier node
  -> zkTLS-attested LLM call
  -> Noir zk proof of LLM data
  -> onchain submission and settlement
```

## Current Implementation Tree

## Target ZK Proof Statement

The production proof must establish the following statement before the hub releases payment:

1. The zkTLS attestation signature is valid for the configured attestor.
2. The attestation recipient is the node/fulfiller address in the update.
3. The attested request URL equals the configured OpenAI base URL plus the configured endpoint.
4. The attested request method equals `POST`.
5. The attested request headers match an exact JSON header mask:
   - `Content-Type` must be exactly `application/json`.
   - `Accept-Encoding` must be exactly `identity` if included by the Primus bridge/runtime.
   - `Authorization` must match the `Bearer <secret>` shape, but the secret token value remains private.
   - No unexpected public header keys are allowed in the supported production mode.
6. The attested request body matches an exact JSON request mask:
   - Top-level keys and nested key paths must match the supported OpenAI request template exactly.
   - Variable portions are limited to the request model, the prompt/query payload, and the structured-output schema generated from `expectedShape`.
   - Web search settings must match the expected value exactly, not merely be present.
   - Response-format settings must be strict JSON schema with the expected schema name and no extra fields.
7. The attested response parse settings must exactly match:
   - `keyName = structured_output`
   - `parseType = json`
   - `parsePath = $.choices[0].message.content`
8. The private response body used by the prover must be the body committed by the signed Primus attestation.
9. The circuit, not the host alone, must extract `choices[0].message.content`, parse the structured JSON output, and ABI-encode the tuple for the requested shape.
10. Public inputs must bind the proof to the hub digest, bid id, auto/manual flow flag, client contract, fulfiller, expected attestor, query hash, shape hash, model hash, client version, attested request timestamp, expiry, nonce, callback hash, and callback bytes/chunks.

Current status:

- The Noir circuit now type-checks and enforces this proof statement for the current flat-tuple OpenAI chat-completions template.
- URL, method, response parse settings, header mask, request-body mask, response-body commitment, model/query/shape hashes, attestor signature, recipient binding, timestamp exposure, structured-output extraction, and callback chunk binding are all represented in the Noir path.
- The circuit currently enforces an exact semantic JSON mask: exact keys, exact nested structure, exact fixed values, and no extra object entries in the supported template. A byte-for-byte canonical string-template fixture for request-body ordering/whitespace is still a useful hardening target.
- The Rust node also performs host-side exact byte prechecks between the Primus-attested URL/header/method/body and the request it constructed before it starts proving.
- Onchain Noir submission remains safety-gated until a generated Noir verifier is deployed and configured.

### 1. Contract Extension

Status: substantially implemented for the non-upgradeable flat-tuple client path

- `contracts/src/ThassaOracle.sol`
  - Stores `query`, `expectedShape`, `model`, and `clientVersion`.
  - Exposes `oracleSpec()` for hub-side commitment checks.
  - Forwards bids through `placeBid(uint256)`.
  - Preserves the original end user as the hub bid requester with `placeBidFor`.
  - Gates `updateOracle(bytes)` so only the hub can call back.
- `contracts/src/ThassaSanFranciscoWeatherOracle.sol`
  - Demo concrete oracle for San Francisco observed weather.
  - Decodes ABI tuple callback data and stores latest weather state.
- `contracts/src/ThassaOracleUpgradeable.sol`
  - Present but empty.

Needs work:

- Only flat tuple-style oracle shaping is practically supported in the node/proof path.
- Upgradeable extension path is not implemented.
- Extension-level convenience helpers for cancellation are still absent; users can cancel directly through the hub because hub ownership is now preserved.

### 2. Hub Contract

Status: substantially implemented for escrow, bid settlement, and first-pass staking/accounting

- `contracts/src/ThassaHub.sol`
  - ERC20 payment-token escrow.
  - Fixed `baseProtocolFee`.
  - `baseFee()` alias for the base protocol fee.
  - Priority-fee quote helpers.
  - 50/50 split of base fee and priority fee between node and protocol vault.
  - Protocol vault address with `feeCollector()` compatibility alias.
  - Fixed same-transaction `autoFlowLockup`.
  - `placeBid`, `placeBidWithPriority`, `placeBidFor`, `cancelBid`, `submitManualUpdate`, `submitManualUpdateWithPriority`, `submitAutoUpdate`.
  - Node registration, node active flag, self-stake, delegated stake, total stake weight, node earned-fee stats.
  - Manual bid allocation to a registered active node.
  - Validates oracle spec hashes, request timestamp, expiry, replay digest, fulfilled marker, and verifier module result.
  - Enforces allocated-node matching when a bid has been allocated.
  - Dispatches callback with `try/catch`, so settlement can complete even if callback reverts.

Implemented settlement today:

- Manual update: submitter pays quoted protocol fee to the protocol vault and quoted node fee to the fulfiller.
- Auto update: hub pays stored protocol fee to the protocol vault and stored node fee to the fulfiller; lockup is refunded to the fulfiller.

Needs work:

- No bid reservation, timeout, collateral slashing, retry, or expiry lifecycle.
- No request-specific bid constraints beyond `client`.
- Stake-weight allocation is not automated yet; current allocation is manual/requester-or-owner directed.
- No staker fee distribution.
- The same ERC20 is currently used as payment/stake token in the hub prototype; the final fee-denomination model is still open.
- No onchain signal of callback failure is consumed by node logic beyond emitted event data.

### 3. Verifier Contracts

Status: partially implemented

- `contracts/interfaces/IThassaVerifier.sol`
  - Common hub-facing verifier abstraction.
- `contracts/src/ThassaSignatureVerifier.sol`
  - Demo verifier for trusted centralized signer.
  - Works for local/demo path.
- `contracts/src/ThassaSP1Verifier.sol`
  - Legacy SP1 adapter.
  - Checks external SP1 verifier result and public commitment fields.
  - Currently incompatible with the hub's fulfilled-marker expectation in the Rust SP1 public value encoding.
- `contracts/src/ThassaNoirVerifier.sol`
  - Noir wrapper adapter.
  - Calls external Noir verifier.
  - Checks public input layout, digest, bid id, auto-flow flag, client, fulfiller, expected attestor, query hash, shape hash, model hash, client version, timestamp, expiry, nonce, callback hash, and reconstructed callback bytes.
  - Expects 117 public input words for the current flat-tuple proof layout.

Needs work:

- Generated Noir verifier contract/artifact/deploy path is missing.
- Noir verifier does not enforce an OpenAI URL allowlist onchain, even though URL/endpoint chunks are public.
- SP1 path needs public-value/schema reconciliation or formal retirement.

### 4. Go Demo Node

Status: implemented for demo, not production proof path

- `node/`
  - HTTP server exposes `GET /healthz` and `POST /v1/update`.
  - Uses OpenAI structured output with web search.
  - Adds `_fulfilled` control field.
  - Encodes callback data.
  - Signs hub digest for `ThassaSignatureVerifier`.
  - Scans `BidPlaced` logs and submits `submitAutoUpdate`.
  - `go test ./...` passes; there are no Go test files.

Needs work:

- Centralized signer trust model only.
- No zkTLS attestation.
- No Noir proof.
- No production node allocation, staking, reward accounting, or robust retry/finality model.

### 5. Rust Production Node

Status: partially implemented; Noir is the intended path, but onchain Noir submission is gated until verifier deployment

- `rust_node/src/workflow.rs`
  - Reads oracle spec from chain.
  - Parses expected shape.
  - Builds OpenAI request with web search and strict JSON schema.
  - Requires canonical `expectedShape` for Noir.
  - Preserves `openai:<model>` as the public model witness while stripping the prefix only for the OpenAI API request.
  - Sends request through Primus zkTLS bridge.
  - Extracts structured output from attested response.
  - Validates structured output has exactly the requested fields.
  - Builds ABI callback data.
  - Computes hub digest.
  - Prepares Noir or SP1 proof request.
  - Optionally submits manual or auto update onchain.
- `rust_node/src/primus.rs`
  - Builds Primus request params.
  - Performs quote check.
  - Signs app request locally.
  - Calls JS or HTTP bridge.
  - Parses Primus `encodedData`.
  - Checks expected attestor and attestation signature.
- `rust_node/src/contracts.rs`
  - ABI loading, chain reads, oracle spec reads, bid log scans.
- `rust_node/src/submission.rs`
  - ERC20 allowance handling.
  - `computeUpdateDigest`, `submitManualUpdate`, `submitAutoUpdate`.
  - Noir verifier readiness check for proof scheme and expected attestor when onchain Noir submission is enabled.
- `rust_node/src/prover.rs`
  - Selects Noir by default or legacy SP1 by config.
  - Refuses auto-fulfillment with Noir unless `NOIR_ONCHAIN_SUBMISSION_ENABLED=true`.
- `rust_node/src/noir.rs`
  - Witness/public-input preparation and local `nargo`/`bb` proof command orchestration.
  - Exact host-side byte checks for Primus-attested URL, header, method, and body before proving.
  - Restrictive temp artifact cleanup and file permissions for sensitive proof inputs.

Validation:

- `cargo +1.91.1 test --manifest-path rust_node/Cargo.toml --lib` passes: 2 tests.
- Plain `cargo test --manifest-path rust_node/Cargo.toml --lib` fails in this workspace because root execution uses Rust 1.88.0 while dependencies require Rust 1.91+.

Needs work:

- Live Primus + `bb` + RPC end-to-end proof/submission run is still missing.
- Scanner has backfill/range/retry knobs now, but still lacks a durable retry queue and reservation-aware state machine.
- Rust node checks transaction success but does not inspect hub callback-success event result.
- Generated Noir verifier deployment is still required before production onchain Noir fulfillment can be enabled.

### 6. Primus zkTLS Attestation

Status: partially implemented

- Real Primus request assembly and bridge invocation exist.
- Expected attestor check exists.
- Host-side attestation signature validation exists.
- Redacted attestation logging is now the default; full bundle logging is opt-in for short-lived debugging.

Needs work:

- Live Primus sample capture and regression fixture are not present.
- Proof-side response commitment needs a live end-to-end regression fixture against a real Primus sample.

### 7. Noir Proof

Status: type-checking flat-tuple proof scaffold

- `rust_node/noir/flat_tuple/src/main.nr`
  - Verifies Primus attestation signature.
  - Binds attestation recipient to fulfiller.
  - Exposes request timestamp.
  - Reconstructs expected shape.
  - Checks query/shape/model hashes.
  - Checks request URL, method, exact supported header mask, exact supported request-body JSON mask, and response parse settings.
  - Allows only the API-key value, request model, request prompt/input payload, and generated structured-output schema as variable portions of the attested request template.
  - Validates the attested response body is the body committed by the signed Primus attestation.
  - Parses OpenAI response shape and assembles flat ABI tuple callback chunks.
- `contracts/src/ThassaNoirVerifier.sol`
  - Expects 117 public input words and validates layout/update binding.

Validation:

- `nargo check` passes for `rust_node/noir/flat_tuple`.

Known blockers:

- Generated verifier artifact/deploy path is missing.
- No live `bb prove`/`bb verify` run has been captured in this workspace.
- Numeric range handling is incomplete for `uintN`/`intN` and large `uint256` values.
- No Noir test fixtures or captured real Primus proof sample exist.
- Current JSON mask is semantic/canonical-structure exact, not yet a byte-for-byte string-template proof over request-body ordering and whitespace.

### 8. SP1 Legacy Proof

Status: legacy/incompatible

- `rust_node/zkvm/` contains shared input types, guest program, and helper scripts.
- `contracts/src/ThassaSP1Verifier.sol` remains present.

Needs work:

- Public-values layout is incompatible with current hub fulfilled-marker expectation.
- Tooling/deploy path is not the current target.
- Decide whether to delete, quarantine, or repair after Noir path stabilizes.

### 9. Staking, Allocation, Vault, and Fee Distribution

Status: partially implemented in the hub prototype

Implemented:

- Node registration and active flag.
- Node self-staking.
- Delegated staking to nodes.
- Stake-weight tracking.
- Manual bid allocation to a registered active node.
- Protocol vault address and protocol-fee accounting.
- Node fee accounting.

Missing:

- Dedicated staking token implementation split from the stablecoin payment token.
- Automated stake-weight-based fulfillment allocation.
- Periodic buyback-funded fee distribution to staking token holders.
- Slashing/collateral policy.
- Protocol-fee custody, buyback, and distribution vault mechanics beyond immediate vault transfer and aggregate accounting.
- Buyback execution controls: DEX/route allowlist, slippage bounds, keeper permissions, liquidity thresholds, and treasury emergency controls.

Selected protocol-fee denomination model:

The selected model is stablecoin collection with staking-token buybacks and staking-token payouts.

- Requesters pay protocol fees and node payouts in a stablecoin payment token.
- Node fulfillment revenue remains stablecoin-denominated for predictable operator economics.
- The hub routes the protocol-fee share to a protocol vault.
- The protocol vault periodically uses stablecoin fee revenue to buy the staking token on the open market.
- Bought-back staking tokens are distributed to stakers/delegators according to the final staking-accounting policy.
- The final implementation must separate `paymentToken` and `stakingToken`; the current hub prototype still uses one ERC20 for both.
- Reward accounting should avoid per-staker loops, likely via an accumulated-reward-per-stake model plus explicit claims.

Rationale:

- Stablecoin fees preserve clean buyer UX and predictable oracle pricing.
- Stablecoin node payouts better match real operator costs.
- Buybacks connect protocol usage to staking-token demand without forcing every requester to acquire the staking token directly.
- Token payouts keep staker upside in the native asset while leaving protocol revenue collection stable.

## Verification Snapshot

Commands run on 2026-05-04:

- `forge test --offline` from `contracts/`: passed, 24 tests.
- `go test ./...` from `node/`: passed, no Go test files.
- `cargo +1.91.1 test --manifest-path rust_node/Cargo.toml --lib` from repo root: passed, 2 tests.
- `nargo check` from `rust_node/noir/flat_tuple`: passed.
- `npm run build` from `frontend/`: passed after reinstalling the missing generated Next.js SWC optional binary in `node_modules`.

Known local caveat:

- Plain `cargo test --manifest-path rust_node/Cargo.toml --lib` from repo root uses Rust 1.88.0 in this workspace and fails dependency version checks; use `cargo +1.91.1 ...` or update the default toolchain.

## Near-Term Priority Tree

1. Prove the Noir path end to end.
   - Generate and wire the Noir verifier artifact/deploy flow.
   - Run a live `bb prove`/`bb verify` cycle with a captured Primus sample.
   - Add the Primus fixture as a regression test for request mask, response commitment, and callback binding.

2. Harden exact request-template matching.
   - Decide whether semantic exact JSON masks are sufficient or whether the circuit should also prove byte-for-byte canonical request-body ordering and whitespace.
   - If byte-for-byte is required, add a canonical string-template proof and fixtures.

3. Move allocation from manual to protocol-driven.
   - Add bid reservation, timeout, retry, slashing/collateral, and stake-weight allocation.
   - Teach the node scanner about reservation state and durable retries.

4. Finish staking economics.
   - Implement staker fee distribution.
   - Implement stablecoin protocol-fee vault custody.
   - Implement buyback execution and staking-token reward distribution.
   - Separate payment token and staking token mechanics.

5. Tighten runtime/onchain observability.
   - Inspect hub callback-success event results after submission.
   - Add production finality handling around scanner/submission.

6. Decide SP1 fate.
   - Repair public-values compatibility or remove from the active path.
