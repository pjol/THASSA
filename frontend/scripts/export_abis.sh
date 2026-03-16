#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTRACTS_DIR="$(cd "${FRONTEND_DIR}/../contracts" && pwd)"
OUT_DIR="${FRONTEND_DIR}/abi"

mkdir -p "${OUT_DIR}"

pushd "${CONTRACTS_DIR}" >/dev/null
forge build >/dev/null

jq '.abi' out/ThassaSanFranciscoWeatherOracle.sol/ThassaSanFranciscoWeatherOracle.json > "${OUT_DIR}/ThassaSanFranciscoWeatherOracle.abi.json"
jq '.abi' out/ThassaHub.sol/ThassaHub.json > "${OUT_DIR}/ThassaHub.abi.json"
jq '.abi' out/MockCoin.sol/MockCoin.json > "${OUT_DIR}/MockCoin.abi.json"
popd >/dev/null

echo "Exported ABIs to ${OUT_DIR}"
