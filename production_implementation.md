# Production Implementation Notes

## Goal

Replace the current centralized signer model with a production pipeline that:

1. Uses Primus ZkTLS to attest to the upstream LLM/API call.
2. Uses a Succinct SP1 zkVM program to verify the Primus attestation, transform the returned data into the oracle callback payload, bind the fulfiller address, redact private information, and derive a replay-protection nonce.
3. Submits an SP1 proof onchain to the hub, where a verifier module checks the proof through Succinct's verifier contracts and unlocks/pays bids for the fulfilled update.

This document reflects a review of:

- Primus docs: https://docs.primuslabs.xyz/
- Succinct docs: https://docs.succinct.xyz/
- Relevant official repositories listed in the References section
- The current local implementation in [contracts/src/ThassaHub.sol](/Users/coding/THASSA/contracts/src/ThassaHub.sol), [contracts/src/ThassaSignatureVerifier.sol](/Users/coding/THASSA/contracts/src/ThassaSignatureVerifier.sol), [contracts/src/ThassaSP1Verifier.sol](/Users/coding/THASSA/contracts/src/ThassaSP1Verifier.sol), [rust_node/src/workflow.rs](/Users/coding/THASSA/rust_node/src/workflow.rs), and [node/internal/autofill/worker.go](/Users/coding/THASSA/node/internal/autofill/worker.go)

## Current State

The repo is now in a transition state:

- The original demo path is the actively runnable Go node plus the signature-based verifier contract.
- The production-oriented path now exists in `rust_node`.
- The contracts tree now contains both the active demo verifier and the production-oriented SP1 verifier adapter.
- The zkVM guest, proof input types, and Rust node orchestration are implemented, but full end-to-end production validation has not been completed yet.

So the project is no longer "signer-only", but it is also not yet a fully validated production pipeline. The remaining work is mostly in execution, validation, deployment wiring, and toolchain cleanup.

## Implementation Status Snapshot (2026-03-19)

### Implemented so far

1. Contract verifier redesign
   - Added [contracts/src/ThassaSP1Verifier.sol](/Users/coding/THASSA/contracts/src/ThassaSP1Verifier.sol).
   - Updated hub/verifier interfaces for proof-envelope based validation.
   - Kept [contracts/src/ThassaSignatureVerifier.sol](/Users/coding/THASSA/contracts/src/ThassaSignatureVerifier.sol) as the active demo verifier path.

2. Production Rust node scaffold
   - Added the `rust_node` service with config loading, structured logging, HTTP endpoints, fulfillment workflow, chain reads, proof submission, and SP1 prover integration.
   - Added the public API routes described in [rust_node/src/server.rs](/Users/coding/THASSA/rust_node/src/server.rs).

3. Primus integration
   - Implemented a real Rust Primus client in [rust_node/src/primus.rs](/Users/coding/THASSA/rust_node/src/primus.rs).
   - Implemented request assembly, quote checks, local app-secret signing, attestation parsing, and signature verification.
   - Fixed the bridge architecture in [rust_node/bridge/primus_bridge.cjs](/Users/coding/THASSA/rust_node/bridge/primus_bridge.cjs) so attestation runs in a single bridge invocation and stdout stays machine-readable.

4. zkVM workspace
   - Added the canonical SP1 workspace under `rust_node/zkvm`.
   - Added shared proof input types in [rust_node/zkvm/lib/src/lib.rs](/Users/coding/THASSA/rust_node/zkvm/lib/src/lib.rs).
   - Implemented the guest program in [rust_node/zkvm/program/src/main.rs](/Users/coding/THASSA/rust_node/zkvm/program/src/main.rs) to verify Primus attestation data, validate the request/response linkage, reconstruct the callback payload, bind the fulfiller, derive the nonce, and commit ABI-encoded public values.

5. Proof tooling and docs
   - Added the SP1 helper binaries workspace under `rust_node/zkvm/script`.
   - Added ELF export support in [rust_node/zkvm/script/src/bin/export_elf.rs](/Users/coding/THASSA/rust_node/zkvm/script/src/bin/export_elf.rs).
   - Added setup/run notes in [rust_node/README.md](/Users/coding/THASSA/rust_node/README.md).

### Validation that has actually run

1. Rust node host compile
   - `cargo +1.91.1 check --target-dir target/codex-root`
   - Result: passed

2. zkVM guest compile
   - `cargo +1.91.1 check --manifest-path rust_node/zkvm/Cargo.toml -p thassa-zkvm-program --target-dir rust_node/target/zkvm-program-check`
   - Result: passed

3. zkVM script/helper crate compile
   - `cargo +1.91.1 check --manifest-path rust_node/zkvm/Cargo.toml -p thassa-zkvm-script --target-dir rust_node/target/zkvm-script-check`
   - Result: failed in the local SP1 toolchain, not in repo source
   - Current blocker: the installed `+succinct` toolchain rejects `-misched-prera-direction=bottomup`

4. Foundry contract tests
   - `forge test`
   - Result: currently failing in the local workspace because Foundry is recursing into vendored `contracts/lib/@openzeppelin*` test/fv trees and hitting unresolved imports
   - This is a workspace/dependency resolution problem that needs cleanup before the contract test run is trustworthy again

## Remaining Tasks That Have Not Yet Been Run

These are the concrete implementation and validation tasks that are still outstanding as of this snapshot.

### Contracts and onchain wiring

1. Fix the Foundry workspace/import resolution so `forge test` only evaluates the intended project sources and tests, then rerun the contract test suite.
2. Deploy `ThassaSP1Verifier` against a real SP1 verifier address and an actual program verification key.
3. Rerun the deployment scripts end to end against the new verifier path.
4. Execute a real onchain proof submission through the hub and confirm bid unlocking/payout behavior.

### SP1 toolchain and proof artifacts

1. Repair or refresh the local SP1 `+succinct` toolchain so the `zkvm/script` crate builds cleanly.
2. Run the ELF export binary and generate the actual proof program ELF artifact.
3. Run the VKey extraction flow and record the deployment-time verification key.
4. Generate a real proof from `rust_node` using production-shaped witness data instead of stopping at compile-time validation.
5. Exercise a private network proof request through Succinct and confirm proof polling, completion, and local verification.

### Primus execution validation

1. Run the Rust Primus client against live Primus infrastructure for a real attestation request.
2. Compare a Rust-generated request/signature/attestation flow against the official JS SDK for the same fixed fixture.
3. Validate timeout, quote expiry, and quota-exhaustion behavior under real network conditions.
4. Decide whether the remaining JS bridge is acceptable for bring-up or whether we want to fully replace it now with a native Rust transport/runtime path.

### Node runtime and workflow validation

1. Exercise `POST /v1/update` end to end with a real request, live attestation, proof generation, and returned payload.
2. Exercise the bid scanner / autofulfillment path against a live local chain and confirm it picks up new bids and fulfills them correctly.
3. Run the full submit-on-chain flow from the Rust node and confirm the oracle callback data changes state as expected onchain.
4. Validate duplicate submission / replay handling in the hub against the current nonce strategy.
5. Confirm that logging output is detailed enough for operators without leaking secrets.

### Architecture and hardening decisions still open

1. Revisit the final nonce formula. The current implementation uses the requested `sha256(timestamp || api_key)` path, but the stronger bound formula is still a live design consideration.
2. Decide whether the circuit should commit full callback bytes or only `callbackHash` long term.
3. Decide whether to keep the legacy demo node around once the Rust path is fully validated.
4. Decide how aggressively we want to pursue a pure-Rust Primus execution path versus accepting the JS bridge for the first production rollout.

## High-Level Target Architecture

Recommended target flow:

1. The node detects a fulfillable bid from the hub.
2. The node fetches the oracle spec and any bid-linked request context from chain.
3. The node triggers a Primus attestation for the upstream HTTP/LLM request.
4. The node packages the Primus attestation plus private witness data into an SP1 proof input.
5. The SP1 program:
   - verifies the Primus attestation,
   - verifies the response corresponds to the intended request,
   - transforms the source data into the expected oracle output shape,
   - derives the callback payload bytes or their canonical preimage,
   - binds the fulfiller address,
   - derives a replay nonce,
   - redacts sensitive data from the public output,
   - commits public values for onchain verification.
6. The node requests a private TEE proof from Succinct's prover network.
7. The node submits the proof and public values to the hub.
8. The hub calls a verifier module that checks the SP1 proof through Succinct's onchain verifier contracts.
9. If valid, the hub releases bid value and forwards the callback update to the oracle contract.

## Primus Findings

### 1. The Primus JS `sign()` path is local EVM signing

The official Primus JS SDK exposes a `sign()` helper, but in the inspected code that helper does not call a remote Primus signing service. It derives an `ethers.Wallet` from `appSecret`, hashes the request parameters, and signs locally.

Practical implication:

- The shipped `sign()` flow is local application signing, not a hosted attestation-signing API.
- This matters because it means "just reproduce Primus signing with a direct HTTP call" is not the full story.

Inference from the SDK code:

- I did not find an official documented pure-HTTP Primus attestation generation flow in the inspected SDKs/repos.
- Based on the shipped code, the attestation flow still depends on Primus client-side/backend SDK logic rather than a simple public REST endpoint.

### 2. Primus has a backend-capable SDK, but it is still JS/native-heavy

The official backend path appears to be `@primuslabs/zktls-core-sdk`.

Important characteristics from the inspected code:

- It supports backend/server attestation flows.
- It assembles structured request parameters, response extraction rules, and attestation conditions.
- It still uses local signing with the app secret.
- It relies on JS plus native/WASM support rather than a thin HTTP-only protocol.
- It appears to communicate with Primus network infrastructure through SDK-managed internals, including websocket/native components.

Practical implication:

- A Rust-only node is attractive, but the Primus attestation-generation step may still require a JS runtime unless Primus exposes or documents a more direct protocol path.
- This is the biggest integration uncertainty in the current production plan.

### 3. Primus already exposes onchain attestation verification contracts

The official Primus contracts repository includes attestation structs and a verifier contract that recovers the attestor signature over a canonical attestation encoding.

Practical implication:

- Primus attestation format is explicit enough to be treated as a structured proof input.
- We do not necessarily need to verify Primus attestations onchain directly if the zkVM already verifies them, but the contract definitions are useful as a specification anchor for the circuit and public-values encoding.

### 4. Primus already has a Rust verification crate designed for zkVM usage

This is the most important Primus-side production finding.

The `zktls-att-verification` crate is specifically designed to verify Primus attestation data in Rust. Based on the repository and examples, it verifies:

- the attestation signature,
- encrypted attestation payload handling,
- URL allowlist / request constraints,
- parsing of attested request/response material into structured data.

Practical implication:

- This is exactly the piece we want inside an SP1 program.
- It gives us a credible path to proving "the transformed oracle output came from a valid Primus-attested upstream response" without exposing private witness data.

### 4.1 The zkVM input must preserve Primus `encodedData`, not a flattened attestation

While implementing the production node, one important detail became concrete:

- the Primus SDK's `content.encodedData` payload is not just the flat attestation object,
- it is the full attestation-data bundle consumed by `zktls-att-verification`,
- including `verification_type`, `public_data`, and `private_data`.

For hash-comparison mode in particular:

- `public_data[*].attestation.data` contains committed hashes,
- `private_data.plain_json_response` contains the raw HTTP JSON bodies,
- and the Rust verification crate recomputes the hashes from those plain responses.

Practical implication:

- the production node and zkVM program must pass around the full `encodedData` blob,
- not just the first attestation object or a locally extracted "revealed data" view,
- otherwise the SP1 program cannot use the official Primus verification crate correctly.

### 5. Primus already has an official Primus + Succinct reference repo

The `DVC-Succinct` repository is strong evidence that the intended production pattern is:

- Primus attestation offchain,
- Rust/SP1 program verifies attestation,
- SP1 proof is generated and later verified.

Practical implication:

- We should treat Rust-first as the default production direction.
- We are not stitching together two unrelated ecosystems. There is already an official integration pattern pointing the same way.

## Succinct Findings

### 1. SP1 is Rust-first end to end

Succinct's program model is exactly what we need:

- a Rust zkVM program for deterministic proof logic,
- a Rust prover client for local or network proof generation,
- standard onchain verifier contracts.

This matches our required responsibilities well.

### 2. Private TEE proving is supported, but with specific constraints

The inspected SP1 SDK and examples show support for network proving through a "private" mode. The relevant pattern uses the network prover client in private mode and reserved fulfillment.

Practical implication:

- Private TEE proving is a real, supported path.
- The node can request private proofs rather than proving locally.
- The production node should be built around the network prover client and its async proof lifecycle.

### 3. Onchain verification should use SP1 verifier gateway contracts

Succinct ships verifier contracts and a gateway pattern for routing proofs to the correct verifier version.

Practical implication:

- Our new verifier module should not embed custom cryptography.
- It should call the SP1 verifier/gateway contract with:
  - the program verification key,
  - committed public values,
  - proof bytes.

### 4. The proof should be the only thing the hub trusts

The production verifier module should become an SP1-proof adapter. It should validate:

- the SP1 proof itself,
- that the committed public values correspond to the bid/oracle/update being submitted,
- that the callback payload and payout target are bound to the proof.

The fulfiller should no longer be trusted because they signed something. They should only be trusted if they can supply a valid proof for the exact update being claimed.

## Recommended Node Architecture

## Recommendation

Build the production node around Rust, with a temporary Primus JS bridge if needed.

### Why Rust-first is the best fit

- Succinct SP1 proving, proof submission, and circuit code are all Rust-native.
- Primus already provides a Rust verification crate for attestation verification inside the zkVM.
- Primus also provides an official Primus + Succinct Rust example.
- Moving the node core to Rust reduces cross-language complexity in the proving and submission path.

### Why a single binary may still be difficult at first

The likely blocker is Primus attestation generation, not proof generation.

Based on the inspected official SDK code:

- Primus attestation generation currently appears to be mediated by their JS/native SDK.
- I did not find a documented pure-HTTP backend flow that would let us drop the JS dependency immediately.

Recommended pragmatic approach:

1. Build the production orchestrator in Rust.
2. Keep a very small Primus bridge component for attestation generation if needed.
3. Pass the resulting attestation artifacts into the Rust proving pipeline.
4. Revisit "single binary" only after verifying whether Primus exposes a stable low-level protocol or official non-JS backend path.

### Candidate deployment shapes

Option A: Rust node + Node sidecar

- Lowest implementation risk.
- Fastest path to production correctness.
- Makes the Primus dependency explicit and isolated.

Option B: Rust node + bundled Node subprocess

- Preserves a mostly one-command deployment experience.
- Still not a truly pure single binary.
- Operationally acceptable if hidden behind one launcher.

Option C: Pure Rust node

- Best long-term shape.
- Highest near-term risk.
- Only advisable if Primus confirms a stable protocol that we can reproduce without the JS SDK, or if they ship a Rust attestation-generation SDK.

## Additional Language Findings

These findings were added specifically to answer two architecture questions:

1. Can we use Succinct's prover network from JavaScript with a prebuilt ELF and circuit inputs?
2. Can we request Primus attestations from Rust using an official Rust library?

### 1. Succinct JS prover-network submission path

Short answer:

- I did not find an official JavaScript or TypeScript prover-network submission SDK in Succinct's docs or repositories.

What I found instead:

- The supported prover-network path lives in the Rust `sp1-sdk`.
- The network client is implemented in Rust and handles:
  - program registration,
  - artifact creation,
  - presigned upload of ELF/stdin artifacts,
  - request signing,
  - proof request submission,
  - proof status polling,
  - proof download and deserialization.
- The network client uses a gRPC client plus HTTP uploads/downloads for artifacts.
- I did not find a JS package, JS examples, or docs showing the prover-network flow from JavaScript.

Practical implication:

- There is no evidence of an official "write the node in JS and call the prover network directly with a supported JS SDK" path today.
- A custom JS client may still be technically possible, because the Rust SDK is clearly speaking to a concrete network protocol and uploading artifacts through presigned URLs.
- But that would be a reimplementation of SDK internals, not an officially supported JS integration path.

Conclusion:

- If we choose a JS-first node, the unsupported piece becomes Succinct prover-network integration.

### 2. Primus Rust attestation-generation path

Short answer:

- I did not find an official Rust library for requesting Primus attestations.

What I found:

- Primus has official JS/backend SDKs for attestation generation.
- The official attestation-request flow in the inspected code is JS-based and uses:
  - `generateRequestParams(...)`,
  - local signing with the app secret,
  - `startAttestation(...)`,
  - native addon or WASM-backed algorithm execution,
  - SDK-managed network interaction.
- Primus also has an official Rust crate, but it is for attestation verification, not attestation generation.
- The official Primus + Succinct reference uses Rust on the proof-verification / zkVM side, not as evidence of a Rust attestation-request SDK.

Inference from the docs and repos:

- I did not find an official Rust equivalent to the JS `startAttestation(...)` flow.
- So a pure-Rust Primus requester would likely require us to reproduce behavior currently encapsulated by the JS/native SDK.

Practical implication:

- There is no evidence of an official "write the whole node in Rust and request Primus attestations with a supported Rust SDK" path today.
- A custom Rust requester may be possible, but it would be a reverse-engineering / reimplementation project unless Primus documents a lower-level protocol for backend attestation generation.

Conclusion:

- If we choose a Rust-first node, the unsupported piece becomes Primus attestation generation.

### Updated architecture implication

Neither of the ideal language paths is fully available today:

- JS-first is missing an official Succinct prover-network submission SDK.
- Rust-first is missing an official Primus attestation-generation SDK.

That means our realistic choices are:

Option A: Rust orchestrator + minimal JS Primus bridge

- Keeps Succinct on the official path.
- Keeps in-circuit Primus verification on the official path.
- Limits the unsupported boundary to Primus attestation generation only.
- Preserves the best future path toward a mostly single-binary Rust system.

Option B: JS orchestrator + Rust proof worker

- Keeps Primus on the official path.
- Requires Rust for proving and likely proof submission tooling anyway.
- Pushes the architecture toward a two-process system immediately.

Option C: Custom Rust Primus requester

- Best long-term binary shape.
- Highest integration risk.
- Only worth doing if we deliberately choose to own a reverse-engineered or custom client.

Option D: Custom JS Succinct prover-network client

- Lets us keep the node in JS.
- Also unsupported today.
- Likely lower leverage than Rust-first, because the proof system, verifier contracts, and zkVM program are already Rust-native.

### Recommendation after this additional review

The recommendation still points to:

- a Rust-first production node,
- a temporary minimal JS bridge for Primus attestation generation during bring-up if needed,
- and a planned native Rust Primus requester as an explicit roadmap item,
- and no attempt to force a pure single-binary deployment in phase 1.

Reason:

- The proving system is the harder, more security-sensitive, and more protocol-coupled part of the stack.
- Succinct already supports that path natively in Rust.
- Primus already supports Rust where we need it most for zkVM verification.
- So the least risky unsupported boundary is a narrow JS attestation bridge in the short term, while we build a custom Rust Primus client intentionally rather than forcing a custom JS proving client.

### Decision update

We are explicitly adding the following to the implementation plan:

- build a native Rust Primus attestation requester/client as part of the production roadmap,
- use the official JS Primus SDK only as a temporary bring-up aid if it materially accelerates integration,
- target an eventual Rust-dominant deployment shape that is as close to single-binary as practical.

This means the architecture direction is now:

- short term: Rust orchestrator/prover stack, optional JS bridge for Primus,
- medium term: replace the JS bridge with a native Rust Primus requester that reproduces the required attestation flow,
- long term: converge on a single deployable Rust service plus zkVM artifacts.

## zkVM Program Responsibilities

The SP1 program should be the core of the trust model. It should take as private witness:

- the Primus attestation package,
- any required attestation decryption/verification inputs,
- the raw response or parsed structured response,
- the API key or secret material needed for nonce derivation,
- the fulfiller address,
- the request metadata fetched by the node.

It should then prove all of the following:

1. The Primus attestation is valid.
2. The attested response came from the expected upstream request domain/path/method.
3. The transformation from source response to oracle callback payload was performed correctly.
4. The payload matches the oracle's expected shape/callback encoding rules.
5. The fulfiller address is bound into the proof.
6. Private material is not emitted in public values.
7. A replay-protection nonce was derived correctly.

### Public values the program should commit

Recommended public values:

- `hub_address`
- `oracle_address`
- `bid_id` or equivalent request identifier
- `request_timestamp`
- `fulfiller_address`
- `nonce`
- `callback_payload_hash`
- `transformed_data_hash`
- `model_or_endpoint_hash`
- `query_hash` or request-shape hash
- status/version bytes for circuit compatibility

Depending on final contract design, the program may also commit the full callback payload bytes if that makes the onchain interface simpler. If calldata size matters, committing a hash and sending the raw payload alongside the proof may be better.

## Nonce and Replay Protection

Requested design:

- derive a nonce from `sha256(request_timestamp || api_key)`

This is implementable inside the zkVM and works well for keeping the API key private.

However, there is one important caveat:

- if two requests use the same API key and the same timestamp value, they will generate the same nonce.

Recommended refinement:

- `sha256(request_timestamp || api_key || oracle_address || bid_id || request_body_hash)`

This keeps the API key private while making replay collisions substantially less likely and binding the nonce more tightly to the specific request being fulfilled.

If the simpler timestamp-plus-key construction is required for compatibility reasons, the hub should still track consumed nonces onchain.

## Verifier Contract Redesign

## Recommendation

Replace the current signature verifier module with an SP1 verifier adapter contract.

### Current verifier module

Historically, the demo verifier at `contracts/src/ThassaSignatureVerifier.sol` validated:

- `digest = keccak256(update fields)`
- ECDSA recover against a trusted signer

That demo contract remains active for the current local demo path. [contracts/src/ThassaSP1Verifier.sol](/Users/coding/THASSA/contracts/src/ThassaSP1Verifier.sol) is the production-oriented verifier path and the contract we should evolve for the real proof system.

### Proposed verifier module responsibilities

The new verifier module should:

1. Receive proof material from the hub.
2. Call Succinct's verifier gateway / verifier contract.
3. Decode the committed public values.
4. Check that the public values match the update being submitted to the hub.
5. Return success only if the proof is valid and the public commitments align with the current bid/oracle context.

### Proposed hub changes

The hub should continue to own:

- bid placement,
- bid accounting,
- payout unlocking,
- nonce-consumption tracking,
- replay protection,
- oracle callback execution.

The hub should stop owning any knowledge of how offchain proofs are produced. That should remain encapsulated in the verifier module.

### Suggested interface direction

At a minimum, the verifier path will likely need to evolve from:

- `verifyUpdate(bytes32 digest, SignedUpdate update)`

to something closer to:

- `verifyUpdate(bytes32 digest, bytes publicValues, bytes proof, bytes callbackPayload, ... )`

The exact interface can be shaped a few ways, but the central idea is that the verifier must have access to the proof artifacts and enough update context to compare against the proof's public commitments.

## Oracle Data Shaping in Production

The current demo system shapes response data offchain and trusts the node to do it honestly.

In production, shaping should be treated as part of the proved computation.

Recommended rule:

- any logic that determines the final callback payload must happen inside the zkVM program, or be recomputed inside it and committed in the public values.

That includes:

- selecting fields from the attested source response,
- type coercion,
- normalization,
- array/object reformatting,
- ABI-ready ordering or canonicalization,
- redaction of unused sensitive fields.

This is important because "correctly transformed data" is exactly the claim the proof is supposed to establish.

## Recommended Production Node Breakdown

### Offchain orchestrator

Likely Rust service responsibilities:

- scan chain for new bids and fulfillable requests,
- fetch oracle spec and bid metadata,
- trigger Primus attestation generation,
- invoke the SP1 proving flow,
- submit proof + payload onchain,
- monitor proof jobs and transactions,
- handle retries and observability.

### Attestation bridge

Temporary component if needed:

- thin JS service or child process that creates Primus attestations using the official SDK,
- returns attestation artifacts to the Rust orchestrator,
- contains the minimum possible logic.

### Proving module

Rust-native:

- constructs SP1 stdin,
- requests a private TEE proof,
- waits for async fulfillment,
- verifies proof locally before submission when practical,
- packages proof/public values for the verifier module.

## Phased Implementation Plan

### Phase 1: Contract redesign

1. Replace the ECDSA verifier module with an SP1 verifier adapter.
2. Define the onchain proof submission struct and verifier interface.
3. Add nonce tracking in the hub if not already present.
4. Decide whether the hub stores raw callback payload bytes, a payload hash, or both.

### Phase 2: Primus Rust client investigation and prototype

1. Treat the JS Primus backend SDK as the behavioral reference implementation.
2. Map the attestation request lifecycle, payload assembly, signing rules, transport endpoints, and polling semantics.
3. Identify which pieces are pure protocol and which pieces are hidden behind native/WASM algorithm code.
4. Build a minimal Rust prototype that can reproduce the backend attestation flow for one fixed request type.
5. Decide whether the Rust client is viable for full production scope or whether a temporary JS bridge is still needed during rollout.

### Phase 3: zkVM circuit prototype

1. Start from Primus's `DVC-Succinct` reference structure.
2. Replace the example transformation logic with our oracle payload shaping logic.
3. Commit the exact public values needed by the hub.
4. Test with a single oracle flow end to end.

### Phase 4: production node redesign

1. Build a Rust orchestrator.
2. Integrate SP1 private prover network flow.
3. Integrate the native Rust Primus client if phase 2 succeeds, otherwise use the temporary JS bridge.
4. Submit proofs onchain and reconcile bids automatically.

### Phase 5: hardening

1. retry logic,
2. proof/job monitoring,
3. attestation allowlists,
4. prover/network failure handling,
5. metrics and tracing,
6. replay and duplicate-submission protections,
7. stricter public-value versioning and compatibility checks.

## Main Open Questions

1. Can Primus provide or document a stable non-JS backend attestation-generation API?
2. What exact Primus attestation artifact should we persist and feed into SP1 in production?
3. Should the circuit commit the full callback payload or only its hash?
4. Should the hub remain generic across many oracle payload types, or should some payload validation move into oracle-specific adapters?
5. What exact request identifier should the proof bind to: `bidId`, `oracle address + timestamp`, or a dedicated request hash?
6. Do we want the fulfiller address to be part of payout authorization, provenance only, or both?

## Recommended Discussion Outcome

Before implementation, we should lock these decisions:

1. SP1 verifier module interface and public-values schema.
2. Final nonce derivation formula.
3. Whether the proof commits raw callback bytes or a payload hash.
4. The exact request/bid identity that the proof must bind.
5. Whether the temporary JS bridge is allowed during bring-up if the Rust Primus client is not ready in time.

## Bottom Line

The good news is that the production architecture you want is feasible and the official ecosystems already point in the right direction:

- Primus provides attestation formats and Rust-side verification support.
- Succinct provides the Rust zkVM, private TEE proving flow, and onchain verifiers.
- Primus already has an official Primus + Succinct reference project.

The main uncertainty is not the proof system. It is the attestation-generation boundary on the Primus side. Because of that, the most pragmatic production plan is:

- redesign contracts first around SP1 proof verification,
- build the proving path in Rust,
- isolate Primus attestation generation behind a minimal bridge only if needed during bring-up,
- and actively build a native Rust Primus requester so the bridge is temporary rather than architectural.

## References

Official docs:

- Primus docs: https://docs.primuslabs.xyz/
- Primus backend example: https://docs.primuslabs.xyz/primus-network/build-with-primus/for-backend/simpleexample
- Succinct docs: https://docs.succinct.xyz/
- SP1 introduction: https://docs.succinct.xyz/docs/sp1/introduction
- SP1 prover network quickstart: https://docs.succinct.xyz/docs/sp1/prover-network/quickstart
- SP1 verifier contract addresses: https://docs.succinct.xyz/docs/sp1/verification/contract-addresses

Official repositories:

- Primus JS SDK: https://github.com/primus-labs/zktls-js-sdk
- Primus Core SDK: https://github.com/primus-labs/zktls-core-sdk
- Primus contracts: https://github.com/primus-labs/zktls-contracts
- Primus attestation verification crate: https://github.com/primus-labs/zktls-att-verification
- Primus + Succinct reference: https://github.com/primus-labs/DVC-Succinct
- SP1 monorepo: https://github.com/succinctlabs/sp1
- SP1 contracts: https://github.com/succinctlabs/sp1-contracts
- SP1 project template: https://github.com/succinctlabs/sp1-project-template
