import type { Metadata } from "next";
import Link from "next/link";
import Callout from "@/components/docs/Callout";
import CodeBlock from "@/components/docs/CodeBlock";
import Pager from "@/components/docs/Pager";

export const metadata: Metadata = {
  title: "Direct onchain interaction",
  description:
    "Skip the relayer: pre-approve the payment token and call placeOrder, cancelOrder, redeem, and settleMarket directly on the ThassaMarkets contract.",
  openGraph: {
    title: "Direct onchain interaction",
    description:
      "Skip the relayer: pre-approve the payment token and call placeOrder, cancelOrder, redeem, and settleMarket directly on the ThassaMarkets contract.",
  },
};

const surface = `enum Side { YES, NO } // 0 = YES, 1 = NO

function createMarketDirect(string calldata question, string calldata settlementQuery,
    uint8 side, uint8 price, uint80 shares) external returns (uint256 marketId);   // transferFrom path
function placeOrder(uint256 marketId, uint8 side, uint8 price, uint80 shares,
    uint256 affiliatePostId) external returns (uint256 orderId);                   // direct path
function cancelOrder(uint256 marketId, uint256 orderId) external;
function settleMarket(uint256 marketId) external;      // pulls $0.05 via transferFrom
function redeem(uint256 marketId) external;            // winner claims, minus withdrawal fee
function withdraw(uint256 amount) external;            // free balance out, minus withdrawal fee
function claimCreatorFees(uint256 marketId) external;
function claimAffiliateFees(uint256 postId) external;

function getMarket(uint256 marketId) external view returns (Market memory);
function bestPrices(uint256 marketId) external view returns (uint8 bestYes, uint8 bestNo);
function nonces(address maker) external view returns (uint256);`;

const events = `event MarketCreated(uint256 indexed marketId, address indexed creator, string question, string settlementQuery);
event OrderPlaced(uint256 indexed marketId, uint256 indexed orderId, address indexed maker, uint8 side, uint8 price, uint80 shares);
event OrderMatched(uint256 indexed marketId, uint256 takerOrderId, uint256 makerOrderId, uint8 price, uint80 shares, uint256 fee);
event OrderCancelled(uint256 indexed marketId, uint256 indexed orderId);
event MarketMatched(uint256 indexed marketId);   // first fill vs creator's opening order
event SettlementRequested(uint256 indexed marketId, uint256 bidId, address indexed caller);
event MarketSettled(uint256 indexed marketId, bool direction);`;

const placeExample = `import { createWalletClient, http, parseUnits } from "viem";

// 1. One-time: approve the payment token for the markets contract.
await wallet.writeContract({
  address: PAYMENT_TOKEN,
  abi: erc20Abi,
  functionName: "approve",
  args: [MARKETS_CONTRACT, parseUnits("1000", 6)], // token uses 6 decimals here
});

// 2. Buy 100 YES shares at a 62¢ limit. Escrow pulled via transferFrom:
//    100 × $0.62 = $62 (+ taker fee on any crossing fills).
const orderId = await wallet.writeContract({
  address: MARKETS_CONTRACT,
  abi: thassaMarketsAbi,
  functionName: "placeOrder",
  args: [
    42n,   // marketId
    0,     // side: 0 = YES
    62,    // price, cents
    100n,  // shares
    0n,    // affiliatePostId (0 = none)
  ],
});

// 3. Later: cancel the unfilled remainder, or redeem after settlement.
await wallet.writeContract({
  address: MARKETS_CONTRACT,
  abi: thassaMarketsAbi,
  functionName: "cancelOrder",
  args: [42n, orderId],
});

await wallet.writeContract({
  address: MARKETS_CONTRACT,
  abi: thassaMarketsAbi,
  functionName: "redeem",
  args: [42n], // $1/share to the winning side, minus the flat withdrawal fee
});`;

export default function Onchain() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Protocol
      </p>
      <h1 className="mt-3">Direct onchain interaction</h1>
      <p>
        The relayer is a convenience, not a gate. Power users can interact
        with the <code>ThassaMarkets</code> contract directly, pre-approve
        the payment token, pay your own gas, and call the book with no
        signatures relayed and no API key involved. Both paths land on the
        same order book with the same matching rules.
      </p>

      <h2 id="surface">Contract surface</h2>
      <CodeBlock title="ThassaMarkets, direct-path external surface" code={surface} />
      <Callout kind="info" title="Two paths, one book">
        The relayer path (<code>createMarket</code>,{" "}
        <code>placeOrdersBatch</code>) funds orders with EIP-3009
        authorizations; the direct path funds via{" "}
        <code>transferFrom</code> after a standard ERC-20 approval. Orders
        from both paths cross against each other.
      </Callout>

      <h2 id="placing">Placing and managing orders</h2>
      <ul>
        <li>
          <code>placeOrder(marketId, side, price, shares, affiliatePostId)</code>{" "}
         , escrows <code>price × shares</code> (YES) or the complement (NO)
          via <code>transferFrom</code>, matches whatever crosses at the best
          levels (taker fee applies to matched shares), and rests the
          remainder. Callable by anyone onchain.
        </li>
        <li>
          <code>cancelOrder(marketId, orderId)</code>, maker only (or via
          relayer with a signed cancel); refunds the unfilled remainder to
          your free balance.
        </li>
        <li>
          <code>settleMarket(marketId)</code>, anyone; pulls the $0.05
          settlement fee via <code>transferFrom</code> and places the hub bid.
          Re-triggerable if the bid is cancelled or expires.
        </li>
        <li>
          <code>redeem(marketId)</code>, after <code>SETTLED</code>, pays $1
          per winning share, minus the flat withdrawal fee.
        </li>
        <li>
          <code>withdraw(amount)</code>, moves free (unescrowed) balance out,
          minus the flat withdrawal fee.
        </li>
      </ul>

      <h2 id="example">Example (viem)</h2>
      <CodeBlock title="direct-path trading" code={placeExample} />

      <h2 id="views">Views worth knowing</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>View</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>getMarket(marketId)</code></td>
              <td>
                The <code>Market</code> struct: creator, status, settlement
                outcome (<code>settled</code>, <code>direction</code>),
                accrued creator fees, matched volume.
              </td>
            </tr>
            <tr>
              <td><code>bestPrices(marketId)</code></td>
              <td>Best resting YES and NO prices (cents).</td>
            </tr>
            <tr>
              <td><code>nonces(maker)</code></td>
              <td>The maker&rsquo;s next sequential order nonce (relayer path).</td>
            </tr>
            <tr>
              <td><code>orderDigest(order)</code></td>
              <td>
                EIP-712 digest of a <code>SignedOrder</code>, cross-check
                your client-side hashing (see{" "}
                <Link href="/docs/protocol/gasless">Gasless orders</Link>).
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="events">Events</h2>
      <p>All indexed for offchain consumption:</p>
      <CodeBlock title="events" code={events} />
      <p>
        Plus <code>OrderCancelled</code>, <code>Redeemed</code>,{" "}
        <code>Withdrawn</code>, <code>CreatorFeesClaimed</code>, and{" "}
        <code>AffiliateFeesClaimed</code> for accounting flows. If you run
        your own indexer, key event processing by{" "}
        <code>(tx_hash, log_index)</code> and upsert, re-scans are then
        harmless.
      </p>

      <Pager
        prev={{ href: "/docs/protocol/gasless", label: "Gasless orders" }}
        next={{ href: "/docs/api/market-data", label: "Market data (public)" }}
      />
    </>
  );
}
