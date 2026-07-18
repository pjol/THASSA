import type { Metadata } from "next";
import Link from "next/link";
import ClientTabs from "@/components/docs/ClientTabs";
import CodeBlock from "@/components/docs/CodeBlock";
import Endpoint from "@/components/docs/Endpoint";
import ParamTable from "@/components/docs/ParamTable";
import Callout from "@/components/docs/Callout";
import Pager from "@/components/docs/Pager";
import { API_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Trading API",
  description:
    "Authenticated trading on Thassa: place non-custodial signed orders (authNonce = order digest), cancel, and read your orders, positions, fills, and balance.",
  openGraph: {
    title: "Trading API",
    description:
      "Authenticated trading on Thassa: place non-custodial signed orders (authNonce = order digest), cancel, and read your orders, positions, fills, and balance.",
  },
};

const B = API_URL;

const orderPayload = `{
  "order": {
    "market_id": "42",
    "side": 0,                      // 0 = YES, 1 = NO
    "price": 62,                    // cents, 1..99
    "shares": "100",
    "max_cost": "63700000",         // token base units: escrow + fee headroom
    "affiliate_post_id": "0",
    "expiry": 1752969600,           // unix seconds
    "nonce": "7",                   // per-maker sequential
    "maker": "0x4A1f…9E02"          // MUST be your registered wallet
  },
  "auth": {                          // EIP-3009 ReceiveWithAuthorization
    "value": "63700000",
    "valid_after": "0",
    "valid_before": "1752969600",
    "auth_nonce": "0x83fa…11cd",    // = orderDigest(order), signature carriage
    "v": 27,
    "r": "0x5c02…aa19",
    "s": "0x2e8d…03b7"
  }
}`;

const orderResponse = `{
  "order": {
    "id": "0f6b1c9a-88a1-4c5e-b7d2-6f6a5f3f2e11",
    "market_id": "42",
    "side": "yes",
    "price_cents": 62,
    "shares": "100",
    "filled_shares": "0",
    "status": "QUEUED",
    "created_at": "2026-07-16T09:12:30Z"
  }
}`;

const viemExample = `import { createWalletClient, hashTypedData, http, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

const account = privateKeyToAccount(process.env.WALLET_KEY as \`0x\${string}\`);
const wallet = createWalletClient({ account, transport: http(RPC_URL) });

// 1. Build the order. nonce is per-maker sequential, read it from
//    GET /trade-api/v1/balance (order_nonce) or the contract's nonces(maker).
const order = {
  marketId: 42n,
  side: 0,                             // 0 = YES
  price: 62,                           // cents
  shares: 100n,
  maxCost: 63_700_000n,                // 100 × $0.62 escrow + fee headroom (6-dp token)
  affiliatePostId: 0n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  nonce: 7n,
  maker: account.address,
};

// 2. Compute the order's EIP-712 digest, domain {ThassaMarkets, 1, chainId, contract}.
const orderDigest = hashTypedData({
  domain: {
    name: "ThassaMarkets",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: MARKETS_CONTRACT,
  },
  types: {
    Order: [
      { name: "marketId",        type: "uint256" },
      { name: "side",            type: "uint8"   },
      { name: "price",           type: "uint8"   },
      { name: "shares",          type: "uint80"  },
      { name: "maxCost",         type: "uint256" },
      { name: "affiliatePostId", type: "uint256" },
      { name: "expiry",          type: "uint64"  },
      { name: "nonce",           type: "uint256" },
      { name: "maker",           type: "address" },
    ],
  },
  primaryType: "Order",
  message: order,
});

// 3. Sign ONE thing: the payment token's ReceiveWithAuthorization,
//    with nonce = orderDigest (the signature carriage convention).
const signature = await wallet.signTypedData({
  domain: {
    name: PAYMENT_TOKEN_NAME,          // the token's own EIP-712 domain
    version: PAYMENT_TOKEN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: PAYMENT_TOKEN,
  },
  types: {
    ReceiveWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "validAfter",  type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce",       type: "bytes32" },
    ],
  },
  primaryType: "ReceiveWithAuthorization",
  message: {
    from: account.address,
    to: MARKETS_CONTRACT,              // always the markets contract
    value: order.maxCost,
    validAfter: 0n,
    validBefore: BigInt(order.expiry),
    nonce: orderDigest,
  },
});
const { v, r, s } = parseSignature(signature);

// 4. Submit, idempotently.
const res = await fetch("${B}/trade-api/v1/orders", {
  method: "POST",
  headers: {
    "X-Thassa-Key": process.env.THASSA_KEY!,
    "Idempotency-Key": randomUUID(),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    order: {
      market_id: order.marketId.toString(),
      side: order.side,
      price: order.price,
      shares: order.shares.toString(),
      max_cost: order.maxCost.toString(),
      affiliate_post_id: order.affiliatePostId.toString(),
      expiry: Number(order.expiry),
      nonce: order.nonce.toString(),
      maker: order.maker,
    },
    auth: {
      value: order.maxCost.toString(),
      valid_after: "0",
      valid_before: order.expiry.toString(),
      auth_nonce: orderDigest,
      v: Number(v),
      r,
      s,
    },
  }),
});
if (!res.ok) throw new Error((await res.json()).error);
const { order: placed } = await res.json(); // status: "QUEUED"`;

const curlOrder = `curl -X POST "${B}/trade-api/v1/orders" \\
  -H "X-Thassa-Key: $THASSA_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d @order.json   # payload as shown above, signed client-side`;

const pyOrder = `import os, uuid, requests

# Sign the order client-side first (eth_account can sign both typed-data
# payloads; the flow mirrors the TypeScript example: compute the Order
# digest, then sign ReceiveWithAuthorization with nonce = digest).
payload = build_signed_order_payload()  # → the JSON shown above

res = requests.post(
    "${B}/trade-api/v1/orders",
    headers={
        "X-Thassa-Key": os.environ["THASSA_KEY"],
        "Idempotency-Key": str(uuid.uuid4()),
    },
    json=payload,
)
res.raise_for_status()
order = res.json()["order"]   # status: "QUEUED"`;

const cancelTabs = [
  {
    label: "curl",
    code: `curl -X DELETE "${B}/trade-api/v1/orders/0f6b1c9a-88a1-4c5e-b7d2-6f6a5f3f2e11" \\
  -H "X-Thassa-Key: $THASSA_KEY" \\
  -H "Idempotency-Key: $(uuidgen)"`,
  },
  {
    label: "TypeScript",
    code: `const res = await fetch(
  "${B}/trade-api/v1/orders/0f6b1c9a-88a1-4c5e-b7d2-6f6a5f3f2e11",
  {
    method: "DELETE",
    headers: {
      "X-Thassa-Key": process.env.THASSA_KEY!,
      "Idempotency-Key": crypto.randomUUID(),
    },
  }
);
const { order } = await res.json(); // status: "CANCELED"`,
  },
  {
    label: "Python",
    code: `import os, uuid, requests

res = requests.delete(
    "${B}/trade-api/v1/orders/0f6b1c9a-88a1-4c5e-b7d2-6f6a5f3f2e11",
    headers={
        "X-Thassa-Key": os.environ["THASSA_KEY"],
        "Idempotency-Key": str(uuid.uuid4()),
    },
)
res.raise_for_status()
order = res.json()["order"]  # status: "CANCELED"`,
  },
];

const authedGetTabs = (path: string, key: string) => [
  {
    label: "curl",
    code: `curl "${B}${path}" \\
  -H "X-Thassa-Key: $THASSA_KEY"`,
  },
  {
    label: "TypeScript",
    code: `const res = await fetch("${B}${path}", {
  headers: { "X-Thassa-Key": process.env.THASSA_KEY! },
});
const { ${key} } = await res.json();`,
  },
  {
    label: "Python",
    code: `import os, requests

res = requests.get(
    "${B}${path}",
    headers={"X-Thassa-Key": os.environ["THASSA_KEY"]},
)
res.raise_for_status()
${key} = res.json()["${key}"]`,
  },
];

const ordersRes = `{
  "orders": [
    {
      "id": "0f6b1c9a-88a1-4c5e-b7d2-6f6a5f3f2e11",
      "market_id": "42",
      "side": "yes",
      "price_cents": 62,
      "shares": "100",
      "filled_shares": "40",
      "status": "PARTIAL",
      "created_at": "2026-07-16T09:12:30Z"
    }
  ],
  "next_cursor": null
}`;

const positionsRes = `{
  "positions": [
    {
      "market_id": "42",
      "question": "Will it rain in San Francisco on Saturday?",
      "market_status": "OPEN",
      "side": "yes",
      "shares": "40",
      "avg_price_cents": 62,
      "realized_pnl": "0"
    }
  ],
  "next_cursor": null
}`;

const fillsRes = `{
  "fills": [
    {
      "id": "f7a2…",
      "market_id": "42",
      "order_id": "0f6b1c9a-88a1-4c5e-b7d2-6f6a5f3f2e11",
      "side": "yes",
      "price_cents": 62,
      "shares": "40",
      "fee": "659680",
      "tx_hash": "0x8c31…e9d0",
      "created_at": "2026-07-16T09:12:34Z"
    }
  ],
  "next_cursor": null
}`;

const balanceRes = `{
  "balance": "241503300",
  "wallet_address": "0x4A1f…9E02",
  "order_nonce": "8"
}`;

export default function Trading() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        API reference
      </p>
      <h1 className="mt-3">Trading (authenticated)</h1>
      <p>
        All endpoints here require <code>X-Thassa-Key</code>; mutations
        require scope <code>trade</code> and honor{" "}
        <Link href="/docs/getting-started#idempotency">
          <code>Idempotency-Key</code>
        </Link>
        . Order placement goes through the same relayer gate as the app:
        same validation, same batching, same states.
      </p>

      <h2 id="place-order">Place an order</h2>
      <Endpoint method="POST" path="/trade-api/v1/orders" auth="X-Thassa-Key · scope trade" />
      <p>
        Accepts the <strong>same non-custodial payload as the app</strong>:
        the order fields plus an EIP-3009 authorization whose{" "}
        <code>auth_nonce</code> equals the order&rsquo;s EIP-712 digest (the{" "}
        <Link href="/docs/protocol/gasless#signature-carriage">signature
        carriage convention</Link>). The API never signs for you, it
        validates and relays.
      </p>
      <Callout kind="danger" title="Maker binding">
        <code>order.maker</code> MUST equal the wallet registered to the API
        key&rsquo;s user. Orders signed by any other address are rejected.
      </Callout>
      <ParamTable
        title="Body field"
        params={[
          { name: "order.market_id", type: "string", required: true, desc: "Target market. New-market opening orders are signed with marketId = 0 and bound to the assigned id on creation." },
          { name: "order.side", type: "int", required: true, desc: "0 = YES, 1 = NO." },
          { name: "order.price", type: "int", required: true, desc: "Limit price in cents, 1..99." },
          { name: "order.shares", type: "string", required: true, desc: "Number of $1 shares." },
          { name: "order.max_cost", type: "string", required: true, desc: "Max token base units the signature authorizes (escrow + taker-fee headroom)." },
          { name: "order.affiliate_post_id", type: "string", required: true, desc: "Post routing the trade; \"0\" = none." },
          { name: "order.expiry", type: "int", required: true, desc: "Unix seconds; order invalid after this." },
          { name: "order.nonce", type: "string", required: true, desc: "Per-maker sequential nonce." },
          { name: "order.maker", type: "address", required: true, desc: "Your registered wallet." },
          { name: "auth.value", type: "string", required: true, desc: "EIP-3009 value; must cover max_cost." },
          { name: "auth.valid_after / valid_before", type: "string", required: true, desc: "Authorization validity window (unix seconds)." },
          { name: "auth.auth_nonce", type: "bytes32", required: true, desc: "MUST equal orderDigest(order). Validated before batching." },
          { name: "auth.v / r / s", type: "sig", required: true, desc: "The single EIP-3009 signature." },
        ]}
      />
      <CodeBlock title="request body" code={orderPayload} />
      <ClientTabs
        tabs={[
          { label: "TypeScript", title: "place-order.ts (viem, complete)", code: viemExample },
          { label: "curl", code: curlOrder },
          { label: "Python", code: pyOrder },
        ]}
      />
      <CodeBlock title="201 response" code={orderResponse} />
      <p>
        The response is immediate with status <code>QUEUED</code>; the relayer
        lands the batch onchain seconds later and the order moves to{" "}
        <code>RESTING</code>, <code>PARTIAL</code>, or <code>FILLED</code>.
        Track it via <code>GET /trade-api/v1/orders</code> or the{" "}
        <Link href="/docs/api/websocket">WebSocket</Link>.
      </p>

      <h2 id="cancel-order">Cancel an order</h2>
      <Endpoint method="DELETE" path="/trade-api/v1/orders/{id}" auth="X-Thassa-Key · scope trade" />
      <p>
        Cancels a resting order (signed cancel, relayed like placement). The
        unfilled remainder is refunded to your free balance; already-filled
        shares stay filled.
      </p>
      <ClientTabs tabs={cancelTabs} />

      <h2 id="get-orders">List your orders</h2>
      <Endpoint method="GET" path="/trade-api/v1/orders" auth="X-Thassa-Key · scope read" />
      <ParamTable
        title="Query parameter"
        params={[
          { name: "market", type: "string", desc: "Filter to one market id." },
          { name: "cursor", type: "string", desc: "Opaque pagination cursor." },
          { name: "limit", type: "int", desc: "Page size (server-capped)." },
        ]}
      />
      <ClientTabs tabs={authedGetTabs("/trade-api/v1/orders?market=42", "orders")} />
      <CodeBlock title="200 response" code={ordersRes} />

      <h2 id="get-positions">List your positions</h2>
      <Endpoint method="GET" path="/trade-api/v1/positions" auth="X-Thassa-Key · scope read" />
      <p>
        Net position per market and side, with average entry price and
        realized PnL (in token base units).
      </p>
      <ClientTabs tabs={authedGetTabs("/trade-api/v1/positions", "positions")} />
      <CodeBlock title="200 response" code={positionsRes} />

      <h2 id="get-fills">List your fills</h2>
      <Endpoint method="GET" path="/trade-api/v1/fills" auth="X-Thassa-Key · scope read" />
      <p>
        Your execution history across markets, every match your orders
        participated in, with price, shares, fee, and transaction hash.
      </p>
      <ClientTabs tabs={authedGetTabs("/trade-api/v1/fills", "fills")} />
      <CodeBlock title="200 response" code={fillsRes} />

      <h2 id="get-balance">Get your balance</h2>
      <Endpoint method="GET" path="/trade-api/v1/balance" auth="X-Thassa-Key · scope read" />
      <p>
        Payment-token balance of your registered wallet, plus your next
        sequential order nonce.
      </p>
      <ClientTabs tabs={authedGetTabs("/trade-api/v1/balance", "balance")} />
      <CodeBlock title="200 response" code={balanceRes} />

      <Pager
        prev={{ href: "/docs/api/market-data", label: "Market data (public)" }}
        next={{ href: "/docs/api/keys", label: "API keys" }}
      />
    </>
  );
}
