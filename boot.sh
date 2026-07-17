#!/usr/bin/env bash
#
# Boots the whole Thassa stack for local development (spec §11.1):
#   - infra:     Postgres + MinIO (Docker)
#   - chain:     anvil, optionally forking Tempo (TEMPO_FORK_RPC_URL)
#   - funding:   pranks gas + payment tokens onto every configured address
#   - contracts: hub + ThassaPoAVerifier (node signer registered) + ThassaMarkets
#   - env:       injects deployed addresses + dev defaults into each service's
#                process env (only for keys its env file leaves unset; the live
#                .env / .env.local files are never written or modified)
#   - backend:   Go API on :8080        - node: PoA oracle fulfiller
#   - web:       Next.js on :3000       - mobile: Expo (interactive, foreground last)
#
# Usage:
#   ./boot.sh                # boot everything (Expo in foreground)
#   ./boot.sh --no-mobile    # skip Expo (tails backend/node/web logs instead)
#   ./boot.sh --no-web       # skip the web app
#   ./boot.sh --no-node      # skip the oracle node
#   ./boot.sh --no-backend   # skip the backend API
#
# Only PRIVY_APP_ID and OPENAI_API_KEY need to be set by hand (.env.boot);
# everything else is auto-filled with working dev defaults.
#
# Ctrl-C stops everything (docker infra stays up; `docker compose down` stops it).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

RUN_BACKEND=1 RUN_NODE=1 RUN_WEB=1 RUN_MOBILE=1
for arg in "$@"; do
  case "$arg" in
    --no-mobile)  RUN_MOBILE=0 ;;
    --no-web)     RUN_WEB=0 ;;
    --no-node)    RUN_NODE=0 ;;
    --no-backend) RUN_BACKEND=0 ;;
    -h|--help)    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg (try --help)"; exit 1 ;;
  esac
done

c_blue()  { printf "\033[1;34m%s\033[0m\n" "$1"; }
c_green() { printf "\033[1;32m%s\033[0m\n" "$1"; }
c_yellow(){ printf "\033[1;33m%s\033[0m\n" "$1"; }
c_red()   { printf "\033[1;31m%s\033[0m\n" "$1"; }

PIDS=()
CLEANED=0

# kill_tree <SIG> <pid> — signal a process and all of its descendants,
# leaves first. This is what actually reaches the compiled binary that
# `go run` and `next dev` spawn as grandchildren (a plain kill of the tracked
# pid leaves those orphaned and still holding the port).
kill_tree() {
  local sig="$1" pid="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$sig" "$child"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  [[ "$CLEANED" -eq 1 ]] && return   # idempotent
  CLEANED=1
  trap - INT TERM EXIT               # disarm so we never re-enter
  echo
  c_yellow "Shutting down…"
  # Polite TERM to every tracked subtree.
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill_tree TERM "$pid"
  done
  # Give services up to ~3s to exit gracefully (backend does httpServer.Shutdown).
  for _ in 1 2 3; do
    local alive=0 pid
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ "$alive" -eq 0 ]] && break
    sleep 1
  done
  # Force-KILL anything still up, then free the known ports as a backstop —
  # never a blocking `wait`.
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill_tree KILL "$pid"
  done
  local p pids
  for p in "${ANVIL_PORT:-8545}" "${BACKEND_PORT:-8080}" 8090 "${WEB_PORT:-3000}"; do
    pids=$(lsof -ti tcp:"$p" 2>/dev/null || true)
    [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  done
  c_green "Done. (docker infra left running — 'docker compose down' to stop it)"
  exit 0
}
trap cleanup INT TERM EXIT

wait_for() { # wait_for <url> <name> <tries> [pid] — up = accepting connections.
  # When <pid> is given, stop early (return 2) the moment that process exits,
  # instead of polling a dead process for the full timeout.
  local url="$1" name="$2" tries="${3:-40}" pid="${4:-}"
  for ((i = 0; i < tries; i++)); do
    if curl -s -o /dev/null "$url" 2>/dev/null; then
      c_green "  $name is up ($url)"
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      c_red "  $name exited before becoming ready"
      return 2
    fi
    sleep 1
  done
  c_red "  $name did not become ready at $url"
  return 1
}

free_port() { # free_port <port> <name> — force-free a port, then WAIT until it is
              # actually released before returning (so the new bind can't race a
              # dying process). Kills orphaned go-run/next-dev binaries left by a
              # previous run.
  local port="$1" name="$2" pids i announced=0
  for i in $(seq 1 20); do
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    [[ -z "$pids" ]] && return 0
    if [[ "$announced" -eq 0 ]]; then
      c_yellow "  port $port in use — stopping existing $name"
      announced=1
    fi
    kill -9 $pids 2>/dev/null || true
    sleep 0.25
  done
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  [[ -n "$pids" ]] && c_red "  could not free port $port (still held by: $pids)"
  return 0
}

# Silence the Foundry nightly-build banner that otherwise spams every
# forge/cast/anvil invocation.
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

for tool in cast forge anvil go npm docker curl; do
  command -v "$tool" >/dev/null || { c_red "missing required tool: $tool"; exit 1; }
done

# ----------------------------------------------------------------------------
# 0. Boot config (.env.boot — auto-created; only Privy/OpenAI are hand-set)
# ----------------------------------------------------------------------------
if [[ ! -f .env.boot ]]; then
  cp .env.boot.example .env.boot
  c_yellow "created .env.boot from .env.boot.example (dev defaults auto-filled)"
fi
set -a; source .env.boot; set +a

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
FUND_ETH_AMOUNT="${FUND_ETH_AMOUNT:-100}"
FUND_TOKEN_AMOUNT="${FUND_TOKEN_AMOUNT:-10000}"
PAYMENT_TOKEN_DECIMALS="${PAYMENT_TOKEN_DECIMALS:-6}"

# Fallbacks: when a secret isn't set in .env.boot, adopt a value the user
# already put in a component env file (last non-empty occurrence, so values
# inside a stale generated block are found too). Adopted values propagate to
# every component during env wiring.
read_env_value() { # read_env_value <file> <key> → prints last non-empty value
  [[ -f "$1" ]] || return 1
  local line val
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null | tail -1)"
  [[ -n "$line" ]] || return 1
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  [[ -n "$val" ]] || return 1
  printf '%s' "$val"
}

fallback() { # fallback <VAR> <file:key>... — fills $VAR from the first match
  local var="$1" cur; shift
  eval "cur=\"\${$var:-}\""
  [[ -n "$cur" ]] && return 0
  local spec file key val
  for spec in "$@"; do
    file="${spec%%:*}"; key="${spec#*:}"
    if val="$(read_env_value "$ROOT/$file" "$key")"; then
      eval "$var=\"\$val\""
      c_yellow "  $var: not in .env.boot — using value found in $file"
      return 0
    fi
  done
  return 0
}

fallback PRIVY_APP_ID \
  backend/.env:PRIVY_APP_ID \
  web/.env.local:NEXT_PUBLIC_PRIVY_APP_ID \
  web/.env:NEXT_PUBLIC_PRIVY_APP_ID \
  mobile/.env:EXPO_PUBLIC_PRIVY_APP_ID
fallback PRIVY_CLIENT_ID \
  mobile/.env:EXPO_PUBLIC_PRIVY_CLIENT_ID
fallback PRIVY_VERIFICATION_KEY \
  backend/.env:PRIVY_VERIFICATION_KEY
fallback OPENAI_API_KEY \
  backend/.env:OPENAI_API_KEY \
  node/.env:OPENAI_API_KEY
fallback STRIPE_SECRET_KEY backend/.env:STRIPE_SECRET_KEY
fallback STRIPE_WEBHOOK_SECRET backend/.env:STRIPE_WEBHOOK_SECRET

[[ -z "${PRIVY_APP_ID:-}" ]] && c_yellow "WARNING: PRIVY_APP_ID not set (checked .env.boot, backend/.env, web/.env(.local), mobile/.env) — backend requires it; app login needs it"
[[ -z "${OPENAI_API_KEY:-}" ]] && c_yellow "WARNING: OPENAI_API_KEY not set (checked .env.boot, backend/.env, node/.env) — oracle node requires it; market generation uses it"

addr_of() { cast wallet address --private-key "$1"; }
DEPLOYER_ADDRESS="$(addr_of "$DEPLOYER_PRIVATE_KEY")"
NODE_ADDRESS="$(addr_of "$NODE_PRIVATE_KEY")"
RELAYER_ADDRESS="$(addr_of "$RELAYER_PRIVATE_KEY")"
DEV_USER_ADDRESS="$(addr_of "$DEV_USER_PRIVATE_KEY")"

# ----------------------------------------------------------------------------
# 1. Infra
# ----------------------------------------------------------------------------
c_blue "[1/7] Infra (Postgres + MinIO)"
if docker info >/dev/null 2>&1; then
  (cd "$ROOT" && docker compose up -d db minio createbucket >/dev/null 2>&1) \
    || (cd "$ROOT" && docker compose up -d >/dev/null)
  c_green "  docker compose started (db, minio)"
  for ((i = 0; i < 40; i++)); do
    if docker compose -f "$ROOT/docker-compose.yml" exec -T db pg_isready -U thassa >/dev/null 2>&1; then
      c_green "  postgres is ready"
      break
    fi
    sleep 1
  done
else
  c_red "  Docker is not running — start Docker and re-run (postgres + minio are required)."
  exit 1
fi

# ----------------------------------------------------------------------------
# 2. Chain (anvil — Tempo fork when TEMPO_FORK_RPC_URL is set)
# ----------------------------------------------------------------------------
if [[ -n "${TEMPO_FORK_RPC_URL:-}" ]]; then
  c_blue "[2/7] Chain (anvil fork of Tempo, :${ANVIL_PORT})"
  ANVIL_ARGS=(--fork-url "$TEMPO_FORK_RPC_URL")
else
  c_blue "[2/7] Chain (plain local anvil, :${ANVIL_PORT})"
  ANVIL_ARGS=()
fi
[[ -n "${CHAIN_ID:-}" ]] && ANVIL_ARGS+=(--chain-id "$CHAIN_ID")
free_port "$ANVIL_PORT" anvil
anvil --host 0.0.0.0 --port "$ANVIL_PORT" ${ANVIL_ARGS[@]+"${ANVIL_ARGS[@]}"} >"$LOG_DIR/anvil.log" 2>&1 &
PIDS+=($!)
c_yellow "  logs: logs/anvil.log"
for ((i = 0; i < 60; i++)); do
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  [[ $i -eq 59 ]] && { c_red "  anvil did not come up"; tail -n 20 "$LOG_DIR/anvil.log"; exit 1; }
  sleep 0.5
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
c_green "  chain is up (chain id ${CHAIN_ID}${TEMPO_FORK_RPC_URL:+, forked from Tempo})"

# ----------------------------------------------------------------------------
# 3. Funding pranks (gas for everyone; tokens after deploy)
# ----------------------------------------------------------------------------
c_blue "[3/7] Funding (gas pranks via anvil_setBalance)"
IFS=',' read -r -a EXTRA_ADDRS <<< "${FUND_ADDRESSES:-}"
ALL_ADDRS=("$DEPLOYER_ADDRESS" "$NODE_ADDRESS" "$RELAYER_ADDRESS" "$DEV_USER_ADDRESS")
for a in ${EXTRA_ADDRS[@]+"${EXTRA_ADDRS[@]}"}; do
  a="$(echo "$a" | xargs)"
  [[ -n "$a" ]] && ALL_ADDRS+=("$a")
done
WEI_AMOUNT="$(cast to-wei "$FUND_ETH_AMOUNT" ether)"
for addr in "${ALL_ADDRS[@]}"; do
  cast rpc anvil_setBalance "$addr" "$(cast to-hex "$WEI_AMOUNT")" --rpc-url "$RPC_URL" >/dev/null
done
c_green "  ${FUND_ETH_AMOUNT} ETH → ${#ALL_ADDRS[@]} addresses"

# ----------------------------------------------------------------------------
# 4. Contracts
# ----------------------------------------------------------------------------
c_blue "[4/7] Contracts (hub + PoA verifier + markets)"
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
) >"$LOG_DIR/deploy.log" 2>&1
if [[ ! -f contracts/out/deployment.env ]]; then
  c_red "  deploy failed — deployment manifest missing"
  tail -n 20 "$LOG_DIR/deploy.log"
  exit 1
fi
# shellcheck disable=SC1091
source contracts/out/deployment.env
c_green "  hub      ${HUB_ADDRESS}"
c_green "  markets  ${MARKETS_CONTRACT_ADDRESS}"
c_green "  token    ${PAYMENT_TOKEN_ADDRESS}"

# Payment tokens: impersonate a whale on forks, mint MockUSD locally.
TOKEN_UNITS=$(( FUND_TOKEN_AMOUNT * 10**PAYMENT_TOKEN_DECIMALS ))
if [[ -n "${PAYMENT_TOKEN_WHALE:-}" ]]; then
  cast rpc anvil_impersonateAccount "$PAYMENT_TOKEN_WHALE" --rpc-url "$RPC_URL" >/dev/null
  cast rpc anvil_setBalance "$PAYMENT_TOKEN_WHALE" "$(cast to-hex "$WEI_AMOUNT")" --rpc-url "$RPC_URL" >/dev/null
  for addr in "${ALL_ADDRS[@]}"; do
    cast send "$PAYMENT_TOKEN_ADDRESS" "transfer(address,uint256)" "$addr" "$TOKEN_UNITS" \
      --from "$PAYMENT_TOKEN_WHALE" --unlocked --rpc-url "$RPC_URL" >/dev/null
  done
  cast rpc anvil_stopImpersonatingAccount "$PAYMENT_TOKEN_WHALE" --rpc-url "$RPC_URL" >/dev/null
  c_green "  \$${FUND_TOKEN_AMOUNT} → ${#ALL_ADDRS[@]} addresses (whale impersonation)"
else
  for addr in "${ALL_ADDRS[@]}"; do
    cast send "$PAYMENT_TOKEN_ADDRESS" "mint(address,uint256)" "$addr" "$TOKEN_UNITS" \
      --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null
  done
  c_green "  \$${FUND_TOKEN_AMOUNT} → ${#ALL_ADDRS[@]} addresses (MockUSD mint)"
fi

# ----------------------------------------------------------------------------
# 5. Runtime env (defaults injected into service PROCESS env only for keys the
#    service's own env file doesn't already define — live env files are NEVER
#    written or modified; the file always wins over an injected default).
# ----------------------------------------------------------------------------
c_blue "[5/7] Runtime environment (injecting defaults for unset keys only)"

# key_in_file: true if <file> defines <KEY> in a user-authored line. Lines
# inside a legacy "# >>> thassa-boot >>>" block (written by older boot.sh
# versions) are ignored, so stale generated addresses don't shadow fresh ones.
key_in_file() {
  [[ -f "$1" ]] || return 1
  awk '/# >>> thassa-boot >>>/{skip=1} /# <<< thassa-boot <<</{skip=0; next} !skip' "$1" \
    | grep -qE "^[[:space:]]*(export[[:space:]]+)?$2="
}

# add <arrayName> <file> <KEY> <VALUE> — append KEY=VALUE to the named array
# unless the file already defines KEY.
add() {
  local arr="$1" file="$2" key="$3" val="$4"
  key_in_file "$file" "$key" && return 0
  eval "$arr+=(\"\$key=\$val\")"
}
# add_opt — like add, but skip entirely when VALUE is empty (optional secrets).
add_opt() { [[ -n "$4" ]] && add "$1" "$2" "$3" "$4" || true; }

DB_URL_DEFAULT="postgres://thassa:thassa@localhost:5432/thassa?sslmode=disable"

BACKEND_ENV=()
add     BACKEND_ENV backend/.env PORT "$BACKEND_PORT"
add     BACKEND_ENV backend/.env DATABASE_URL "$DB_URL_DEFAULT"
add     BACKEND_ENV backend/.env IN_PRODUCTION false
add     BACKEND_ENV backend/.env REGION local
add     BACKEND_ENV backend/.env CHAIN_RPC_URL "$RPC_URL"
add     BACKEND_ENV backend/.env CHAIN_ID "$CHAIN_ID"
add     BACKEND_ENV backend/.env PAYMENT_TOKEN_ADDRESS "$PAYMENT_TOKEN_ADDRESS"
add     BACKEND_ENV backend/.env PAYMENT_TOKEN_NAME "${PAYMENT_TOKEN_NAME:-MockUSD}"
add     BACKEND_ENV backend/.env PAYMENT_TOKEN_VERSION "${PAYMENT_TOKEN_VERSION:-1}"
add     BACKEND_ENV backend/.env PAYMENT_TOKEN_DECIMALS "$PAYMENT_TOKEN_DECIMALS"
add     BACKEND_ENV backend/.env HUB_ADDRESS "$HUB_ADDRESS"
add     BACKEND_ENV backend/.env MARKETS_CONTRACT_ADDRESS "$MARKETS_CONTRACT_ADDRESS"
add     BACKEND_ENV backend/.env RELAYER_PRIVATE_KEY "$RELAYER_PRIVATE_KEY"
add     BACKEND_ENV backend/.env S3_ENDPOINT http://localhost:9000
add     BACKEND_ENV backend/.env S3_REGION us-east-1
add     BACKEND_ENV backend/.env S3_BUCKET thassa-assets
add     BACKEND_ENV backend/.env S3_ACCESS_KEY thassa
add     BACKEND_ENV backend/.env S3_SECRET_KEY thassa-secret
add     BACKEND_ENV backend/.env S3_FORCE_PATH_STYLE true
add_opt BACKEND_ENV backend/.env OPENAI_API_KEY "${OPENAI_API_KEY:-}"
add_opt BACKEND_ENV backend/.env PRIVY_APP_ID "${PRIVY_APP_ID:-}"
add_opt BACKEND_ENV backend/.env PRIVY_VERIFICATION_KEY "${PRIVY_VERIFICATION_KEY:-}"
add_opt BACKEND_ENV backend/.env STRIPE_SECRET_KEY "${STRIPE_SECRET_KEY:-}"
add_opt BACKEND_ENV backend/.env STRIPE_WEBHOOK_SECRET "${STRIPE_WEBHOOK_SECRET:-}"

NODE_ENV_VARS=()
add     NODE_ENV_VARS node/.env PORT 8090
add     NODE_ENV_VARS node/.env THASSA_RPC_URL "$RPC_URL"
add     NODE_ENV_VARS node/.env DEFAULT_CHAIN_ID "$CHAIN_ID"
add     NODE_ENV_VARS node/.env DEFAULT_THASSA_HUB "$HUB_ADDRESS"
add     NODE_ENV_VARS node/.env NODE_PRIVATE_KEY "$NODE_PRIVATE_KEY"
add     NODE_ENV_VARS node/.env AUTO_FULFILL_BIDS true
add     NODE_ENV_VARS node/.env NODE_MCP_URL "http://localhost:${BACKEND_PORT}/v1/mcp"
add_opt NODE_ENV_VARS node/.env OPENAI_API_KEY "${OPENAI_API_KEY:-}"

WEB_ENV=()
add     WEB_ENV web/.env.local NEXT_PUBLIC_API_URL "http://localhost:${BACKEND_PORT}"
add     WEB_ENV web/.env.local NEXT_PUBLIC_WS_URL "ws://localhost:${BACKEND_PORT}/v1/ws"
add     WEB_ENV web/.env.local NEXT_PUBLIC_CHAIN_ID "$CHAIN_ID"
add     WEB_ENV web/.env.local NEXT_PUBLIC_MARKETS_CONTRACT_ADDRESS "$MARKETS_CONTRACT_ADDRESS"
add     WEB_ENV web/.env.local NEXT_PUBLIC_PAYMENT_TOKEN_ADDRESS "$PAYMENT_TOKEN_ADDRESS"
add     WEB_ENV web/.env.local NEXT_PUBLIC_PAYMENT_TOKEN_NAME "${PAYMENT_TOKEN_NAME:-MockUSD}"
add     WEB_ENV web/.env.local NEXT_PUBLIC_PAYMENT_TOKEN_VERSION "${PAYMENT_TOKEN_VERSION:-1}"
add     WEB_ENV web/.env.local NEXT_PUBLIC_PAYMENT_TOKEN_DECIMALS "$PAYMENT_TOKEN_DECIMALS"
add_opt WEB_ENV web/.env.local NEXT_PUBLIC_PRIVY_APP_ID "${PRIVY_APP_ID:-}"

MOBILE_ENV=()
add     MOBILE_ENV mobile/.env EXPO_PUBLIC_API_URL "http://localhost:${BACKEND_PORT}"
add     MOBILE_ENV mobile/.env EXPO_PUBLIC_WS_URL "ws://localhost:${BACKEND_PORT}"
add     MOBILE_ENV mobile/.env EXPO_PUBLIC_CHAIN_ID "$CHAIN_ID"
add     MOBILE_ENV mobile/.env EXPO_PUBLIC_MARKETS_CONTRACT_ADDRESS "$MARKETS_CONTRACT_ADDRESS"
add     MOBILE_ENV mobile/.env EXPO_PUBLIC_PAYMENT_TOKEN_ADDRESS "$PAYMENT_TOKEN_ADDRESS"
add     MOBILE_ENV mobile/.env EXPO_PUBLIC_PAYMENT_TOKEN_DECIMALS "$PAYMENT_TOKEN_DECIMALS"
add_opt MOBILE_ENV mobile/.env EXPO_PUBLIC_PRIVY_APP_ID "${PRIVY_APP_ID:-}"
add_opt MOBILE_ENV mobile/.env EXPO_PUBLIC_PRIVY_CLIENT_ID "${PRIVY_CLIENT_ID:-}"

# One-time migration hint: older boot.sh versions wrote a managed block into
# these files; its contents are now ignored (never written), safe to delete.
for f in backend/.env node/.env web/.env.local mobile/.env; do
  if [[ -f "$ROOT/$f" ]] && grep -q "# >>> thassa-boot >>>" "$ROOT/$f"; then
    c_yellow "  note: $f has a legacy boot-generated block — ignored (safe to delete)"
  fi
done
c_green "  defaults ready; injecting only keys each env file leaves unset (files untouched)"

# ----------------------------------------------------------------------------
# 6. Backend + node + web
# ----------------------------------------------------------------------------
c_blue "[6/7] Services"
if [[ "$RUN_BACKEND" -eq 1 ]]; then
  free_port "$BACKEND_PORT" backend
  ( cd "$ROOT/backend" && env ${BACKEND_ENV[@]+"${BACKEND_ENV[@]}"} go run ./cmd/server >"$LOG_DIR/backend.log" 2>&1 ) &
  BACKEND_PID=$!
  PIDS+=($BACKEND_PID)
  c_yellow "  backend logs: logs/backend.log"
  wait_for "http://localhost:${BACKEND_PORT}/health" "backend" 60 "$BACKEND_PID" \
    || { c_red "  backend failed — last log lines:"; tail -n 20 "$LOG_DIR/backend.log"; exit 1; }
fi

if [[ "$RUN_NODE" -eq 1 ]]; then
  free_port 8090 "oracle node"
  ( cd "$ROOT/node" && env ${NODE_ENV_VARS[@]+"${NODE_ENV_VARS[@]}"} go run ./cmd/server >"$LOG_DIR/node.log" 2>&1 ) &
  NODE_PID=$!
  PIDS+=($NODE_PID)
  c_yellow "  node logs: logs/node.log"
  wait_for "http://localhost:8090/healthz" "oracle node" 30 "$NODE_PID" \
    || { c_yellow "  node not ready — last log lines (needs OPENAI_API_KEY):"; tail -n 8 "$LOG_DIR/node.log"; }
fi

if [[ "$RUN_WEB" -eq 1 ]]; then
  free_port "$WEB_PORT" web
  if [[ ! -d "$ROOT/web/node_modules" ]]; then
    c_yellow "  installing web deps…"
    ( cd "$ROOT/web" && npm install --no-audit --no-fund >"$LOG_DIR/web-install.log" 2>&1 )
  fi
  # Start from a clean build cache — stale .next chunks cause phantom errors.
  rm -rf "$ROOT/web/.next" "$ROOT/web/node_modules/.cache"
  ( cd "$ROOT/web" && env ${WEB_ENV[@]+"${WEB_ENV[@]}"} npm run dev -- --port "$WEB_PORT" >"$LOG_DIR/web.log" 2>&1 ) &
  WEB_PID=$!
  PIDS+=($WEB_PID)
  c_yellow "  web logs: logs/web.log"
  wait_for "http://localhost:${WEB_PORT}" "web" 60 "$WEB_PID" || c_yellow "  web still starting — check logs/web.log"
fi

echo
c_green "Stack is up:"
echo "  Chain    ${RPC_URL} (chain id ${CHAIN_ID}${TEMPO_FORK_RPC_URL:+, Tempo fork})"
echo "  Hub      ${HUB_ADDRESS}"
echo "  Markets  ${MARKETS_CONTRACT_ADDRESS}"
echo "  Token    ${PAYMENT_TOKEN_ADDRESS}"
[[ "$RUN_BACKEND" -eq 1 ]] && echo "  API      http://localhost:${BACKEND_PORT}"
[[ "$RUN_NODE" -eq 1 ]]    && echo "  Node     PoA fulfiller ${NODE_ADDRESS}"
[[ "$RUN_WEB" -eq 1 ]]     && echo "  Web      http://localhost:${WEB_PORT}"
echo "  MinIO    http://localhost:9001 (console: thassa / thassa-secret)"
echo "  Funded   ${ALL_ADDRS[*]}"
echo

# ----------------------------------------------------------------------------
# 7. Mobile (interactive) — foreground so Expo's menu/QR shows.
# ----------------------------------------------------------------------------
if [[ "$RUN_MOBILE" -eq 1 ]]; then
  c_blue "[7/7] Mobile (Expo) — press q to quit Expo, then Ctrl-C to stop the rest"
  if [[ ! -d "$ROOT/mobile/node_modules" ]]; then
    c_yellow "  installing mobile deps…"
    ( cd "$ROOT/mobile" && npm install --no-audit --no-fund >"$LOG_DIR/mobile-install.log" 2>&1 )
  fi
  ( cd "$ROOT/mobile" && env ${MOBILE_ENV[@]+"${MOBILE_ENV[@]}"} npx expo start )
else
  c_blue "[7/7] Running (no mobile). Press Ctrl-C to stop."
  TAIL_LOGS=()
  [[ "$RUN_BACKEND" -eq 1 ]] && TAIL_LOGS+=("$LOG_DIR/backend.log")
  [[ "$RUN_NODE" -eq 1 ]]    && TAIL_LOGS+=("$LOG_DIR/node.log")
  [[ "$RUN_WEB" -eq 1 ]]     && TAIL_LOGS+=("$LOG_DIR/web.log")
  tail -f ${TAIL_LOGS[@]+"${TAIL_LOGS[@]}"}
fi
