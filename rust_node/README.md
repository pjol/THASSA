# Rust Node

Production-oriented THASSA node with:

- Primus-backed attestation orchestration
- Noir-based local proof generation over Primus attestation outputs
- HTTP API for manual update requests
- block scanner for auto-fulfilling bids

## Layout

- `src/`: node/orchestrator, chain reads, Primus client, proof submission
- `bridge/`: Primus JS bridge used for the algorithm runtime
- `noir/flat_tuple`: Noir circuit that verifies the Primus attestation signature, binds fulfiller/timestamp, and reconstructs flat ABI tuple payloads inside the proof
- `zkvm/lib`: shared legacy SP1 proof input types
- `zkvm/program`: legacy SP1 guest program
- `zkvm/script`: legacy SP1 helper binaries for ELF export and VK extraction

## Build Primus Bridge

```bash
cd rust_node/bridge
npm install
```

## Run Node

```bash
cp rust_node/.env.example rust_node/.env
cargo run --manifest-path rust_node/Cargo.toml
```

Important env knobs:

- The node loads `.env` from the current directory, or `rust_node/.env` when run from the repo root. Relative paths in `rust_node/.env` are resolved from `rust_node/`.
- `PROOF_BACKEND=noir` enables the local Noir proving path. The current Noir circuit binds one model string to both `update.modelHash` and `request.body.model`, so Noir oracle specs must use the exact OpenAI API model name such as `gpt-5.4`, not `openai:gpt-5.4`.
- `NOIR_ONCHAIN_SUBMISSION_ENABLED=false` is the default safety gate. Set it to `true` only after the hub points at a deployed `ThassaNoirVerifier` whose expected attestor matches `PRIMUS_ATTESTOR_ADDRESS`.
- `AUTO_FULFILL_BIDS=false` is the safe default. Auto fulfillment submits on-chain and requires the Noir on-chain gate when `PROOF_BACKEND=noir`.
- `ATTESTATION_LOG_MODE=redacted` stores redacted bundles. Use `full` only for short-lived debugging, or `off` to disable persistence.
- `BID_SCAN_BACKFILL_BLOCKS`, `BID_SCAN_MAX_BLOCK_RANGE`, and `BID_FULFILLMENT_MAX_ATTEMPTS` tune scanner catch-up and retry behavior.

Endpoints:

- `GET /healthz`
- `POST /v1/update`

## Legacy SP1 Helpers

```bash
cargo run --manifest-path rust_node/zkvm/script/Cargo.toml --bin export-elf
```

Default output:

```text
rust_node/artifacts/thassa-zkvm-program.elf
```

## Print Program VKey

```bash
cargo run --manifest-path rust_node/zkvm/script/Cargo.toml --bin vkey
```

Use the printed hash when deploying `ThassaSP1Verifier`.

## Notes

- In command bridge mode, Primus attestation is executed in a single bridge invocation so the SDK runtime is not lost across subprocess boundaries.
- The bundled Noir circuit verifies the signed Primus attestation contents, binds the node wallet and request timestamp into public inputs, and proves the flat tuple ABI assembly step over the attested structured output.
- Noir inputs are length-capped by fixed circuit witness arrays. Current caps are query 2,048 bytes, expected shape 1,024 bytes, model 64 bytes, input data JSON 4,096 bytes, full OpenAI request body 8,192 bytes, raw response body 8,192 bytes, extracted structured output 4,096 bytes, callback data 1,024 bytes, dynamic tuple field values 256 bytes, and at most 16 tuple fields. The circuit also enforces `query + inputDataJson + schema <= 10,000` bytes for the request prompt context.
- Noir witness/proof temp files are written with restrictive permissions and cleaned up after each proof attempt where possible.
- `SP1_ELF_PATH` still defaults to `artifacts/thassa-zkvm-program.elf` if you switch `PROOF_BACKEND=sp1`.
