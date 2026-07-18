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
  title: "Market data API",
  description:
    "Public, no-auth market data: list and search markets, fetch a market, its order book price levels, trade history, and resolution sources.",
  openGraph: {
    title: "Market data API",
    description:
      "Public, no-auth market data: list and search markets, fetch a market, its order book price levels, trade history, and resolution sources.",
  },
};

const B = API_URL;

const tsGet = (path: string, key: string) => `const res = await fetch(
  "${B}${path}"
);
const { ${key} } = await res.json();`;

const pyGet = (path: string, key: string) => `import requests

res = requests.get("${B}${path}")
res.raise_for_status()
${key} = res.json()["${key}"]`;

const listMarketsRes = `{
  "markets": [
    {
      "id": "42",
      "question": "Will it rain in San Francisco on Saturday?",
      "status": "OPEN",
      "yes_price_cents": 12,
      "no_price_cents": 88,
      "volume": "2730000000",
      "creator": "0x1b7e…c2d4",
      "created_at": "2026-07-12T18:03:11Z"
    },
    {
      "id": "41",
      "question": "Will the Warriors win game 7 tonight?",
      "status": "MATCHED",
      "yes_price_cents": 44,
      "no_price_cents": 56,
      "volume": "18904000000",
      "creator": "0x9f21…88aa",
      "created_at": "2026-07-11T02:44:09Z"
    }
  ],
  "next_cursor": "eyJvZmZzZXQiOjJ9"
}`;

const getMarketRes = `{
  "market": {
    "id": "42",
    "question": "Will it rain in San Francisco on Saturday?",
    "status": "SETTLED",
    "direction": false,
    "yes_price_cents": 12,
    "no_price_cents": 88,
    "volume": "2730000000",
    "creator": "0x1b7e…c2d4",
    "settlement_query": {
      "question": "Will it rain in San Francisco on 2026-07-18?",
      "category": "weather",
      "rule": "single",
      "sources": [
        { "id": "nws", "name": "NWS/NOAA", "url": "https://api.weather.gov" }
      ]
    },
    "created_at": "2026-07-12T18:03:11Z"
  }
}`;

const bookRes = `{
  "book": {
    "market_id": "42",
    "yes": [
      { "price_cents": 62, "shares": "1250" },
      { "price_cents": 61, "shares": "780" },
      { "price_cents": 60, "shares": "320" }
    ],
    "no": [
      { "price_cents": 37, "shares": "1100" },
      { "price_cents": 36, "shares": "640" }
    ]
  }
}`;

const tradesRes = `{
  "trades": [
    {
      "id": "f7a2…",
      "market_id": "42",
      "price_cents": 62,
      "shares": "300",
      "side": "yes",
      "fee": "1649200",
      "tx_hash": "0x8c31…e9d0",
      "created_at": "2026-07-15T21:09:44Z"
    }
  ],
  "next_cursor": null
}`;

const sourcesRes = `{
  "sources": [
    { "id": "nws", "name": "NWS/NOAA", "url": "https://api.weather.gov" }
  ],
  "category": "weather",
  "rule": "single"
}`;

export default function MarketData() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        API reference
      </p>
      <h1 className="mt-3">Market data (public)</h1>
      <p>
        Five read-only endpoints, <strong>no auth required</strong>,
        rate-limited by IP. Money fields are strings in payment-token base
        units (6 decimals in the examples); prices are integer cents; states
        use the values documented in{" "}
        <Link href="/docs/protocol/markets">Markets &amp; order book</Link>.
      </p>

      <h2 id="list-markets">List &amp; search markets</h2>
      <Endpoint method="GET" path="/trade-api/v1/markets" auth="no auth" />
      <p>
        Lists markets with status, prices, and volume. Supports search and
        cursor pagination.
      </p>
      <ParamTable
        title="Query parameter"
        params={[
          { name: "q", type: "string", desc: "Free-text search over market questions." },
          { name: "status", type: "string", desc: "Filter by state: PENDING, OPEN, MATCHED, SETTLING, SETTLED, or VOID." },
          { name: "cursor", type: "string", desc: "Opaque cursor from a previous page's next_cursor." },
          { name: "limit", type: "int", desc: "Page size (server-capped)." },
        ]}
      />
      <ClientTabs
        tabs={[
          {
            label: "curl",
            code: `curl "${B}/trade-api/v1/markets?status=OPEN&limit=2"`,
          },
          { label: "TypeScript", code: tsGet("/trade-api/v1/markets?status=OPEN&limit=2", "markets") },
          { label: "Python", code: pyGet("/trade-api/v1/markets?status=OPEN&limit=2", "markets") },
        ]}
      />
      <CodeBlock title="200 response" code={listMarketsRes} />

      <h2 id="get-market">Get a market</h2>
      <Endpoint method="GET" path="/trade-api/v1/markets/{id}" auth="no auth" />
      <p>
        Full detail for one market, including the public structured
        settlement query. <code>direction</code> is present once{" "}
        <code>SETTLED</code> (<code>true</code> = YES).
      </p>
      <ClientTabs
        tabs={[
          { label: "curl", code: `curl "${B}/trade-api/v1/markets/42"` },
          { label: "TypeScript", code: tsGet("/trade-api/v1/markets/42", "market") },
          { label: "Python", code: pyGet("/trade-api/v1/markets/42", "market") },
        ]}
      />
      <CodeBlock title="200 response" code={getMarketRes} />

      <h2 id="get-book">Get the order book</h2>
      <Endpoint method="GET" path="/trade-api/v1/markets/{id}/book" auth="no auth" />
      <p>
        Aggregated resting liquidity by price level, best-priced first, both
        sides. For live deltas, subscribe to{" "}
        <code>book:{"{marketId}"}</code> over the{" "}
        <Link href="/docs/api/websocket">WebSocket</Link>.
      </p>
      <ClientTabs
        tabs={[
          { label: "curl", code: `curl "${B}/trade-api/v1/markets/42/book"` },
          { label: "TypeScript", code: tsGet("/trade-api/v1/markets/42/book", "book") },
          { label: "Python", code: pyGet("/trade-api/v1/markets/42/book", "book") },
        ]}
      />
      <CodeBlock title="200 response" code={bookRes} />
      <Callout kind="info">
        A YES level at 62¢ crosses a NO level at 38¢ or better —{" "}
        <code>p + q ≥ 100</code>. The spread here is 62 + 37 = 99: one cent
        apart.
      </Callout>

      <h2 id="get-trades">Get trades</h2>
      <Endpoint method="GET" path="/trade-api/v1/markets/{id}/trades" auth="no auth" />
      <p>
        Fill history for a market, newest first, cursor-paginated.{" "}
        <code>side</code> is the taker&rsquo;s side; <code>fee</code> is the taker
        fee in token base units.
      </p>
      <ParamTable
        title="Query parameter"
        params={[
          { name: "cursor", type: "string", desc: "Opaque pagination cursor." },
          { name: "limit", type: "int", desc: "Page size (server-capped)." },
        ]}
      />
      <ClientTabs
        tabs={[
          { label: "curl", code: `curl "${B}/trade-api/v1/markets/42/trades?limit=1"` },
          { label: "TypeScript", code: tsGet("/trade-api/v1/markets/42/trades?limit=1", "trades") },
          { label: "Python", code: pyGet("/trade-api/v1/markets/42/trades?limit=1", "trades") },
        ]}
      />
      <CodeBlock title="200 response" code={tradesRes} />

      <h2 id="get-sources">Get resolution sources</h2>
      <Endpoint method="GET" path="/trade-api/v1/markets/{id}/sources" auth="no auth" />
      <p>
        Resolution transparency: the parsed authoritative sources bound to
        this market, with the category and rule that governs them — see{" "}
        <Link href="/docs/protocol/settlement">Settlement &amp; sources</Link>.
      </p>
      <ClientTabs
        tabs={[
          { label: "curl", code: `curl "${B}/trade-api/v1/markets/42/sources"` },
          { label: "TypeScript", code: tsGet("/trade-api/v1/markets/42/sources", "sources") },
          { label: "Python", code: pyGet("/trade-api/v1/markets/42/sources", "sources") },
        ]}
      />
      <CodeBlock title="200 response" code={sourcesRes} />

      <Pager
        prev={{ href: "/docs/protocol/onchain", label: "Direct onchain" }}
        next={{ href: "/docs/api/trading", label: "Trading (authenticated)" }}
      />
    </>
  );
}
