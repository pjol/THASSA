import type { Metadata } from "next";
import Link from "next/link";
import Callout from "@/components/docs/Callout";
import CodeBlock from "@/components/docs/CodeBlock";
import Pager from "@/components/docs/Pager";
import StateChip from "@/components/StateChip";

export const metadata: Metadata = {
  title: "Markets & order book",
  description:
    "Thassa's binary YES/NO cent-priced order book: 1–99¢ limit prices, $1 payouts, p+q ≥ 100 crossing, maker-price execution, the market lifecycle, and the full fee schedule with worked examples.",
  openGraph: {
    title: "Markets & order book",
    description:
      "Thassa's binary YES/NO cent-priced order book: 1–99¢ limit prices, $1 payouts, p+q ≥ 100 crossing, maker-price execution, the market lifecycle, and the full fee schedule with worked examples.",
  },
};

const feeFormula = `fee = ceil(7% × shares × p × (100 − p) / 10000)   // dollars, p = execution price in cents
    = ceil(takerFeeBps × shares × p × (100 − p) / 10000 / 10000)   // takerFeeBps = 700`;

const crossExample = `Resting (maker):  buy NO  @ 40¢ × 500 shares     — the maker
Incoming (taker): buy YES @ 65¢ × 300 shares     — crosses: 65 + 40 ≥ 100

Execution: 300 shares AT THE MAKER'S LEVEL — taker pays 100 − 40 = 60¢/share
  taker escrow used:  300 × $0.60 = $180  (+ taker fee)
  maker escrow used:  300 × $0.40 = $120
  → each matched pair holds $1.00/share, fully collateralized`;

export default function Markets() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Protocol
      </p>
      <h1 className="mt-3">Markets &amp; order book</h1>
      <p>
        Every Thassa market is a <strong>binary YES/NO order book priced in
        cents</strong>. A share pays <strong>$1</strong> to the winning side.
        Price is probability: YES at 62¢ is the book saying 62%.
      </p>

      <h2 id="model">The pricing model</h2>
      <ul>
        <li>
          An order is always <strong>&ldquo;buy <code>side</code> at limit price{" "}
          <code>p</code> cents for <code>shares</code> shares&rdquo;</strong> —
          there is no separate sell verb; exiting a YES position means buying
          NO (or redeeming after settlement).
        </li>
        <li>
          Limit prices are integers <strong>1..99</strong> cents.
        </li>
        <li>
          <strong>Escrow:</strong> a YES buyer at <code>p</code> escrows{" "}
          <code>p × shares</code> cents; a NO buyer at <code>q</code> escrows{" "}
          <code>q × shares</code> cents (all in payment-token base units).
        </li>
        <li>
          <strong>Crossing:</strong> buy YES @ <code>p</code> matches resting
          buy NO @ <code>q</code> whenever <code>p + q ≥ 100</code> — together
          the pair fully collateralizes the $1 payout.
        </li>
      </ul>

      <h2 id="matching">Matching rules</h2>
      <p>
        Matching happens at order placement: the incoming order takes the best
        crossing price levels first, then any remainder rests on the book as a
        maker order.
      </p>
      <ul>
        <li>
          <strong>Price-time priority.</strong> Better-priced resting orders
          fill first; within a price level, first in, first filled (FIFO).
        </li>
        <li>
          <strong>Execution at the maker&rsquo;s price.</strong> The resting
          order&rsquo;s level sets the execution price — a taker&rsquo;s aggressive
          limit only widens what can cross; it never worsens the fill.
        </li>
      </ul>
      <CodeBlock title="worked match" code={crossExample} />
      <p>
        Under the hood the book is gas-friendly: per market and side, a{" "}
        <code>uint128</code> price-level bitmap gives O(1) best-price
        discovery, and each level holds a FIFO queue of packed orders.
      </p>

      <h2 id="lifecycle">Market lifecycle</h2>
      <p>
        A market moves through <strong>six states</strong>. The same values
        appear in the app, in API responses, and throughout these docs:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><StateChip state="PENDING" /></td>
              <td>Creation or settlement transaction in flight.</td>
            </tr>
            <tr>
              <td><StateChip state="OPEN" /></td>
              <td>
                Live; the creator&rsquo;s opening bet is on the book, waiting for
                someone to take the other side.
              </td>
            </tr>
            <tr>
              <td><StateChip state="MATCHED" /></td>
              <td>
                The creator&rsquo;s opening bet has been taken — the first fill
                landed. Trading continues.
              </td>
            </tr>
            <tr>
              <td><StateChip state="SETTLING" /></td>
              <td>Settlement query running through the oracle pipeline.</td>
            </tr>
            <tr>
              <td><StateChip state="SETTLED" direction="YES" /></td>
              <td>
                Outcome final, direction recorded (YES or NO). Winners redeem
                $1/share.
              </td>
            </tr>
            <tr>
              <td><StateChip state="VOID" /></td>
              <td>
                Invalidated by the platform (owner-only{" "}
                <code>voidMarket</code>); all deposits refundable.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="order-states">Order states</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><StateChip state="SIGNING" /></td><td>Awaiting the user&rsquo;s signature.</td></tr>
            <tr><td><StateChip state="QUEUED" /></td><td>Accepted; waiting in a relayer batch.</td></tr>
            <tr><td><StateChip state="RESTING" /></td><td>Open on the book as a maker order.</td></tr>
            <tr><td><StateChip state="PARTIAL" /></td><td>Partially filled; remainder still resting.</td></tr>
            <tr><td><StateChip state="FILLED" /></td><td>Fully filled.</td></tr>
            <tr><td><StateChip state="CANCELED" /></td><td>Canceled by the maker (unfilled remainder refunded).</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="creation">Creating a market</h2>
      <p>
        Market creation is <strong>free</strong> — no protocol fee — but the
        creator&rsquo;s initial order must deposit at least <strong>$1</strong> of
        capital. That opening bet is the market&rsquo;s first liquidity, and the
        creator is committed to it: the market shows{" "}
        <StateChip state="OPEN" /> until someone takes the other side, then{" "}
        <StateChip state="MATCHED" />. Both the question and the structured
        settlement query are stored onchain as public strings at creation.
      </p>

      <h2 id="fees">Fees</h2>
      <p>
        Fees are <strong>taker-side only</strong> — makers pay nothing. The
        fee on each match, at execution price <code>p</code> (the maker&rsquo;s
        price, in cents):
      </p>
      <CodeBlock title="taker fee" code={feeFormula} />
      <p>
        The fee is quadratic in uncertainty — largest at 50¢, vanishing toward
        1¢/99¢ — and is deducted from the taker&rsquo;s escrow, rounded{" "}
        <strong>up</strong> at the token&rsquo;s base unit.
      </p>
      <h3 id="fee-examples">Worked examples</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Fill</th>
              <th>p × (100−p) / 10000</th>
              <th>Fee math</th>
              <th>Taker fee</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>100 shares @ 50¢</td>
              <td>0.25</td>
              <td>0.07 × 100 × 0.25</td>
              <td><strong>$1.75</strong></td>
            </tr>
            <tr>
              <td>100 shares @ 62¢</td>
              <td>0.2356</td>
              <td>0.07 × 100 × 0.2356</td>
              <td><strong>$1.6492</strong></td>
            </tr>
            <tr>
              <td>10 shares @ 95¢</td>
              <td>0.0475</td>
              <td>0.07 × 10 × 0.0475</td>
              <td><strong>$0.03325</strong></td>
            </tr>
            <tr>
              <td>1 share @ 99¢</td>
              <td>0.0099</td>
              <td>0.07 × 1 × 0.0099</td>
              <td><strong>$0.000693</strong> (ceils to 693 base units at 6 decimals)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="fee-splits">Where fees go</h3>
      <ul>
        <li>
          <strong>10%</strong> of every collected fee accrues to the{" "}
          <strong>market creator</strong> (claimable via{" "}
          <code>claimCreatorFees</code>).
        </li>
        <li>
          <strong>5%</strong> goes to the <strong>affiliate</strong> — the
          post whose market widget routed the order (
          <code>affiliatePostId</code>; <code>0</code> = none, in which case
          the share goes to the protocol).
        </li>
        <li>The remainder goes to the protocol vault.</li>
      </ul>

      <h3 id="flat-fees">Flat fees</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Fee</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Market creation</td>
              <td><strong>Free</strong></td>
              <td>Requires a ≥ $1 initial order.</td>
            </tr>
            <tr>
              <td>Settlement trigger</td>
              <td><strong>$0.05</strong></td>
              <td>
                Paid by whoever calls <code>settleMarket</code>; funds the hub
                bid. Re-triggerable if the bid is cancelled or expires.
              </td>
            </tr>
            <tr>
              <td>Withdrawal</td>
              <td><strong>$0.10 flat</strong> (default, owner-configurable)</td>
              <td>
                Charged on <code>redeem</code>/<code>withdraw</code> transfers
                out; sized ≈ market-creation gas.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="redemption">Settlement &amp; redemption</h2>
      <ol>
        <li>
          Anyone calls <code>settleMarket(marketId)</code> and pays the $0.05
          trigger. Status → <StateChip state="SETTLING" />.
        </li>
        <li>
          The oracle pipeline resolves the outcome — see{" "}
          <Link href="/docs/protocol/settlement">Settlement &amp; sources</Link>.
          Status → <StateChip state="SETTLED" direction="YES" />.
        </li>
        <li>
          Winners call <code>redeem(marketId)</code> for $1/share, minus the
          flat withdrawal fee. Unmatched or resting deposits are refundable
          any time via <code>withdraw</code>.
        </li>
      </ol>

      <Callout kind="info" title="Fee constants (owner-settable)">
        <code>takerFeeBps = 700</code> · <code>creatorFeeShareBps = 1000</code>{" "}
        · <code>affiliateFeeShareBps = 500</code> ·{" "}
        <code>withdrawalFlatFee</code> default $0.10 ·{" "}
        <code>settlementFee</code> default $0.05.
      </Callout>

      <Pager
        prev={{ href: "/docs/protocol/architecture", label: "Architecture" }}
        next={{ href: "/docs/protocol/settlement", label: "Settlement & sources" }}
      />
    </>
  );
}
