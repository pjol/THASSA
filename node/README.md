# THASSA Demo Provider Node (Go)

Quick local demo service that:
- accepts `query` + output shape
- calls ChatGPT in structured output mode
- ABI-encodes callback data
- computes/signs the current `UpdateEnvelope` digest and returns a signature-backed `ProofEnvelope`
- automatically injects a reserved `_fulfilled: bool` field into the LLM schema and proof public values
- scans chain every 2 seconds for `BidPlaced` and tries `submitAutoUpdate` automatically

Security/payment hardening is intentionally minimal for demo speed.

## Run

1. Copy `.env.example` to `.env` and set:
   - `OPENAI_API_KEY`
   - `NODE_PRIVATE_KEY`
   - `THASSA_RPC_URL`
   - `DEFAULT_THASSA_HUB`
   - optional `OPENAI_MAX_CONTEXT_CHARS` (request context guard)
2. Start server:

```bash
go run ./cmd/server
```

Server endpoints:
- `GET /healthz`
- `POST /v1/update`

`POST /v1/update` is the user-facing route that returns shaped output + signed update data.
You can use the exported hub ABI to submit `submitAutoUpdate(...)` directly from node code when desired.

## Auto Fulfill Cron

On startup, the node runs a background worker (enabled by `AUTO_FULFILL_BIDS=true`) that:
1. polls new blocks every `BID_SCAN_INTERVAL_SECONDS` (default `2`)
2. scans `BidPlaced` logs from `DEFAULT_THASSA_HUB`
3. loads oracle `query`, `expectedShape`, `model`, `clientVersion`
4. generates structured output + ABI callback data
5. retries automatically until `_fulfilled=true` or the LLM timeout budget is exhausted, then sends `submitAutoUpdate(bidId, update, proof)` onchain
6. auto-approves payment token allowance to hub when lockup allowance is too low
7. logs diffs against the previous shaped output for visibility, but still submits repeated values when `_fulfilled=true`

Env knobs:
- `THASSA_RPC_URL`
- `OPENAI_MAX_CONTEXT_CHARS`
- `AUTO_FULFILL_BIDS`
- `BID_SCAN_INTERVAL_SECONDS`
- `AUTO_FULFILL_LLM_TIMEOUT_SECONDS`
- `AUTO_FULFILL_INPUT_DATA_JSON`
- `ABI_DIR`

`AUTO_FULFILL_INPUT_DATA_JSON` is optional extra context only.
Auto-fulfill no longer depends on env-supplied data shape/input and always reads
`query`, `expectedShape`, `model`, and `clientVersion` directly from the oracle contract.

Practical debugging note:
- if `_fulfilled=false` keeps recurring, it is usually not a context-size issue in the demo weather flow. The node logs request context sizing and whether the backend rejected `web_search_options` and forced a retry without web search.

Current limitation:
- auto-fulfill shape parser currently supports flat primitive tuple shapes only,
  e.g. `tuple(nav:uint256,asOf:uint64)` (no nested tuples/arrays yet).

## ABI Export

Hub and Oracle ABIs are exported to:
- `node/abi/ThassaHub.abi.json`
- `node/abi/ThassaOracle.abi.json`

Regenerate after contract changes:

```bash
./scripts/export_abis.sh
```

## Request Shape

`POST /v1/update` body:

```json
{
  "client": "0x1234567890abcdef1234567890abcdef12345678",
  "thassaHub": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "chainId": 31337,
  "bidId": 0,
  "autoFlow": false,
  "clientVersion": 1,
  "ttlSeconds": 3600,
  "nonce": 1,
  "model": "openai:gpt-5.4",
  "openAIModel": "gpt-5.4",
  "query": "Give me details about the most recent presidential election.",
  "expectedShape": "tuple(winner_name:string,election_date_timestamp_utc:uint32,electoral_vote_count_for_winner:uint16,electoral_vote_count_total:uint16)",
  "inputData": {},
  "shape": [
    {"name":"winner_name","solidityType":"string","description":"Winner full name"},
    {"name":"election_date_timestamp_utc","solidityType":"uint32"},
    {"name":"electoral_vote_count_for_winner","solidityType":"uint16"},
    {"name":"electoral_vote_count_total","solidityType":"uint16"}
  ]
}
```

Notes:
- `model` is the exact onchain model commitment string (`oracle.model()`).
- `openAIModel` is optional runtime model id for API calls. If omitted, server derives it from `model` by stripping `openai:`.
- `expectedShape` should match `oracle.expectedShape()` exactly for hub validation.
- `shape` (or `outputShape`) is the field/type list used by this server for structured output + ABI encoding.
- `_fulfilled` is a reserved control field. Do not include it in `shape` or `expectedShape`; the node adds it automatically to the LLM schema and encodes it into `proofEnvelope.publicValues`.

Optional hash overrides:
- `queryHash`
- `shapeHash`
- `modelHash`

If omitted, hashes default to:
- `queryHash = keccak256(query)`
- `shapeHash = keccak256(expectedShape)`
- `modelHash = keccak256(model)`

## Response

Returns:
- `structuredOutput`: LLM JSON object
- `callbackData`: ABI-encoded bytes (hex)
- `digest`: hub digest before EIP-191 prefixing
- `updateEnvelope`: current hub update payload
- `proofEnvelope`: demo proof payload for `ThassaSignatureVerifier`
- `oracleSpec`: full query/shape/model strings used for commitments

## Formatting Extension Point

`internal/format/abi_formatter.go` is the only place that translates shaped JSON into `callbackData`.

To change callback data format later:
1. implement `format.CallbackFormatter`
2. swap formatter construction in `cmd/server/main.go`
