# Noir Response-Binding Fix Plan

## Purpose

This plan is for fixing the current Noir proving path so that it proves the two guarantees we actually need:

1. the attested Primus material corresponds to the node's intended request shape for the bid, and
2. the on-chain `callbackData` is derived from the attested model response by the in-circuit ABI tuple transform.

This plan intentionally does not require "redact every secret everywhere on local disk" as a blocking goal. The hard requirement is that the proof submitted on-chain exposes only public information, and that the proof cannot be satisfied with a reused attestation plus arbitrary callback bytes.

## Current Problems

### Problem A: callback provenance is not proved

Today the circuit rebuilds `callback` from prover-supplied ABI words:

- `field_kinds`
- `static_words`
- `dynamic_lengths`
- `dynamic_bytes`

Those values are not derived from the attested response inside the circuit. As a result, the proof shows only that:

- the callback chunks match the prover-supplied ABI words, and
- the public inputs match the update envelope.

It does not show that the tuple came from the attested model output.

### Problem B: request binding is not proved

Today the circuit verifies the signature over the Primus public attestation envelope, but it does not prove that the signed request/parse settings correspond to the oracle spec the bid expects. In particular, the circuit does not currently prove the binding for:

- request URL
- request method
- relevant request body contents
- response parse path / key / parse type

The public `queryHash`, `shapeHash`, and `modelHash` are currently taken from `PreparedProofCommitment`, not derived from a request body or shape definition inside the circuit.

### Problem C: the attested response bytes are not part of the Noir proof

The Rust workflow currently extracts structured output from:

- `PrimusAttestationData.private_data.plain_json_response[0].content`

That value never enters the Noir circuit. The circuit only sees the signed public attestation fields.

## Required End State

After this fix, the Noir path must prove all of the following:

1. A valid Primus attestation signature from the configured attestor was verified.
2. The attestation recipient equals the node wallet / fulfiller address used in the update.
3. The attested request corresponds to the oracle spec and request template the node intended to execute.
4. The attested response body used by the node is the same response body committed by Primus.
5. The structured output used for fulfillment was extracted from that attested response body inside the circuit.
6. The ABI tuple encoding used for `update.callbackData` was produced from that extracted structured output inside the circuit.
7. The public inputs still bind the proof to:
   - digest
   - bid id
   - auto-flow flag
   - client
   - fulfiller
   - attestor
   - query hash
   - shape hash
   - model hash
   - client version
   - request timestamp
   - expiry
   - nonce
   - callback hash

## Non-Goals

These are not blockers for this fix:

1. Perfect local secret hygiene for transient files.
2. Rewriting the whole Primus verifier stack.
3. Supporting arbitrary JSON or arbitrary ABI types.

The proof must remain public-only on-chain. Do not add API keys or raw request headers to public inputs.

## Recommended Strategy

### Summary

Keep the same high-level public-input contract if possible, but change the Noir witness and circuit so the callback is derived from attested response bytes rather than from precomputed ABI words.

The recommended implementation path is:

1. feed the attested response body into the Noir witness,
2. prove that response body matches the commitment embedded in Primus `encodedData`,
3. parse `choices[0].message.content` inside the circuit,
4. parse that JSON string into the flat tuple expected by the client shape,
5. ABI-encode the tuple inside the circuit,
6. expose callback chunks as public inputs exactly as the Solidity verifier expects today.

### Why this path

This is the smallest architecture change that actually restores the intended trust boundary:

- keep Noir
- keep the existing verifier shape if possible
- move response extraction and ABI encoding from Rust into the circuit
- keep sensitive request/response material private witness only

## Phase 0: Safety Gate

This step is strongly recommended before the full fix lands.

### Goal

Prevent the current unsafe Noir path from being used as if it were production-safe.

### Suggested changes

1. Either change the default backend back to `sp1`, or
2. keep `PROOF_BACKEND=noir` but make the node return a hard error unless an explicit `ALLOW_INSECURE_NOIR_UNTIL_RESPONSE_BINDING=true` flag is set.

### Files

- `rust_node/src/config.rs`
- `rust_node/src/prover.rs`
- `rust_node/src/workflow.rs`
- `rust_node/README.md`

## Phase 1: Lock Down the Exact Primus Data Model

### Goal

Before coding the circuit, document what Primus is actually committing to in `encodedData`.

### Tasks

1. Capture one real `content.encodedData` sample from the current workflow.
2. Record the exact structure of:
   - `public_data[0].attestation.data`
   - `private_data.plain_json_response[0].content`
   - any related response identifiers needed to connect the committed data to the plain response
3. Compare that sample against the logic used by the official Rust verifier path referenced in `production_implementation.md`.
4. Write down the minimal commitment equation the Noir circuit must reproduce for "this private response body matches the Primus commitment."

### Deliverable

Add a short section to this document or a sibling note with:

- the sample field shape
- the commitment formula
- the exact bytes that must be re-hashed in-circuit

### Important note

Do not assume `public_data.attestation.data` is the plain structured output. The repo note already says it contains committed hashes in hash-comparison mode.

## Phase 2: Redesign the Noir Witness

### Goal

Remove prover-controlled callback bytes from the trust boundary.

### Current witness fields to retire as proof sources

These should no longer be the source of truth for the callback:

- `static_words`
- `dynamic_lengths`
- `dynamic_bytes`
- `callback_chunks`

They may remain temporarily during migration, but the final circuit must derive them from the attested response and the expected shape, not treat them as independent witness inputs.

### New witness content to add

Add private witness inputs for:

1. the attested plain response body:
   - likely `private_data.plain_json_response[0].content`
2. any response metadata needed to reproduce the Primus commitment:
   - response id if required
   - any committed hash fields extracted from `attestation.data`
3. the expected flat tuple schema in circuit-friendly form:
   - field count
   - field names as fixed-size byte arrays
   - field type tags as enums, not pre-encoded ABI bytes
4. request-binding metadata:
   - expected request URL
   - expected request method
   - expected response key name
   - expected response parse type
   - expected response parse path
5. shape-binding metadata:
   - either the canonical shape string, or
   - a canonical list of `(name, type)` fields plus a circuit-side hash into `shapeHash`
6. query/model binding metadata:
   - query string
   - model string

### What must stay out of public inputs

Do not expose:

- OpenAI API key
- raw Authorization header
- raw request body
- raw response body

Those can remain private witness data if needed for proof generation.

### Files

- `rust_node/src/noir.rs`
- `rust_node/noir/flat_tuple/src/main.nr`

## Phase 3: Prove Primus Response Inclusion

### Goal

Prove that the private response bytes supplied to Noir are the same response bytes committed by the signed Primus attestation.

### Recommended implementation

Mirror the minimal hash-comparison logic needed from the official Primus verifier path:

1. Parse or otherwise decode the committed response data from `attestation.data`.
2. Recompute the commitment over the private `plain_json_response[0].content`.
3. Assert equality with the committed value inside the signed attestation.

### Important constraint

This phase is the critical bridge from:

- "signed public attestation metadata"

to:

- "the actual private HTTP response body the node used."

Without this bridge, parsing the response in-circuit is still not sufficient.

### Implementation note

If the official Primus response-commitment logic is too large to port whole, isolate only the response-body commitment path actually used by the current request mode. Keep the supported mode narrow and explicit.

## Phase 4: Prove Request Binding to the Oracle Spec

### Goal

Show that the signed request and parse settings used by Primus match the intended oracle spec for the bid.

### What must be constrained

At minimum:

1. request URL equals the expected OpenAI endpoint
2. request method is `POST`
3. attested response parse settings equal:
   - `key_name = structured_output`
   - `parse_type = json`
   - `parse_path = $.choices[0].message.content`
4. the attested request body contains the intended:
   - model
   - query
   - expected output schema / shape description

### Recommended implementation

Do not try to prove equality on the entire raw request body string first. Instead:

1. pass the private request body JSON string into the circuit,
2. implement a narrow JSON extractor that pulls only the fields the node depends on,
3. hash the extracted query / shape / model strings in-circuit,
4. compare them to the existing public `queryHash`, `shapeHash`, and `modelHash`.

This preserves the current public-input contract and avoids exposing the raw body on-chain.

### Header handling

Do not make exact `Authorization` header equality a blocking proof condition unless it is easy. The account used to call OpenAI is not part of the on-chain trust statement.

If header checking is implemented at all, keep it limited to public, non-secret fields such as `Content-Type`.

## Phase 5: Parse the OpenAI Response in Noir

### Goal

Move the structured output extraction from Rust into the circuit.

### Scope

Support only the response shape we already depend on:

- a JSON object response body
- `choices[0].message.content` as a JSON string
- that string decoding into a flat JSON object

### Recommended parser scope

Keep the parser intentionally narrow:

1. Parse only the minimal subset of JSON needed for:
   - object keys
   - string values
   - integer values
   - booleans
   - hex strings / byte strings if already supported by the formatter
2. Reject anything outside the currently supported shape DSL.
3. Preserve the existing flat primitive tuple restriction.

### Files

- `rust_node/noir/flat_tuple/src/main.nr`

It may be cleaner to split helper code into new Noir source files if the main file becomes too large.

## Phase 6: Do the ABI Tuple Transform in Noir

### Goal

Make the circuit itself perform the same conversion the Rust formatter currently does.

### Required behavior

The in-circuit encoder must match `rust_node/src/format.rs` for all supported types:

- `string`
- `bytes`
- `bytesN`
- `bool`
- `address`
- `uint*`
- `int*`

### Recommended implementation

1. Keep Rust `format.rs` as the reference behavior.
2. Replace the current Noir ABI source inputs with:
   - parsed field values from the attested structured output
   - field type tags from the expected shape
3. Reconstruct:
   - static ABI words
   - dynamic heads
   - dynamic tails
   - callback chunks
4. Keep the current callback chunk public-input layout if possible so Solidity changes stay minimal.

### Important rule

Rust may still compute the callback off-circuit for debugging and comparison, but the proof must not depend on Rust-precomputed callback bytes as witness truth.

## Phase 7: Update Rust Witness Construction

### Goal

Change Rust from "precompute the callback and feed it into Noir" to "prepare only the data Noir legitimately needs."

### Required Rust changes

#### `rust_node/src/workflow.rs`

1. Keep extracting the structured output off-circuit only for:
   - logging
   - debugging
   - optional cross-checks
2. Do not treat the Rust-extracted structured output as the proof source of truth.
3. Continue computing the public commitment values used by the contract:
   - digest
   - query hash
   - shape hash
   - model hash
   - request timestamp
   - expiry
   - nonce
4. Build the Noir witness from:
   - Primus public attestation fields
   - Primus private response fields
   - expected shape metadata
   - expected query / model / parse settings

#### `rust_node/src/noir.rs`

1. Add witness structs for:
   - attested private response body
   - expected shape metadata
   - expected request/parse metadata
2. Remove `AbiEncodingPlan` as the source of callback truth for Noir.
3. Keep `build_abi_encoding_plan` only as:
   - a debug cross-check, or
   - a unit-test reference implementation
4. Compare the proof-produced public callback hash/chunks against the Rust formatter in tests, not as the trust source in production logic.

#### `rust_node/src/types.rs`

Add any new witness-side helper structs needed to keep the workflow code readable.

## Phase 8: Keep or Adjust the Solidity Verifier

### Preferred path

Preserve the current public-input layout so that `ThassaNoirVerifier` only needs minimal or no changes.

### If layout changes

If new public inputs are unavoidable, then:

1. update `contracts/src/ThassaNoirVerifier.sol`
2. update `contracts/test/ThassaNoirVerifier.t.sol`
3. document the final layout in both:
   - the Solidity verifier
   - the Rust Noir helper

### Important constraint

Do not add any public input that reveals:

- raw request body
- raw response body
- API keys
- auth headers

## Phase 9: Testing Plan

### Unit tests in Rust

Add tests for:

1. attestation witness preparation from a sample `encodedData`
2. parsing of the committed response data out of `attestation.data`
3. request-binding extraction:
   - correct URL
   - correct method
   - correct parse path
   - correct model/query/shape binding
4. ABI encoding parity against `format.rs`
5. timestamp conversion parity:
   - millis to seconds
   - exact equality against public input request timestamp

### Circuit tests

Add Noir-side or integration-level tests for:

1. valid sample proof from a real captured `encodedData`
2. tampered callback value with unchanged attestation should fail
3. tampered response body with unchanged attestation commitment should fail
4. tampered parse path should fail
5. tampered model/query/shape binding should fail
6. tampered fulfiller / recipient binding should fail
7. tampered timestamp should fail

### Solidity tests

Add or extend tests to cover:

1. accepted valid Noir proof
2. rejection when callback hash mismatches
3. rejection when fulfiller mismatches
4. rejection when attestor mismatches
5. rejection when public input count/layout is wrong

## Acceptance Criteria

This fix is complete only when all of the following are true:

1. The Noir proof cannot be generated for arbitrary callback bytes using a reused valid attestation.
2. The Noir proof cannot be generated for a request body whose query/model/shape do not match the bid's public hashes.
3. The circuit derives the callback bytes from the attested response body, not from prover-supplied ABI words.
4. The on-chain proof submission contains only public information.
5. A captured real-world Primus sample produces a passing proof after the new circuit path is implemented.
6. The old unsafe behavior is covered by regression tests so it cannot silently return.

## Suggested File Touch List

- `NOIR_RESPONSE_BINDING_PLAN.md`
- `rust_node/src/workflow.rs`
- `rust_node/src/noir.rs`
- `rust_node/src/types.rs`
- `rust_node/src/format.rs`
- `rust_node/noir/flat_tuple/src/main.nr`
- `contracts/src/ThassaNoirVerifier.sol`
- `contracts/test/ThassaNoirVerifier.t.sol`
- `rust_node/README.md`
- `README.md`

## Suggested Implementation Order

1. Add the Phase 0 safety gate.
2. Capture and document one real Primus `encodedData` sample.
3. Implement the response-commitment binding in Noir.
4. Implement request-binding checks in Noir.
5. Implement in-circuit extraction of `choices[0].message.content`.
6. Implement in-circuit parsing of the flat structured JSON object.
7. Implement in-circuit ABI tuple encoding.
8. Rewire Rust witness construction.
9. Re-run Solidity/Rust/integration tests.
10. Only after that, restore Noir as a normal supported backend.

## Notes for the Implementer Agent

1. Treat `rust_node/src/format.rs` as the canonical ABI encoding reference.
2. Treat `rust_node/zkvm/program/src/main.rs` as the canonical statement of what the old SP1 path was proving.
3. Treat `production_implementation.md` section 4.1 as the source-of-truth warning that full `encodedData` matters.
4. Do not optimize for generality first. Optimize for a narrow, correct, testable proof statement that matches the current THASSA request/response shape.
5. If the full Primus response-commitment logic is too large for one pass, first land a version that proves one supported mode only and explicitly rejects everything else.
