import * as Crypto from "expo-crypto";
import { hashTypedData } from "viem";
import type { WalletHandle } from "./auth";
import type { Side } from "./types";

// EIP-712 / EIP-3009 typed-data building + signing (spec §3, §9).
// All onchain amounts are token base units (bigint); everything above this
// module speaks dollars and cents.

export const CHAIN_ID = Number(process.env.EXPO_PUBLIC_CHAIN_ID || 31337);
export const MARKETS_CONTRACT = (process.env.EXPO_PUBLIC_MARKETS_CONTRACT_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const PAYMENT_TOKEN = (process.env.EXPO_PUBLIC_PAYMENT_TOKEN_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const TOKEN_DECIMALS = Number(process.env.EXPO_PUBLIC_PAYMENT_TOKEN_DECIMALS || 6);

const UNIT = (decimals: number) => 10n ** BigInt(decimals);

export function dollarsToUnits(dollars: number, decimals = TOKEN_DECIMALS): bigint {
  // Round to the nearest unit; avoids float dust like 1.0000000000000002.
  return BigInt(Math.round(dollars * Number(UNIT(decimals))));
}
export function unitsToDollars(units: bigint, decimals = TOKEN_DECIMALS): number {
  return Number(units) / Number(UNIT(decimals));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

// Taker fee (spec §4.2/§9): fee = ceil(takerFeeBps × shares × p × (100−p) / 10^8)
// dollars, converted to token units. Makers pay no fee, but maxCost must cover
// the worst case in case the order crosses.
export const TAKER_FEE_BPS = 700n;

export function takerFeeUnits(shares: number, priceCents: number, decimals = TOKEN_DECIMALS): bigint {
  const s = BigInt(shares);
  const p = BigInt(priceCents);
  return ceilDiv(TAKER_FEE_BPS * s * p * (100n - p) * UNIT(decimals), 10n ** 8n);
}
export function takerFeeDollars(shares: number, priceCents: number): number {
  return unitsToDollars(takerFeeUnits(shares, priceCents));
}

// Escrow the buyer posts: p×shares for YES, implicitly (100−p)×shares for NO —
// callers pass the price *they* pay per share, so it's always p×shares here.
export function escrowUnits(shares: number, priceCents: number, decimals = TOKEN_DECIMALS): bigint {
  return (BigInt(shares) * BigInt(priceCents) * UNIT(decimals)) / 100n;
}

// maxCost = escrow at the limit price + worst-case taker fee. Execution happens
// at the maker's (better-or-equal) price; fee p(100−p) peaks at p=50, so the
// worst-case fee price is min(limit, 50) for a buyer improving downward.
export function maxCostUnits(shares: number, priceCents: number, decimals = TOKEN_DECIMALS): bigint {
  const worstFeePrice = Math.min(priceCents, 50);
  return escrowUnits(shares, priceCents, decimals) + takerFeeUnits(shares, worstFeePrice, decimals);
}

// "You pay X to win Y": total payout is $1/share, so a buyer paying p cents per
// share stands to win shares × $1 (their escrow back + counterparty's).
export function payToWin(shares: number, priceCents: number): { pay: number; win: number } {
  return { pay: (shares * priceCents) / 100, win: shares };
}
// Convert a spend amount in dollars at price p to a whole number of shares.
export function sharesForSpend(spendDollars: number, priceCents: number): number {
  if (priceCents <= 0) return 0;
  return Math.floor((spendDollars * 100) / priceCents);
}

// --- EIP-712 Order (spec §9) -------------------------------------------------
// Order(uint256 marketId,uint8 side,uint8 price,uint80 shares,uint256 maxCost,
//       uint256 affiliatePostId,uint64 expiry,uint256 nonce,address maker)
//
// SIGNATURE CARRIAGE (final contracts): SignedOrder carries NO separate
// signature. The order's EIP-712 typed-data digest — computed locally with
// viem's hashTypedData — is used as the EIP-3009 ReceiveWithAuthorization
// nonce, so the user signs exactly ONE thing (the 3009 funding auth) and that
// single signature binds both the payment and the order terms.

export const ORDER_DOMAIN = {
  name: "ThassaMarkets",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: MARKETS_CONTRACT,
} as const;

const ORDER_TYPES = {
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

export interface OrderParams {
  chainMarketId: number | bigint; // 0 for new-market opening orders
  side: Side;
  priceCents: number;
  shares: number;
  maxCost: bigint;
  affiliatePostId?: string | bigint; // chain post id, 0 = none
  expiry?: number; // unix seconds; default now + 10 minutes
  nonce: bigint | number | string;
}

export interface BuiltOrder {
  // Wire form of the order (decimal strings for uint256s) for the API.
  message: {
    marketId: string;
    side: number;
    price: number;
    shares: string;
    maxCost: string;
    affiliatePostId: string;
    expiry: number;
    nonce: string;
    maker: string;
  };
  // EIP-712 typed-data digest — carried as the 3009 auth nonce.
  digest: `0x${string}`;
}

// Build the order and compute its EIP-712 digest locally (no signature prompt
// for the order itself — see SIGNATURE CARRIAGE above).
export function buildOrder(maker: string, o: OrderParams): BuiltOrder {
  const expiry = o.expiry ?? Math.floor(Date.now() / 1000) + 600;
  const digest = hashTypedData({
    domain: ORDER_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      marketId: BigInt(o.chainMarketId),
      side: o.side === "yes" ? 0 : 1,
      price: o.priceCents,
      shares: BigInt(o.shares),
      maxCost: o.maxCost,
      affiliatePostId: BigInt(o.affiliatePostId ?? 0),
      expiry: BigInt(expiry),
      nonce: BigInt(o.nonce),
      maker: maker as `0x${string}`,
    },
  });
  return {
    message: {
      marketId: o.chainMarketId.toString(),
      side: o.side === "yes" ? 0 : 1,
      price: o.priceCents,
      shares: o.shares.toString(),
      maxCost: o.maxCost.toString(),
      affiliatePostId: (o.affiliatePostId ?? 0).toString(),
      expiry,
      nonce: o.nonce.toString(),
      maker,
    },
    digest,
  };
}

async function signTypedData(handle: WalletHandle, typedData: unknown): Promise<`0x${string}`> {
  const sig = await handle.provider.request({
    method: "eth_signTypedData_v4",
    params: [handle.address, JSON.stringify(typedData)],
  });
  return sig as `0x${string}`;
}

// --- EIP-3009 ReceiveWithAuthorization (spec §3, §9) --------------------------
// Funds the relayed order/send: from = maker, to = markets contract (orders) or
// recipient (wallet send, relayed server-side with recipient checks).

const RECEIVE_AUTH_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Wire shape of the backend's authPayload (spec §6.6): numeric token units,
// the bytes32 nonce (the order digest for order placement), and the split
// v/r/s signature. Field names must match exactly — the backend decoder
// rejects unknown fields.
export interface Auth3009Payload {
  from: string;
  to: string;
  value: number; // token units
  valid_after: number;
  valid_before: number;
  nonce: `0x${string}`;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export function randomBytes32(): `0x${string}` {
  const bytes = Crypto.getRandomBytes(32);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as `0x${string}`;
}

export async function signReceiveAuthorization(
  handle: WalletHandle,
  opts: {
    to?: string; // defaults to the markets contract
    value: bigint;
    validSeconds?: number;
    token?: { name?: string; version?: string; address?: string };
    // Order placement: MUST be the order's EIP-712 digest (see SIGNATURE
    // CARRIAGE above). Wallet sends / settle auths omit it → random 32 bytes.
    nonce?: `0x${string}`;
  }
): Promise<Auth3009Payload> {
  const now = Math.floor(Date.now() / 1000);
  const authNonce = opts.nonce ?? randomBytes32();
  const message = {
    from: handle.address,
    to: opts.to ?? MARKETS_CONTRACT,
    value: opts.value.toString(),
    validAfter: 0,
    validBefore: now + (opts.validSeconds ?? 3600),
    nonce: authNonce,
  };
  const typedData = {
    domain: {
      name: opts.token?.name ?? "MockUSD",
      version: opts.token?.version ?? "1",
      chainId: CHAIN_ID,
      verifyingContract: opts.token?.address ?? PAYMENT_TOKEN,
    },
    types: RECEIVE_AUTH_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message,
  };
  const signature = await signTypedData(handle, typedData);
  // Split the 65-byte signature into the backend's v/r/s wire fields.
  const r = ("0x" + signature.slice(2, 66)) as `0x${string}`;
  const s = ("0x" + signature.slice(66, 130)) as `0x${string}`;
  let v = parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return {
    from: message.from,
    to: message.to,
    value: Number(message.value),
    valid_after: message.validAfter,
    valid_before: message.validBefore,
    nonce: authNonce,
    v,
    r,
    s,
  };
}
