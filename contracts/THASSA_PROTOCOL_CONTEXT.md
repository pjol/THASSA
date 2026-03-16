# THASSA Protocol Context (v0 Centralized Provider)

This document captures the currently agreed implementation context for onchain work.

## Goal

Enable any client contract to consume offchain oracle updates through a `ThassaOracle` extension and a shared `ThassaHub` router.

Near term:
- centralized provider nodes
- provider authenticity via signatures
- shape validation + hub routing + fee settlement

Long term:
- replace signature verification with ZkTLS/ZkVM proof verification
- keep external hub interfaces stable

## Roles

- Client contract: inherits/implements `ThassaOracle` extension and exposes `updateOracle(bytes callbackData)` callback.
- User: requests updates and pays for fulfillment.
- Provider node: produces update payload + proof (signature now, zk later).
- Thassa Hub: validates proof + shape, routes callback, and settles protocol/node fees.

## Core Data Model (interface-stable)

Use a generic proof envelope so verification backend can change without changing hub function signatures.

```solidity
struct ProofEnvelope {
    uint8 scheme;        // 1 = centralized signature, 2 = zk proof, etc.
    bytes verifierData;  // scheme-specific bytes consumed by verifier
}

struct UpdateEnvelope {
    address client;              // contract to callback
    uint64 clientVersion;        // extension version guard
    bytes32 queryHash;           // hash of canonical query/prompt
    bytes32 shapeHash;           // hash of canonical expected shape spec
    bytes32 modelSpecHash;       // hash(model + version + params)
    uint64 requestTimestamp;     // anti-replay context
    uint64 expiry;               // request expiration
    bytes callbackData;          // ABI-encoded payload sent to client
    bytes providerContext;       // optional metadata (request id, trace id)
}
```

Rationale:
- `callbackData` is generic for arbitrary future shapes.
- hub validates metadata/hash commitments before callback.
- proof system only attests to `keccak256(abi.encode(UpdateEnvelope))`.

## Flow A: Manual Update

1. User and provider coordinate offchain.
2. Provider returns `(UpdateEnvelope, ProofEnvelope)` to user.
3. User submits to hub with protocol fee.
4. Hub verifies:
   - proof validity
   - request integrity (client/version/query/shape/model binding)
   - freshness/expiry/replay constraints
5. Hub calls client `updateOracle(callbackData)` in `try/catch`.
6. Regardless of callback success, settlement completes:
   - protocol flat fee collected
   - node payout (if applicable in manual path)
   - request marked finalized (no replay)

## Flow B: Auto Update (Bid + Fulfillment)

1. User opens bid on hub (`bidAmount`, constraints, expiry).
2. Node reserves bid by posting collateral.
3. Reservation window is short (current target from latest discussion: 2 minutes).
4. Node produces update offchain and submits via `updateAndFulfillBid`.
5. Hub runs the same validation path as manual update.
6. Hub callback uses `try/catch`; settlement still occurs either way.
7. On successful proof+shape validation:
   - protocol flat fee taken from bid amount
   - node receives payout
   - collateral released
8. On expiration/failure:
   - bid state resolves according to timeout rules
   - collateral slashing/refund policy applies

## Validation and Settlement Invariants

- Bid resolution depends only on:
  - proof validity
  - requested shape correctness / integrity checks
- Client callback revert does not block settlement.
- Hub-level validation must be sufficient to prevent malformed payload payouts.
- Callback should be isolated in `try/catch` to avoid DoS on settlement path.

## Client Contract Requirements

- Must expose deterministic query/spec metadata used by hub integrity checks.
- Must treat `callbackData` as ABI-decoded payload for the declared shape.
- Should avoid external dependencies inside callback path.
- If callback decode fails, that is client integration fault, not hub proof fault.

## Excalidraw Notes Integrated

From the provided board:
- Hub is routing + fee collector/distributor.
- Two update paths: manual and auto bid flow.
- Auto flow includes bid lock + short reservation + collateral.
- Structured output is transformed to ABI-encoded callback data.
- Contracts define expected shape using ABI-like schema commitments.

## Current Repository Status (Implementation Gaps)

- `src/ThassaHub.sol` is empty.
- `src/ThassaOracleUpgradeable.sol` is empty.
- `interfaces/IThassaHub.sol` is not valid Solidity as written (e.g. `Model memory` enum field, interface fn visibility usage style, incomplete API).
- `interfaces/IThassaOracle.sol` callback signature conflicts with `src/ThassaOracle.sol`.
- `src/ThassaOracle.sol` has compile issues (`string storage` state vars/constructor params, missing `AccessControl` inheritance usage).
- `src/ThassaToken.sol` imports `ERC20` but inherits `ERC20Upgradeable`.

## Immediate Next Implementation Slice

1. Finalize canonical structs/events/errors for hub + oracle interfaces.
2. Implement proof verifier abstraction (`IProofVerifier`) with a signature verifier adapter first.
3. Implement manual path end-to-end with replay protection and settlement invariants.
4. Implement bid lifecycle state machine and `updateAndFulfillBid`.
5. Add tests focused on:
   - payout always settles despite callback revert
   - proof/shape-only resolution
   - reservation expiry/collateral behavior
