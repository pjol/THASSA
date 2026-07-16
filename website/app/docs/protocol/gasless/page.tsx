import type { Metadata } from "next";
import Link from "next/link";
import Callout from "@/components/docs/Callout";
import CodeBlock from "@/components/docs/CodeBlock";
import Pager from "@/components/docs/Pager";

export const metadata: Metadata = {
  title: "Gasless orders",
  description:
    "Thassa's one-signature order flow: the EIP-712 Order type, the EIP-3009 funding authorization, and the signature carriage convention binding them — authNonce = order digest.",
  openGraph: {
    title: "Gasless orders",
    description:
      "Thassa's one-signature order flow: the EIP-712 Order type, the EIP-3009 funding authorization, and the signature carriage convention binding them — authNonce = order digest.",
  },
};

const orderStruct = `struct SignedOrder {
    uint256 marketId;
    uint8   side;            // Side: 0 = YES, 1 = NO
    uint8   price;           // cents, 1..99 (limit price the maker pays per share)
    uint80  shares;          // number of $1 shares
    uint256 maxCost;         // token units the signer authorizes at most (escrow + fee headroom)
    uint256 affiliatePostId; // 0 = none
    uint64  expiry;          // unix seconds
    uint256 nonce;           // per-maker sequential
    address maker;
}`;

const orderTypeString = `// EIP-712 domain
{ name: "ThassaMarkets", version: "1", chainId, verifyingContract }

// EIP-712 type (verbatim)
Order(uint256 marketId,uint8 side,uint8 price,uint80 shares,uint256 maxCost,uint256 affiliatePostId,uint64 expiry,uint256 nonce,address maker)`;

const auth3009 = `struct Auth3009 { // receiveWithAuthorization payload, from = order.maker, to = markets contract
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 authNonce;
    uint8 v; bytes32 r; bytes32 s;
}`;

const digestSnippet = `import { hashTypedData } from "viem";

const orderDigest = hashTypedData({
  domain: {
    name: "ThassaMarkets",
    version: "1",
    chainId,
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

// The ONE thing you sign: the payment token's ReceiveWithAuthorization
// typed data, with nonce = orderDigest.
const signature = await wallet.signTypedData({
  domain: paymentTokenDomain, // the token's own EIP-712 domain
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
    from: order.maker,
    to: MARKETS_CONTRACT,   // always the markets contract
    value: order.maxCost,
    validAfter: 0n,
    validBefore: BigInt(order.expiry),
    nonce: orderDigest,     // ← the signature carriage convention
  },
});`;

export default function Gasless() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Protocol
      </p>
      <h1 className="mt-3">Gasless orders</h1>
      <p>
        Thassa users never pay gas and never grant custody. An order is
        EIP-712 typed data; its funding is an EIP-3009{" "}
        <code>receiveWithAuthorization</code> paying the markets contract; and
        a <strong>single signature</strong> commits to both. The backend
        relayer batches signed orders onchain via{" "}
        <code>placeOrdersBatch</code> and pays the gas.
      </p>

      <h2 id="order-type">The Order type</h2>
      <p>The order every client signs against, pinned by the protocol:</p>
      <CodeBlock title="SignedOrder (Solidity)" code={orderStruct} />
      <CodeBlock title="EIP-712 domain + type" code={orderTypeString} />
      <ul>
        <li>
          <code>maxCost</code> caps what the order may pull: escrow (
          <code>price × shares</code>) plus taker-fee headroom. The EIP-3009
          authorization&rsquo;s <code>value</code> covers it.
        </li>
        <li>
          <code>nonce</code> is <strong>per-maker sequential</strong> (read it
          from <code>nonces(maker)</code> or{" "}
          <code>GET /trade-api/v1/balance</code>) and prevents replay.
        </li>
        <li>
          <code>expiry</code> bounds how long the signed order is valid.
        </li>
        <li>
          <code>affiliatePostId</code> credits the post that routed the trade
          with 5% of collected taker fees; <code>0</code> = none.
        </li>
      </ul>

      <h2 id="auth3009">The funding authorization</h2>
      <p>
        Funding rides an EIP-3009 payload for the payment token —{" "}
        <code>from = order.maker</code>,{" "}
        <code>to = the markets contract</code>, always:
      </p>
      <CodeBlock title="Auth3009 (Solidity)" code={auth3009} />

      <h2 id="signature-carriage">The signature carriage convention</h2>
      <Callout kind="danger" title="The one rule to get right">
        <strong><code>SignedOrder</code> carries no signature fields.</strong>{" "}
        For order placement, <code>auth.authNonce</code> MUST equal{" "}
        <code>orderDigest(order)</code> — the maker&rsquo;s EIP-712 typed-data
        digest under domain{" "}
        <code>{`{ThassaMarkets, 1, chainId, contract}`}</code> — so the single
        EIP-3009 signature commits to both the payment and the order.
      </Callout>
      <p>
        Clients sign <strong>one</strong> thing: the{" "}
        <code>ReceiveWithAuthorization</code> typed data whose{" "}
        <code>nonce</code> is the order digest. Because the digest covers
        every order field, tampering with any of them changes the digest,
        which invalidates the payment authorization — the order and its
        funding are inseparable.
      </p>
      <ul>
        <li>
          <code>orderDigest(SignedOrder) view</code> is exposed onchain, so
          any client can cross-check its own hashing.
        </li>
        <li>
          The relayer <strong>recomputes and validates the binding</strong>{" "}
          before batching — a mismatched <code>authNonce</code> is rejected at
          the door.
        </li>
        <li>
          <strong>Settlement authorizations</strong> (
          <code>settleMarketWithAuth</code>) are the exception: their nonce is
          a random 32 bytes; only <code>value ≥ settlementFee</code> is
          required.
        </li>
        <li>
          <strong>New-market opening orders</strong> are signed with{" "}
          <code>marketId = 0</code> and bound to the assigned id on creation.
        </li>
      </ul>

      <h2 id="signing">Signing in practice (viem)</h2>
      <p>
        Compute the order digest, then sign the token&rsquo;s{" "}
        <code>ReceiveWithAuthorization</code> with that digest as the nonce:
      </p>
      <CodeBlock title="signing.ts" code={digestSnippet} />
      <p>
        For the complete end-to-end example — building the payload and
        submitting it to <code>POST /trade-api/v1/orders</code> — see{" "}
        <Link href="/docs/api/trading">Trading API</Link>.
      </p>

      <h2 id="relayer">What the relayer does (and can&rsquo;t do)</h2>
      <ul>
        <li>
          Queues signed orders and submits batches every ~2s (or 25 orders)
          via <code>placeOrdersBatch(SignedOrder[], Auth3009[])</code> —
          batching is what amortizes gas to zero for users.
        </li>
        <li>
          Only ever signs transactions to the allowlisted platform contracts
          and whitelisted methods. <strong>Never arbitrary calldata.</strong>
        </li>
        <li>
          Validates server-side that every EIP-3009 authorization pays{" "}
          <em>the markets contract</em> before relaying.
        </li>
        <li>
          Cannot forge orders: it holds no user keys, and every order&rsquo;s
          funding is a signature only the maker could have produced.
        </li>
      </ul>
      <p>
        Once batched, your order&rsquo;s state moves <code>QUEUED</code> →{" "}
        <code>RESTING</code> / <code>PARTIAL</code> / <code>FILLED</code>;
        cancels work the same way with a signed cancel. Prefer no relayer at
        all? Use the <Link href="/docs/protocol/onchain">direct onchain
        path</Link>.
      </p>

      <Pager
        prev={{ href: "/docs/protocol/settlement", label: "Settlement & sources" }}
        next={{ href: "/docs/protocol/onchain", label: "Direct onchain" }}
      />
    </>
  );
}
