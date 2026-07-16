#!/usr/bin/env bash
# Thassa single-command dev environment (spec §11.1).
#
# Brings up the full stack against a local fork of Tempo:
#   infra (postgres+minio) → anvil (fork) → funding pranks → contract deploy
#   → env wiring → backend + oracle node + web + mobile.
#
# Usage: cp .env.boot.example .env.boot && ./boot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p logs

if [[ ! -f .env.boot ]]; then
  echo "Missing .env.boot — copy .env.boot.example to .env.boot first." >&2
  exit 1
fi
set -a; source .env.boot; set +a

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
FUND_ETH_AMOUNT="${FUND_ETH_AMOUNT:-100}"
FUND_TOKEN_AMOUNT="${FUND_TOKEN_AMOUNT:-10000}"
PAYMENT_TOKEN_DECIMALS="${PAYMENT_TOKEN_DECIMALS:-6}"

for tool in cast forge anvil go npm docker jq; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

PIDS=()
cleanup() {
  echo ""
  echo "boot.sh: shutting down..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  echo "boot.sh: done (docker compose infra left running; 'docker compose down' to stop it)."
}
trap cleanup INT TERM EXIT

addr_of() { cast wallet address --private-key "$1"; }
DEPLOYER_ADDRESS="$(addr_of "$DEPLOYER_PRIVATE_KEY")"
NODE_ADDRESS="$(addr_of "$NODE_PRIVATE_KEY")"
RELAYER_ADDRESS="$(addr_of "$RELAYER_PRIVATE_KEY")"
DEV_USER_ADDRESS="$(addr_of "$DEV_USER_PRIVATE_KEY")"

# ── 1. Infra ─────────────────────────────────────────────────────────────────
echo "boot.sh: starting docker infra (postgres + minio)..."
docker compose up -d --wait db minio 2>/dev/null || docker compose up -d

# ── 2. Anvil (Tempo fork or plain local) ─────────────────────────────────────
if [[ -n "${TEMPO_FORK_RPC_URL:-}" ]]; then
  echo "boot.sh: starting anvil fork of ${TEMPO_FORK_RPC_URL} on :${ANVIL_PORT}..."
  ANVIL_ARGS=(--fork-url "$TEMPO_FORK_RPC_URL")
else
  echo "boot.sh: starting plain local anvil on :${ANVIL_PORT}..."
  ANVIL_ARGS=()
fi
[[ -n "${CHAIN_ID:-}" ]] && ANVIL_ARGS+=(--chain-id "$CHAIN_ID")
anvil --host 0.0.0.0 --port "$ANVIL_PORT" "${ANVIL_ARGS[@]}" > logs/anvil.log 2>&1 &
PIDS+=($!)

for i in $(seq 1 60); do
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  [[ $i -eq 60 ]] && { echo "anvil did not come up; see logs/anvil.log" >&2; exit 1; }
  sleep 0.5
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
echo "boot.sh: chain ready (chain id ${CHAIN_ID})."

# ── 3. Gas funding pranks ────────────────────────────────────────────────────
IFS=',' read -r -a EXTRA_ADDRS <<< "${FUND_ADDRESSES:-}"
ALL_ADDRS=("$DEPLOYER_ADDRESS" "$NODE_ADDRESS" "$RELAYER_ADDRESS" "$DEV_USER_ADDRESS")
for a in "${EXTRA_ADDRS[@]:-}"; do [[ -n "$a" ]] && ALL_ADDRS+=("$(echo "$a" | xargs)"); done

WEI_AMOUNT="$(cast to-wei "$FUND_ETH_AMOUNT" ether)"
for addr in "${ALL_ADDRS[@]}"; do
  cast rpc anvil_setBalance "$addr" "$(cast to-hex "$WEI_AMOUNT")" --rpc-url "$RPC_URL" >/dev/null
done
echo "boot.sh: gas funded (${FUND_ETH_AMOUNT} ETH × ${#ALL_ADDRS[@]} addresses)."

# ── 4. Deploy contracts ──────────────────────────────────────────────────────
echo "boot.sh: deploying contracts..."
(
  cd contracts
  DEPLOY_RPC_URL="$RPC_URL" \
  DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  NODE_SIGNER_PUBLIC_KEY="$NODE_ADDRESS" \
  USER_ACCOUNT_PUBLIC_KEY="$DEV_USER_ADDRESS" \
  PLATFORM_ROLE_PUBLIC_KEY="$RELAYER_ADDRESS" \
  PAYMENT_TOKEN_ADDRESS="${PAYMENT_TOKEN_ADDRESS:-}" \
  forge script script/DeployThassa.s.sol:DeployThassaScript \
    --rpc-url "$RPC_URL" --broadcast --skip-simulation -q
) >> logs/deploy.log 2>&1
[[ -f contracts/out/deployment.env ]] || { echo "deployment manifest missing; see logs/deploy.log" >&2; exit 1; }
# shellcheck disable=SC1091
source contracts/out/deployment.env
echo "boot.sh: deployed — hub ${HUB_ADDRESS}, markets ${MARKETS_CONTRACT_ADDRESS}, token ${PAYMENT_TOKEN_ADDRESS}."

# ── 5. Payment-token funding pranks ─────────────────────────────────────────
TOKEN_UNITS=$(( FUND_TOKEN_AMOUNT * 10**PAYMENT_TOKEN_DECIMALS ))
if [[ -n "${PAYMENT_TOKEN_WHALE:-}" ]]; then
  echo "boot.sh: funding payment tokens by impersonating whale ${PAYMENT_TOKEN_WHALE}..."
  cast rpc anvil_impersonateAccount "$PAYMENT_TOKEN_WHALE" --rpc-url "$RPC_URL" >/dev/null
  cast rpc anvil_setBalance "$PAYMENT_TOKEN_WHALE" "$(cast to-hex "$WEI_AMOUNT")" --rpc-url "$RPC_URL" >/dev/null
  for addr in "${ALL_ADDRS[@]}"; do
    cast send "$PAYMENT_TOKEN_ADDRESS" "transfer(address,uint256)" "$addr" "$TOKEN_UNITS" \
      --from "$PAYMENT_TOKEN_WHALE" --unlocked --rpc-url "$RPC_URL" >/dev/null
  done
  cast rpc anvil_stopImpersonatingAccount "$PAYMENT_TOKEN_WHALE" --rpc-url "$RPC_URL" >/dev/null
else
  echo "boot.sh: funding payment tokens via MockUSD mint..."
  for addr in "${ALL_ADDRS[@]}"; do
    cast send "$PAYMENT_TOKEN_ADDRESS" "mint(address,uint256)" "$addr" "$TOKEN_UNITS" \
      --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null
  done
fi
echo "boot.sh: token funded (\$${FUND_TOKEN_AMOUNT} × ${#ALL_ADDRS[@]} addresses)."

# ── 6. Wire env files ────────────────────────────────────────────────────────
# Writes/replaces a managed block between markers, preserving user content.
update_env_block() {
  local file="$1" block="$2"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  local tmp
  tmp="$(mktemp)"
  awk '/# >>> thassa-boot >>>/{skip=1} /# <<< thassa-boot <<</{skip=0; next} !skip' "$file" > "$tmp"
  {
    cat "$tmp"
    echo "# >>> thassa-boot >>>  (generated by boot.sh — do not edit inside this block)"
    echo "$block"
    echo "# <<< thassa-boot <<<"
  } > "$file"
  rm -f "$tmp"
}

update_env_block backend/.env "PORT=${BACKEND_PORT}
DATABASE_URL=postgres://thassa:thassa@localhost:5432/thassa?sslmode=disable
IN_PRODUCTION=false
REGION=local
CHAIN_RPC_URL=${RPC_URL}
CHAIN_ID=${CHAIN_ID}
PAYMENT_TOKEN_ADDRESS=${PAYMENT_TOKEN_ADDRESS}
PAYMENT_TOKEN_NAME=${PAYMENT_TOKEN_NAME:-MockUSD}
PAYMENT_TOKEN_VERSION=${PAYMENT_TOKEN_VERSION:-1}
PAYMENT_TOKEN_DECIMALS=${PAYMENT_TOKEN_DECIMALS}
HUB_ADDRESS=${HUB_ADDRESS}
MARKETS_CONTRACT_ADDRESS=${MARKETS_CONTRACT_ADDRESS}
RELAYER_PRIVATE_KEY=${RELAYER_PRIVATE_KEY}
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=thassa-assets
S3_ACCESS_KEY=thassa
S3_SECRET_KEY=thassa-secret
S3_FORCE_PATH_STYLE=true
OPENAI_API_KEY=${OPENAI_API_KEY:-}
PRIVY_APP_ID=${PRIVY_APP_ID:-}
PRIVY_VERIFICATION_KEY=${PRIVY_VERIFICATION_KEY:-}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-}"

update_env_block node/.env "PORT=8090
THASSA_RPC_URL=${RPC_URL}
DEFAULT_CHAIN_ID=${CHAIN_ID}
DEFAULT_THASSA_HUB=${HUB_ADDRESS}
NODE_PRIVATE_KEY=${NODE_PRIVATE_KEY}
AUTO_FULFILL_BIDS=true
OPENAI_API_KEY=${OPENAI_API_KEY:-}
NODE_MCP_URL=http://localhost:${BACKEND_PORT}/v1/mcp"

update_env_block web/.env.local "NEXT_PUBLIC_API_URL=http://localhost:${BACKEND_PORT}
NEXT_PUBLIC_WS_URL=ws://localhost:${BACKEND_PORT}/v1/ws
NEXT_PUBLIC_PRIVY_APP_ID=${PRIVY_APP_ID:-}
NEXT_PUBLIC_CHAIN_ID=${CHAIN_ID}
NEXT_PUBLIC_MARKETS_CONTRACT_ADDRESS=${MARKETS_CONTRACT_ADDRESS}
NEXT_PUBLIC_PAYMENT_TOKEN_ADDRESS=${PAYMENT_TOKEN_ADDRESS}
NEXT_PUBLIC_PAYMENT_TOKEN_NAME=${PAYMENT_TOKEN_NAME:-MockUSD}
NEXT_PUBLIC_PAYMENT_TOKEN_VERSION=${PAYMENT_TOKEN_VERSION:-1}
NEXT_PUBLIC_PAYMENT_TOKEN_DECIMALS=${PAYMENT_TOKEN_DECIMALS}"

update_env_block mobile/.env "EXPO_PUBLIC_API_URL=http://localhost:${BACKEND_PORT}
EXPO_PUBLIC_WS_URL=ws://localhost:${BACKEND_PORT}
EXPO_PUBLIC_PRIVY_APP_ID=${PRIVY_APP_ID:-}
EXPO_PUBLIC_PRIVY_CLIENT_ID=${PRIVY_CLIENT_ID:-}
EXPO_PUBLIC_CHAIN_ID=${CHAIN_ID}
EXPO_PUBLIC_MARKETS_CONTRACT_ADDRESS=${MARKETS_CONTRACT_ADDRESS}
EXPO_PUBLIC_PAYMENT_TOKEN_ADDRESS=${PAYMENT_TOKEN_ADDRESS}
EXPO_PUBLIC_PAYMENT_TOKEN_DECIMALS=${PAYMENT_TOKEN_DECIMALS}"

echo "boot.sh: env files wired (backend/.env, node/.env, web/.env.local, mobile/.env)."

# ── 7. Start services ────────────────────────────────────────────────────────
if [[ "${START_BACKEND:-1}" == "1" ]]; then
  echo "boot.sh: starting backend on :${BACKEND_PORT}..."
  (cd backend && exec go run ./cmd/server) > logs/backend.log 2>&1 &
  PIDS+=($!)
fi
if [[ "${START_NODE:-1}" == "1" ]]; then
  echo "boot.sh: starting oracle node..."
  (cd node && exec go run ./cmd/server) > logs/node.log 2>&1 &
  PIDS+=($!)
fi
if [[ "${START_WEB:-1}" == "1" ]]; then
  echo "boot.sh: starting web on :${WEB_PORT}..."
  (cd web && exec npm run dev -- --port "$WEB_PORT") > logs/web.log 2>&1 &
  PIDS+=($!)
fi
if [[ "${START_MOBILE:-1}" == "1" ]]; then
  echo "boot.sh: starting expo dev server..."
  (cd mobile && CI=1 exec npx expo start) > logs/mobile.log 2>&1 &
  PIDS+=($!)
fi

echo ""
echo "──────────────────────────────────────────────────────────"
echo " Thassa dev stack is up"
echo "   chain     ${RPC_URL} (chain id ${CHAIN_ID}${TEMPO_FORK_RPC_URL:+, forked from Tempo})"
echo "   hub       ${HUB_ADDRESS}"
echo "   markets   ${MARKETS_CONTRACT_ADDRESS}"
echo "   token     ${PAYMENT_TOKEN_ADDRESS}"
echo "   backend   http://localhost:${BACKEND_PORT}   (logs/backend.log)"
echo "   node      PoA fulfiller ${NODE_ADDRESS}      (logs/node.log)"
echo "   web       http://localhost:${WEB_PORT}       (logs/web.log)"
echo "   mobile    expo dev server                    (logs/mobile.log)"
echo "   funded    ${ALL_ADDRS[*]}"
echo " ctrl-c stops app processes (docker infra stays up)"
echo "──────────────────────────────────────────────────────────"
wait
