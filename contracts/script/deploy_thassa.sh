#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${CONTRACTS_DIR}"

if [[ ! -f ".env" ]]; then
  echo "Missing contracts/.env file."
  echo "Copy contracts/.env.example to contracts/.env and fill required values."
  exit 1
fi

set -a
source .env
set +a

: "${DEPLOY_RPC_URL:?DEPLOY_RPC_URL is required in contracts/.env}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required in contracts/.env}"
: "${NODE_SIGNER_PUBLIC_KEY:?NODE_SIGNER_PUBLIC_KEY is required in contracts/.env}"
: "${USER_ACCOUNT_PUBLIC_KEY:?USER_ACCOUNT_PUBLIC_KEY is required in contracts/.env}"

forge script script/DeployThassa.s.sol:DeployThassaScript \
  --rpc-url "${DEPLOY_RPC_URL}" \
  --broadcast \
  "$@"
