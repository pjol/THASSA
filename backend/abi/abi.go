// Package abi embeds the hand-written contract ABI JSON pinned to spec §9.
// The contracts are built in parallel against the same interface; any drift
// is a spec violation on either side.
package abi

import _ "embed"

// ThassaMarkets is the platform markets contract ABI (spec §9).
//
//go:embed ThassaMarkets.abi.json
var ThassaMarkets string

// PaymentToken is the ERC-20 + EIP-3009 stablecoin ABI subset the backend
// uses (balanceOf/decimals/transferWithAuthorization/Transfer).
//
//go:embed PaymentToken.abi.json
var PaymentToken string
