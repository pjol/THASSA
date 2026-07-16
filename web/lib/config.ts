// Environment-driven configuration (spec §3: all chain params via env).

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  API_URL.replace(/^http/, "ws") + "/v1/ws";

export const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL || "http://localhost:3001/docs";

export const PRIVY_APP_ID =
  process.env.NEXT_PUBLIC_PRIVY_APP_ID || "clthassa000000000000000000";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);

export const MARKETS_CONTRACT_ADDRESS = (process.env
  .NEXT_PUBLIC_MARKETS_CONTRACT_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export const PAYMENT_TOKEN_ADDRESS = (process.env
  .NEXT_PUBLIC_PAYMENT_TOKEN_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

// EIP-712 domain of the payment token, used for EIP-3009 authorizations.
export const PAYMENT_TOKEN_NAME =
  process.env.NEXT_PUBLIC_PAYMENT_TOKEN_NAME || "MockUSD";
export const PAYMENT_TOKEN_VERSION =
  process.env.NEXT_PUBLIC_PAYMENT_TOKEN_VERSION || "1";

// Assumed 6 (Tempo stablecoins / MockUSD); the wallet endpoint reports the
// authoritative value which callers should prefer when available.
export const PAYMENT_TOKEN_DECIMALS = Number(
  process.env.NEXT_PUBLIC_PAYMENT_TOKEN_DECIMALS || 6,
);
