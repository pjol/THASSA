import type { Metadata } from "next";
import Link from "next/link";
import Callout from "@/components/docs/Callout";
import Pager from "@/components/docs/Pager";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "How Thassa settles markets: markets contract → hub → PoA node → PoA verifier → callback. The full proof-of-authority settlement pipeline.",
  openGraph: {
    title: "Architecture",
    description:
      "How Thassa settles markets: markets contract → hub → PoA node → PoA verifier → callback. The full proof-of-authority settlement pipeline.",
  },
};

function FlowBox({
  title,
  sub,
  accent = false,
}: {
  title: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border px-4 py-3 text-center ${
        accent ? "border-brand/40 bg-brand/[0.07]" : "hairline bg-card"
      }`}
    >
      <p className={`text-[13.5px] font-semibold ${accent ? "text-brand" : ""}`}>{title}</p>
      <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">{sub}</p>
    </div>
  );
}

function FlowArrow({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center py-0.5" aria-hidden="true">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted">{label}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5 text-brand">
        <path d="M12 4v14m0 0 5-5m-5 5-5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export default function Architecture() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Protocol
      </p>
      <h1 className="mt-3">Architecture</h1>
      <p>
        Thassa markets settle through a <strong>proof-of-authority (PoA)
        oracle pipeline</strong>: the markets contract asks the Thassa hub a
        question, an authorized oracle node answers it against publicly bound
        sources, a PoA verifier checks the node&rsquo;s signature onchain, and the
        hub calls the market back with the outcome. Nothing settles on an
        unverified answer, and every question is stored onchain in public.
      </p>

      <h2 id="pipeline">The settlement pipeline</h2>
      <div className="not-prose mx-auto my-6 flex max-w-[440px] flex-col">
        <FlowBox title="ThassaMarkets" sub="all markets, one contract · oracle client" accent />
        <FlowArrow label="settleMarket → placeBidWithInputData(marketId, query)" />
        <FlowBox title="ThassaHub" sub="oracle request hub · bids & updates" />
        <FlowArrow label="bid observed · inputData = (marketId, settlementQuery)" />
        <FlowBox title="Oracle node (PoA fulfiller)" sub="fetches bound sources · adjudicates · signs" accent />
        <FlowArrow label="signed ProofUpdateV2 envelope" />
        <FlowBox title="ThassaPoAVerifier" sub="owner-managed signer set · verifies signature" />
        <FlowArrow label="verified update accepted by the hub" />
        <FlowBox title="Hub callback → _updateOracle" sub="(marketId, settled, direction) · status → SETTLED" accent />
      </div>

      <h2 id="components">Components</h2>

      <h3 id="markets-contract">ThassaMarkets</h3>
      <p>
        One contract holds <strong>all</strong> markets — no per-market
        deployments, which keeps creation gas-free at the protocol level. It
        extends <code>ThassaOracle</code>, making it an oracle <em>client</em>{" "}
        of the hub: it places settlement bids and receives the hub&rsquo;s
        callback. It also runs the entire{" "}
        <Link href="/docs/protocol/markets">order book</Link> — escrow,
        matching, fees, redemption.
      </p>

      <h3 id="hub">ThassaHub</h3>
      <p>
        The oracle request hub. A settlement request is a hub bid placed via{" "}
        <code>placeBidWithInputData</code>, where{" "}
        <code>inputData = abi.encode(marketId, settlementQuery)</code>. The
        hub holds the bid while the market is <code>SETTLING</code>, accepts a
        verified update, and invokes the markets contract&rsquo;s callback. Replay
        protection comes from hub update digests.
      </p>

      <h3 id="verifier">ThassaPoAVerifier</h3>
      <p>
        The trust anchor. An owner-managed signer set (<code>addSigner</code>,{" "}
        <code>removeSigner</code>, <code>isSigner</code>,{" "}
        <code>signerCount</code>) verifies each update: the update&rsquo;s{" "}
        <code>fulfiller</code> must be an authorized signer, and the signature
        — EIP-191 <code>personal_sign</code> over the hub&rsquo;s{" "}
        <code>ProofUpdateV2</code> digest — must recover to that exact
        fulfiller. Signer changes emit <code>SignerAdded</code> /{" "}
        <code>SignerRemoved</code>.
      </p>

      <h3 id="node">The oracle node</h3>
      <p>
        An offchain fulfiller run by Thassa. For each settlement bid it:
      </p>
      <ol>
        <li>
          Parses the structured settlement query from bid <code>inputData</code>{" "}
          — <code>{`{question, category, rule, sources}`}</code>.
        </li>
        <li>
          <strong>Fetches the bound sources itself</strong> (ESPN, NWS, news
          APIs, pricing APIs) — in the node process, before and separate from
          any LLM call.
        </li>
        <li>
          Adjudicates <strong>only from the fetched evidence</strong> — no open
          web search. For <code>majority</code>-rule queries the node computes
          concurrence in code, one independent verdict per source.
        </li>
        <li>
          Signs the response envelope echoing the <code>marketId</code>, or
          produces <strong>no update</strong> (<code>_fulfilled=false</code>)
          when the outcome isn&rsquo;t determinable yet — sources unavailable, no
          majority, event not concluded. The bid stays open and the node
          retries later.
        </li>
      </ol>
      <p>
        The node&rsquo;s settlement prompt is hardened against prompt injection: it
        never follows instructions embedded in a market question and returns
        strictly the expected shape{" "}
        <code>tuple(marketId, settled, direction)</code>.
      </p>

      <h3 id="callback">The callback</h3>
      <p>
        The hub delivers the verified update to the markets contract, whose{" "}
        <code>_updateOracle</code> decodes{" "}
        <code>(marketId, settled, direction)</code>, requires the market to be{" "}
        <code>SETTLING</code> with <code>settled == true</code>, records the
        outcome (<code>direction: true = YES</code>), and flips status to{" "}
        <code>SETTLED</code>, emitting <code>MarketSettled</code>. Winners can
        then <code>redeem</code> $1 per share.
      </p>

      <h2 id="offchain">Around the contracts</h2>
      <ul>
        <li>
          <strong>Relayer</strong> — batches EIP-712-signed orders into{" "}
          <code>placeOrdersBatch</code> and pays gas. It only ever submits to
          allowlisted platform contracts and whitelisted methods, and
          validates every EIP-3009 authorization pays the markets contract
          before relaying. Never arbitrary calldata.
        </li>
        <li>
          <strong>Indexer</strong> — subscribes to contract events (
          <code>OrderPlaced</code>, <code>OrderMatched</code>,{" "}
          <code>MarketSettled</code>, …), maintains the read models the API
          serves, and pushes WebSocket deltas.
        </li>
        <li>
          <strong>Settlement runner</strong> — collects the $0.05 settlement
          fee, calls <code>settleMarket</code>, and watches the hub to flip
          statuses and notify.
        </li>
      </ul>

      <Callout kind="info" title="Why PoA?">
        The canonical settlement path is Thassa&rsquo;s own node signing response
        blobs, verified onchain against an explicit signer set. It is a
        deliberate, transparent trust anchor: the signer set is public, every
        settlement query is public, and every source is publicly named — see{" "}
        <Link href="/docs/protocol/settlement">Settlement &amp; sources</Link>.
      </Callout>

      <Pager
        prev={{ href: "/docs/getting-started", label: "Getting started" }}
        next={{ href: "/docs/protocol/markets", label: "Markets & order book" }}
      />
    </>
  );
}
