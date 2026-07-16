import type { Metadata } from "next";
import Link from "next/link";
import Callout from "@/components/docs/Callout";
import CodeBlock from "@/components/docs/CodeBlock";
import Pager from "@/components/docs/Pager";

export const metadata: Metadata = {
  title: "Settlement & authoritative sources",
  description:
    "Thassa markets settle against publicly named authoritative sources: single-source rules for numeric data (ESPN, NWS, Coinbase) and majority concurrence across NYT/WSJ/Reuters/AP/BBC for boolean news.",
  openGraph: {
    title: "Settlement & authoritative sources",
    description:
      "Thassa markets settle against publicly named authoritative sources: single-source rules for numeric data (ESPN, NWS, Coinbase) and majority concurrence across NYT/WSJ/Reuters/AP/BBC for boolean news.",
  },
};

const queryExample = `{
  "question": "Will it rain in San Francisco on 2026-07-18?",
  "category": "weather",
  "rule": "single",
  "sources": [
    {
      "id": "nws",
      "name": "NWS/NOAA",
      "url": "https://api.weather.gov"
    }
  ]
}`;

const majorityExample = `{
  "question": "Did the bill pass the Senate before 2026-07-01?",
  "category": "news",
  "rule": "majority",
  "sources": [
    { "id": "nyt",     "name": "The New York Times",  "url": "https://www.nytimes.com" },
    { "id": "wsj",     "name": "The Wall Street Journal", "url": "https://www.wsj.com" },
    { "id": "reuters", "name": "Reuters",             "url": "https://www.reuters.com" },
    { "id": "ap",      "name": "Associated Press",    "url": "https://apnews.com" },
    { "id": "bbc",     "name": "BBC",                 "url": "https://www.bbc.com" }
  ]
}`;

export default function Settlement() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Protocol
      </p>
      <h1 className="mt-3">Settlement &amp; authoritative sources</h1>
      <p>
        Thassa markets never settle on open-ended LLM web search. Every market
        resolves against <strong>known authoritative sources, bound at
        creation and disclosed publicly</strong> — stored onchain, rendered in
        the app, and served by the API.
      </p>

      <h2 id="structured-queries">Structured settlement queries</h2>
      <p>
        A settlement query is structured JSON stored onchain as a public
        string: the question, its category, the resolution rule, and the
        exact sources that decide it.
      </p>
      <CodeBlock title="single-source settlement query" code={queryExample} />
      <p>
        Anyone can inspect the query that will settle a market — in the app&rsquo;s
        market detail (&ldquo;Advanced&rdquo;), or via{" "}
        <code>GET /trade-api/v1/markets/{"{id}"}/sources</code>.
      </p>

      <h2 id="rule-of-thumb">The rule of thumb</h2>
      <Callout kind="info" title="Encoded in the registry">
        <strong>Numeric data ⇒ exactly one publicly-disclosed source.
        Boolean data ⇒ multi-source majority concurrence.</strong>
      </Callout>
      <p>
        Scores, temperatures, and prices are facts one authority publishes —
        naming a single source publicly is both sufficient and unambiguous.
        &ldquo;Did X happen&rdquo; questions are interpretations, so no single outlet
        decides them: a panel must concur.
      </p>

      <h2 id="categories">Source categories</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Rule</th>
              <th>Sources</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>sports</code></td>
              <td><code>single</code></td>
              <td>ESPN — the single primary source for results.</td>
            </tr>
            <tr>
              <td><code>news</code></td>
              <td><code>majority</code></td>
              <td>
                Boolean &ldquo;did X happen&rdquo; questions. Panel of NYT, WSJ,
                Reuters, AP, BBC (configurable list); a{" "}
                <strong>majority must concur</strong> or no update is
                produced.
              </td>
            </tr>
            <tr>
              <td><code>weather</code></td>
              <td><code>single</code></td>
              <td>
                Numeric. Exactly one allowed authoritative source — default
                NWS/NOAA (<code>api.weather.gov</code>).
              </td>
            </tr>
            <tr>
              <td><code>price</code></td>
              <td><code>single</code></td>
              <td>
                Asset pricing, numeric. Exactly one allowed source per asset
                class — default Coinbase spot for crypto, configurable per
                deployment.
              </td>
            </tr>
            <tr>
              <td><code>general</code></td>
              <td>—</td>
              <td>
                Fallback for uncategorized questions: LLM adjudication,
                clearly labeled as such.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="majority">The majority-concurrence rule</h2>
      <CodeBlock title="majority settlement query" code={majorityExample} />
      <p>For <code>majority</code>-rule markets, during fulfillment the node:</p>
      <ol>
        <li>Fetches each panel source independently (news RSS/APIs) — in the node process, prior to any LLM call.</li>
        <li>
          Derives <strong>one independent verdict per source</strong>,
          adjudicating only from that source&rsquo;s fetched evidence.
        </li>
        <li>
          <strong>Computes concurrence in code</strong>: a majority of the
          panel must agree. 3 of 5 settles; 2–2 with one unavailable does not.
        </li>
        <li>
          If there is no majority — or a source is unavailable — the node
          produces <strong>no update</strong> (<code>_fulfilled=false</code>)
          and retries later. The market stays <code>SETTLING</code>.
        </li>
      </ol>
      <p>
        For <code>single</code>-rule markets, the one bound source decides;
        unavailability likewise means no update and a retry.
      </p>

      <h2 id="binding">How sources get bound</h2>
      <p>
        The backend hosts the source registry and exposes it over MCP to both
        the market-generation agent and the oracle nodes (
        <code>list_sources</code>, <code>resolve_sources</code>). When a
        market is generated, the agent categorizes the question and binds its
        sources <em>at generation time</em>; candidates without a resolvable
        category fall back to <code>general</code>. The registry itself is
        publicly readable.
      </p>

      <h2 id="guardrails">Prompt-injection guardrails</h2>
      <ul>
        <li>
          The oracle&rsquo;s query template instructs the node to answer only the
          market question passed via bid <code>inputData</code>, returning
          strictly the expected shape and{" "}
          <strong>refusing instructions embedded in the question</strong>.
        </li>
        <li>
          The LLM adjudicates only from evidence the node fetched — it has no
          browsing or tools at settlement time.
        </li>
        <li>
          Market generation sanitizes user input, wraps it in delimited data
          blocks, schema-validates output, and requires settlement queries to
          be objective, verifiable statements with a resolution source and
          date.
        </li>
      </ul>

      <h2 id="void">When settlement can&rsquo;t happen</h2>
      <p>
        A market that can never resolve cleanly can be voided by the owner
        (<code>voidMarket</code>) — status <code>VOID</code>, all deposits
        refundable. Until then, an unresolvable query simply keeps producing
        no update: funds stay escrowed and safe, never settled on a bad
        answer.
      </p>

      <Pager
        prev={{ href: "/docs/protocol/markets", label: "Markets & order book" }}
        next={{ href: "/docs/protocol/gasless", label: "Gasless orders" }}
      />
    </>
  );
}
