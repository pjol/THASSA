# Rust Node

Production-oriented THASSA node with:

- Primus-backed attestation orchestration
- SP1 proof generation and submission
- HTTP API for manual update requests
- block scanner for auto-fulfilling bids

## Layout

- `src/`: node/orchestrator, chain reads, Primus client, proof submission
- `bridge/`: Primus JS bridge used for the algorithm runtime
- `zkvm/lib`: shared proof input types
- `zkvm/program`: SP1 guest program
- `zkvm/script`: SP1 helper binaries for ELF export and VK extraction

## Build Primus Bridge

```bash
cd rust_node/bridge
npm install
```

## Export ELF

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

## Run Node

```bash
cp rust_node/.env.example rust_node/.env
cargo run --manifest-path rust_node/Cargo.toml
```

Endpoints:

- `GET /healthz`
- `POST /v1/update`

## Notes

- In command bridge mode, Primus attestation is executed in a single bridge invocation so the SDK runtime is not lost across subprocess boundaries.
- `SP1_ELF_PATH` defaults to `artifacts/thassa-zkvm-program.elf` if present.
