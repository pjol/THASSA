// EIP-712 orders + EIP-3009 funding authorizations (spec §9).
// All components code against the pinned ThassaMarkets interface:
//   Order(uint256 marketId,uint8 side,uint8 price,uint80 shares,uint256 maxCost,
//         uint256 affiliatePostId,uint64 expiry,uint256 nonce,address maker)
// domain {name:"ThassaMarkets", version:"1", chainId, verifyingContract}.
//
// SIGNATURE CARRIAGE (spec §9 final): a SignedOrder carries NO separate
// signature. For order placement (placeOrdersBatch / createMarket initial
// orders) the EIP-3009 ReceiveWithAuthorization `nonce` MUST be the order's
// EIP-712 typed-data digest — so the user signs exactly ONE thing (the 3009
// auth), and the contract recovers/authenticates the order through it.
// Settlement-fee auths keep a random 32-byte nonce.

import { hashTypedData } from "viem";
import type { Address, Hex, TypedDataDomain } from "viem";
import {
  CHAIN_ID,
  MARKETS_CONTRACT_ADDRESS,
  PAYMENT_TOKEN_ADDRESS,
  PAYMENT_TOKEN_DECIMALS,
  PAYMENT_TOKEN_NAME,
  PAYMENT_TOKEN_VERSION,
} from "@/lib/config";

export const SIDE_YES = 0 as const;
export const SIDE_NO = 1 as const;
export type SideNum = 0 | 1;

export const ORDER_TYPES = {
  Order: [
    { name: "marketId", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "price", type: "uint8" },
    { name: "shares", type: "uint80" },
    { name: "maxCost", type: "uint256" },
    { name: "affiliatePostId", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "maker", type: "address" },
  ],
} as const;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function marketsDomain(): TypedDataDomain {
  return {
    name: "ThassaMarkets",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: MARKETS_CONTRACT_ADDRESS,
  };
}

export function paymentTokenDomain(): TypedDataDomain {
  return {
    name: PAYMENT_TOKEN_NAME,
    version: PAYMENT_TOKEN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: PAYMENT_TOKEN_ADDRESS,
  };
}

// ------------------------------------------------------------------ fee math

const UNIT = 10n ** BigInt(PAYMENT_TOKEN_DECIMALS); // $1 in token units

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

// Taker fee, mirroring the contract (fees round UP, spec §8):
//   fee = ceil(700 × shares × p × (100−p) / 10^8) dollars → token units.
export function takerFeeUnits(shares: bigint, priceCents: number): bigint {
  const p = BigInt(priceCents);
  return ceilDiv(700n * shares * p * (100n - p) * UNIT, 10n ** 8n);
}

// Escrow the maker deposits: p cents per share, in token units.
export function escrowUnits(shares: bigint, priceCents: number): bigint {
  return (shares * BigInt(priceCents) * UNIT) / 100n;
}

// maxCost the signer authorizes: escrow + taker-fee headroom (in case the
// order crosses immediately and takes).
export function maxCostUnits(shares: bigint, priceCents: number): bigint {
  return escrowUnits(shares, priceCents) + takerFeeUnits(shares, priceCents);
}

export function dollarsToUnits(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100)) * (UNIT / 100n);
}

export function unitsToDollars(units: bigint | string): number {
  const u = typeof units === "string" ? BigInt(units || "0") : units;
  return Number(u) / Number(UNIT);
}

// Shares purchasable with `dollars` at `priceCents` (floor).
export function sharesForSpend(dollars: number, priceCents: number): bigint {
  if (priceCents <= 0) return 0n;
  return BigInt(Math.floor((dollars * 100) / priceCents));
}

// ------------------------------------------------------------- typed payloads

export interface OrderFields {
  marketId: bigint; // chain market id; 0n when creating a new market
  side: SideNum;
  price: number; // cents 1..99
  shares: bigint;
  maxCost: bigint;
  affiliatePostId: bigint; // 0n = none
  expiry: bigint; // unix seconds
  nonce: bigint;
  maker: Address;
}

export function buildOrderTypedData(order: OrderFields) {
  return {
    domain: marketsDomain(),
    types: ORDER_TYPES,
    primaryType: "Order" as const,
    message: order,
  };
}

// The order's EIP-712 typed-data digest. Used verbatim as the EIP-3009 auth
// nonce (signature carriage, spec §9) — must match the contract's digest, so
// it is computed with viem's hashTypedData over the exact pinned domain/type.
export function orderDigest(order: OrderFields): Hex {
  return hashTypedData({
    domain: marketsDomain(),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });
}

export function randomAuthNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

export interface Auth3009Fields {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

// receiveWithAuthorization — used to fund orders (to = markets contract).
export function buildReceiveAuthTypedData(auth: Auth3009Fields) {
  return {
    domain: paymentTokenDomain(),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: auth,
  };
}

// transferWithAuthorization — used for wallet sends (to = recipient).
export function buildTransferAuthTypedData(auth: Auth3009Fields) {
  return {
    domain: paymentTokenDomain(),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: auth,
  };
}

// Wire format helpers: bigints → decimal strings for JSON. Orders carry no
// signature of their own — authentication rides on the paired 3009 auth
// whose nonce is the order digest.
export function serializeOrder(order: OrderFields) {
  return {
    market_id: order.marketId.toString(),
    side: order.side,
    price: order.price,
    shares: order.shares.toString(),
    max_cost: order.maxCost.toString(),
    affiliate_post_id: order.affiliatePostId.toString(),
    expiry: Number(order.expiry),
    nonce: order.nonce.toString(),
    maker: order.maker,
    digest: orderDigest(order), // convenience echo; server recomputes
  };
}

export function serializeAuth(auth: Auth3009Fields, signature: Hex) {
  return {
    from: auth.from,
    to: auth.to,
    value: auth.value.toString(),
    valid_after: Number(auth.validAfter),
    valid_before: Number(auth.validBefore),
    auth_nonce: auth.nonce,
    signature,
  };
}
