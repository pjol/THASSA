#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTRACTS_DIR="$(cd "${NODE_DIR}/../contracts" && pwd)"
OUT_DIR="${NODE_DIR}/abi"

mkdir -p "${OUT_DIR}"

pushd "${CONTRACTS_DIR}" >/dev/null
forge build >/dev/null

jq '.abi' out/ThassaHub.sol/ThassaHub.json > "${OUT_DIR}/ThassaHub.abi.json"
jq '.abi' out/ThassaOracle.sol/ThassaOracle.json > "${OUT_DIR}/ThassaOracle.abi.json"
popd >/dev/null

echo "Exported ABIs to ${OUT_DIR}"
