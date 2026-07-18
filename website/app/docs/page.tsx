import type { Metadata } from "next";
import Link from "next/link";
import CodeBlock from "@/components/docs/CodeBlock";
import Pager from "@/components/docs/Pager";
import { API_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "Thassa developer documentation: protocol, gasless order flow, and the full trading API reference.",
  openGraph: {
    title: "Overview",
    description:
      "Thassa developer documentation: protocol, gasless order flow, and the full trading API reference.",
  },
};

const quickstart = `curl "${API_URL}/trade-api/v1/markets?status=OPEN&limit=3"`;

const CARDS = [
  {
    href: "/docs/getting-started",
    title: "Getting started",
    desc: "One account across app + API, minting keys, environments, envelopes, and idempotency.",
  },
  {
    href: "/docs/protocol/architecture",
    title: "Protocol",
    desc: "How markets settle: hub → PoA verifier → node → callback, the order book, fees, and gasless signing.",
  },
  {
    href: "/docs/api/market-data",
    title: "API reference",
    desc: "Every REST endpoint with curl, TypeScript, and Python examples, plus the WebSocket protocol.",
  },
];

export default function DocsHome() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Thassa Developer Docs
      </p>
      <h1 className="mt-3">Build on the social prediction platform</h1>
      <p>
        Thassa pairs a social feed with cent-priced binary prediction markets.
        Everything the app can do with markets, your code can do too — the app
        and the API share <strong>one user base, one order book, and one
        non-custodial signing model</strong>. These docs cover the protocol
        (contracts, settlement, fees) and the full trading API.
      </p>

      <h2 id="quickstart">30-second quickstart</h2>
      <p>
        Market data requires no auth. List live markets against the{" "}
        {API_URL.includes("localhost") ? "dev" : "configured"} backend (
        <code>{API_URL}</code>):
      </p>
      <CodeBlock title="terminal" code={quickstart} />
      <p>
        Trading requires an API key minted in the app —{" "}
        <Link href="/docs/getting-started">start here</Link>.
      </p>

      <h2 id="sections">Sections</h2>
      <div className="not-prose mt-5 grid gap-4 sm:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-2xl border hairline bg-card p-5 transition hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-card"
          >
            <p className="text-[15.5px] font-semibold transition group-hover:text-brand">
              {c.title}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{c.desc}</p>
          </Link>
        ))}
      </div>

      <h2 id="principles">Three things to know</h2>
      <ul>
        <li>
          <strong>Non-custodial by construction.</strong> Orders are EIP-712
          typed data funded by an EIP-3009 payment authorization; the
          authorization&rsquo;s nonce <em>is</em> the order digest, so one signature
          commits to both. Thassa relays and pays gas — it never holds keys or
          funds.
        </li>
        <li>
          <strong>A small, fixed set of states.</strong> Markets are{" "}
          <code>PENDING</code> · <code>OPEN</code> · <code>MATCHED</code> ·{" "}
          <code>SETTLING</code> · <code>SETTLED</code> · <code>VOID</code>;
          orders are <code>SIGNING</code> · <code>QUEUED</code> ·{" "}
          <code>RESTING</code> · <code>PARTIAL</code> · <code>FILLED</code> ·{" "}
          <code>CANCELED</code>. The API returns these strings verbatim.
        </li>
        <li>
          <strong>Settlement is public.</strong> Every market stores a
          structured settlement query onchain naming the exact sources that
          decide it — numeric data settles on one publicly named source,
          boolean news on a majority of a five-source panel.
        </li>
      </ul>

      <Pager next={{ href: "/docs/getting-started", label: "Getting started" }} />
    </>
  );
}
