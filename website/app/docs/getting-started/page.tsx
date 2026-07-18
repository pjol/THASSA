import type { Metadata } from "next";
import Link from "next/link";
import CodeBlock from "@/components/docs/CodeBlock";
import ClientTabs from "@/components/docs/ClientTabs";
import Callout from "@/components/docs/Callout";
import Pager from "@/components/docs/Pager";
import { API_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Getting started",
  description:
    "One Thassa account across app and API: create API keys, authenticate with X-Thassa-Key, and learn the response envelope, errors, pagination, and idempotency semantics.",
  openGraph: {
    title: "Getting started",
    description:
      "One Thassa account across app and API: create API keys, authenticate with X-Thassa-Key, and learn the response envelope, errors, pagination, and idempotency semantics.",
  },
};

const authedExample = [
  {
    label: "curl",
    code: `curl "${API_URL}/trade-api/v1/balance" \\
  -H "X-Thassa-Key: $THASSA_KEY"`,
  },
  {
    label: "TypeScript",
    title: "balance.ts",
    code: `const res = await fetch("${API_URL}/trade-api/v1/balance", {
  headers: { "X-Thassa-Key": process.env.THASSA_KEY! },
});
if (!res.ok) {
  const { error } = await res.json();
  throw new Error(error); // e.g. "invalid api key"
}
const { balance, wallet_address } = await res.json();`,
  },
  {
    label: "Python",
    title: "balance.py",
    code: `import os, requests

res = requests.get(
    "${API_URL}/trade-api/v1/balance",
    headers={"X-Thassa-Key": os.environ["THASSA_KEY"]},
)
res.raise_for_status()
data = res.json()
print(data["balance"], data["wallet_address"])`,
  },
];

const envelopeExample = `{
  "markets": [
    { "id": "42", "question": "…", "status": "OPEN", "yes_price_cents": 62 }
  ],
  "next_cursor": "eyJvZmZzZXQiOjUwfQ"
}`;

const errorExample = `{ "error": "invalid api key" }`;

const idempotencyExample = `curl -X POST "${API_URL}/trade-api/v1/orders" \\
  -H "X-Thassa-Key: $THASSA_KEY" \\
  -H "Idempotency-Key: 7d1f6f0a-3f2e-4a4e-9df1-2c9b3f6a1e42" \\
  -H "Content-Type: application/json" \\
  -d @order.json`;

export default function GettingStarted() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        Start here
      </p>
      <h1 className="mt-3">Getting started</h1>
      <p>
        Everything you need to make your first authenticated call: one
        account, one key, one header.
      </p>

      <h2 id="one-account">One account, app + API</h2>
      <p>
        Thassa has a <strong>single user base shared by the app and the
        API</strong>. There is no separate developer signup: your API keys
        act as <em>you</em>, same identity, same wallet, same positions, same
        balance. An order placed via the API shows up in your app profile, and
        vice versa.
      </p>
      <ul>
        <li>
          <strong>Sign up in the app.</strong> Accounts (and the embedded
          wallet that signs your orders) are created in the Thassa app, the
          API has no signup endpoint.
        </li>
        <li>
          <strong>Keys inherit your identity.</strong> Anything gated for your
          user in the app (visibility, limits) applies identically through a
          key.
        </li>
        <li>
          <strong>Orders are still yours to sign.</strong> The API is
          non-custodial: mutating calls carry payloads signed by your own
          wallet. A key alone can never move funds, see{" "}
          <Link href="/docs/protocol/gasless">Gasless orders</Link>.
        </li>
      </ul>

      <h2 id="api-keys">Create an API key</h2>
      <p>
        In the web app, open <strong>Settings → Developer</strong> and create a
        key. Pick a name and a scope:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Grants</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>read</code></td>
              <td>
                Authenticated reads: your orders, positions, fills, balance;
                WebSocket subscriptions.
              </td>
            </tr>
            <tr>
              <td><code>trade</code></td>
              <td>
                Everything in <code>read</code>, plus mutations: placing and
                canceling orders.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Callout kind="danger" title="The secret is shown once">
        The full key secret is displayed <strong>only at creation</strong>.
        Secrets are stored hashed (SHA-256); afterwards only a prefix is shown
        for identification. Lose it and you mint a new key.
      </Callout>
      <p>
        Keys can also be managed programmatically, see{" "}
        <Link href="/docs/api/keys">API keys endpoints</Link>.
      </p>

      <h2 id="auth">Authentication</h2>
      <p>
        Pass the key on every authenticated request in the{" "}
        <code>X-Thassa-Key</code> header:
      </p>
      <ClientTabs tabs={authedExample} />
      <p>
        The WebSocket accepts the same header on connect, or (in browsers, which
        can&rsquo;t set headers) the key via the{" "}
        <code>Sec-WebSocket-Protocol</code> header, see{" "}
        <Link href="/docs/api/websocket">WebSocket</Link>. Keys are never passed
        as query parameters.
      </p>

      <h2 id="access-routes">Two ways to trade</h2>
      <p>The trade API accepts two credentials, matching two ways of signing orders.</p>
      <ul>
        <li>
          <strong>Live session (OAuth style).</strong> Send your Privy access
          token as <code>Authorization: Bearer &lt;token&gt;</code>. This is
          the route for agents and MCP-style integrations that hold a real
          login. The session acts as you with full scope, and your client
          signs orders locally, exactly like the app does.
        </li>
        <li>
          <strong>API key with server-side signing.</strong> Turn on
          server-side signing in Settings, then submit orders with just{" "}
          <code>X-Thassa-Key</code> and no <code>auth</code> block. Thassa
          completes the order (nonce, expiry, max cost) and signs it through
          your delegated wallet. Without the opt-in, API keys can still trade
          by sending fully signed payloads.
        </li>
      </ul>

      <h2 id="environments">Environments & base URLs</h2>
      <p>
        All examples in these docs are rendered against the configured base
        URL, currently <code>{API_URL}</code>. The docs site reads it from{" "}
        <code>NEXT_PUBLIC_API_URL</code> at build time, so a deployment can
        point every snippet at its own environment.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Environment</th>
              <th>Base URL</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Development</td>
              <td><code>http://localhost:8080</code></td>
              <td>
                Local backend from the repo&rsquo;s single-command dev environment
                (Postgres, MinIO, Anvil chain fork).
              </td>
            </tr>
            <tr>
              <td>This deployment</td>
              <td><code>{API_URL}</code></td>
              <td>Baked into every example on this page.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Route prefixes, by audience:</p>
      <ul>
        <li>
          <code>/trade-api/v1/…</code>, the public trading API documented
          here (market data + authenticated trading).
        </li>
        <li>
          <code>/v1/developer/keys</code>, key management (app-session
          authenticated).
        </li>
        <li>
          <code>/v1/ws</code>, the WebSocket endpoint, which accepts API-key
          auth for market-data channels.
        </li>
      </ul>

      <h2 id="rate-limits">Rate limits</h2>
      <ul>
        <li>
          <strong>Public market-data endpoints</strong> are rate-limited{" "}
          <strong>by IP</strong>.
        </li>
        <li>
          <strong>Authenticated endpoints</strong> are rate-limited{" "}
          <strong>per key</strong>. Order placement additionally enforces
          per-user rate limits and a maximum order size at the relayer gate.
        </li>
      </ul>
      <p>
        Exceeding a limit returns <code>429</code> with the standard error
        envelope. Back off and retry; idempotency keys (below) make retries
        safe.
      </p>

      <h2 id="envelopes">Response envelope</h2>
      <p>
        Successful responses wrap data under a <strong>named key</strong>,
        never a bare array. List endpoints paginate with{" "}
        <code>?cursor=&amp;limit=</code> and return <code>next_cursor</code>{" "}
        (absent or <code>null</code> on the last page). Pass it back verbatim
        to fetch the next page.
      </p>
      <CodeBlock title="GET /trade-api/v1/markets, 200" code={envelopeExample} />

      <h2 id="errors">Error format</h2>
      <p>
        Every error, 4xx or 5xx, is a single lowercase message under{" "}
        <code>error</code>:
      </p>
      <CodeBlock title="401 Unauthorized" code={errorExample} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>400</code></td><td>Malformed request, bad ids, unknown fields, invalid payloads.</td></tr>
            <tr><td><code>401</code></td><td>Missing or invalid <code>X-Thassa-Key</code>.</td></tr>
            <tr><td><code>403</code></td><td>Key lacks the required scope (e.g. <code>read</code> key on a mutation), or the resource is gated.</td></tr>
            <tr><td><code>404</code></td><td>No such resource.</td></tr>
            <tr><td><code>409</code></td><td>Idempotency-key conflict (same key, different request).</td></tr>
            <tr><td><code>429</code></td><td>Rate limit exceeded.</td></tr>
            <tr><td><code>500</code></td><td>Server error, message shaped <code>&quot;failed to …&quot;</code>.</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="idempotency">Idempotency-Key</h2>
      <p>
        Every mutating endpoint accepts an <code>Idempotency-Key</code> header
       , a client-generated UUID. Semantics:
      </p>
      <ul>
        <li>
          <strong>First request</strong> executes normally; the response is
          stored against <code>(key, user)</code>.
        </li>
        <li>
          <strong>Replay</strong> (same key, byte-identical request) returns
          the stored response without re-executing, a double-submitted order
          never double-spends.
        </li>
        <li>
          <strong>Conflicting reuse</strong> (same key, different request
          hash) is rejected with <code>409</code>.
        </li>
      </ul>
      <CodeBlock title="idempotent order placement" code={idempotencyExample} />
      <Callout kind="info">
        Always send an <code>Idempotency-Key</code> on{" "}
        <code>POST /trade-api/v1/orders</code>. Networks fail mid-flight;
        with the key, retrying is always safe.
      </Callout>

      <h2 id="next">Where next</h2>
      <ul>
        <li>
          Understand what you&rsquo;re trading:{" "}
          <Link href="/docs/protocol/markets">Markets &amp; order book</Link>.
        </li>
        <li>
          Sign your first order:{" "}
          <Link href="/docs/protocol/gasless">Gasless orders</Link>.
        </li>
        <li>
          Call everything: <Link href="/docs/api/market-data">API reference</Link>.
        </li>
      </ul>

      <Pager
        prev={{ href: "/docs", label: "Overview" }}
        next={{ href: "/docs/protocol/architecture", label: "Architecture" }}
      />
    </>
  );
}
