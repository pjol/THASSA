import type { Metadata } from "next";
import Link from "next/link";
import ClientTabs from "@/components/docs/ClientTabs";
import CodeBlock from "@/components/docs/CodeBlock";
import Endpoint from "@/components/docs/Endpoint";
import Callout from "@/components/docs/Callout";
import Pager from "@/components/docs/Pager";
import { WS_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "WebSocket",
  description:
    "Stream Thassa order-book deltas and trades in real time: connect to /v1/ws with X-Thassa-Key, subscribe to book:{marketId} channels.",
  openGraph: {
    title: "WebSocket",
    description:
      "Stream Thassa order-book deltas and trades in real time: connect to /v1/ws with X-Thassa-Key, subscribe to book:{marketId} channels.",
  },
};

const W = WS_URL;

const frameShape = `{ "type": "…", "channel": "…", "payload": { … } }`;

const subscribeFrames = `// client → server
{ "type": "subscribe",   "channel": "book:42" }
{ "type": "unsubscribe", "channel": "book:42" }`;

const deltaEvent = `// server → client: a price level changed (shares = new total at the level;
// "0" removes the level)
{
  "type": "book.delta",
  "channel": "book:42",
  "payload": {
    "market_id": "42",
    "side": "yes",
    "price_cents": 62,
    "shares": "1150"
  }
}`;

const tradeEvent = `// server → client: a fill occurred
{
  "type": "book.trade",
  "channel": "book:42",
  "payload": {
    "market_id": "42",
    "side": "yes",
    "price_cents": 62,
    "shares": "300",
    "fee": "1649200",
    "tx_hash": "0x8c31…e9d0",
    "created_at": "2026-07-15T21:09:44Z"
  }
}`;

const connectTabs = [
  {
    label: "TypeScript",
    title: "Node (ws) — header auth",
    code: `import WebSocket from "ws";

const ws = new WebSocket("${W}/v1/ws", {
  headers: { "X-Thassa-Key": process.env.THASSA_KEY! },
});

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", channel: "book:42" }));
});

ws.on("message", (raw) => {
  const { type, channel, payload } = JSON.parse(raw.toString());
  if (type === "book.delta") applyDelta(payload);
  if (type === "book.trade") recordTrade(payload);
});`,
  },
  {
    label: "Browser",
    title: "browser — subprotocol auth",
    code: `// Browsers can't set WebSocket headers, but they CAN send the
// Sec-WebSocket-Protocol header via subprotocols. Pass a sentinel
// then your key — never a query param (which would leak into logs).
const ws = new WebSocket("${W}/v1/ws", ["thassa-key", THASSA_KEY]);

ws.onopen = () =>
  ws.send(JSON.stringify({ type: "subscribe", channel: "book:42" }));

ws.onmessage = (ev) => {
  const { type, payload } = JSON.parse(ev.data);
  if (type === "book.delta") applyDelta(payload);
  if (type === "book.trade") recordTrade(payload);
};`,
  },
  {
    label: "Python",
    title: "python (websockets)",
    code: `import asyncio, json, os, websockets

async def main():
    async with websockets.connect(
        "${W}/v1/ws",
        extra_headers={"X-Thassa-Key": os.environ["THASSA_KEY"]},
    ) as ws:
        await ws.send(json.dumps({"type": "subscribe", "channel": "book:42"}))
        async for raw in ws:
            frame = json.loads(raw)
            if frame["type"] == "book.delta":
                apply_delta(frame["payload"])
            elif frame["type"] == "book.trade":
                record_trade(frame["payload"])

asyncio.run(main())`,
  },
];

export default function WebSocketDocs() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        API reference
      </p>
      <h1 className="mt-3">WebSocket</h1>
      <p>
        One connection, JSON frames, channel subscriptions. The socket powers
        the app&rsquo;s live order books; API keys get the same feed.
      </p>

      <h2 id="connect">Connect</h2>
      <Endpoint method="WS" path="/v1/ws" auth="X-Thassa-Key (or Sec-WebSocket-Protocol)" />
      <p>
        Authenticate on connect with the <code>X-Thassa-Key</code> header. In
        browsers, which can&rsquo;t set WebSocket headers, send the key via the{" "}
        <code>Sec-WebSocket-Protocol</code> header instead — offer the sentinel{" "}
        <code>thassa-key</code> then your key as subprotocols (
        <code>new WebSocket(url, [&quot;thassa-key&quot;, KEY])</code>). Keys are
        never accepted as query parameters. Either scope (<code>read</code> or{" "}
        <code>trade</code>) may subscribe to market-data channels.
      </p>
      <ClientTabs tabs={connectTabs} />

      <h2 id="frames">Frame shape</h2>
      <p>Every frame — both directions — is:</p>
      <CodeBlock title="frame" code={frameShape} />

      <h2 id="subscribe">Subscribing</h2>
      <p>
        API keys subscribe to <strong>order-book channels</strong>:{" "}
        <code>book:{"{marketId}"}</code> — order-book deltas plus trades for
        one market. Subscribe to as many markets as you need on a single
        connection.
      </p>
      <CodeBlock title="subscribe / unsubscribe" code={subscribeFrames} />
      <Callout kind="info" title="Channel authorization">
        Subscriptions are authorized server-side per channel. App-session
        connections additionally use <code>dm:{"{conversationId}"}</code> and{" "}
        <code>user:{"{me}"}</code> channels; API keys are for{" "}
        <code>book:*</code> market data.
      </Callout>

      <h2 id="events">Events</h2>
      <h3 id="deltas">Book deltas</h3>
      <CodeBlock title="book.delta" code={deltaEvent} />
      <h3 id="trades">Trades</h3>
      <CodeBlock title="book.trade" code={tradeEvent} />
      <p>
        The recommended pattern: fetch the snapshot from{" "}
        <Link href="/docs/api/market-data#get-book">
          <code>GET /trade-api/v1/markets/{"{id}"}/book</code>
        </Link>{" "}
        after subscribing, then apply deltas — replacing each level&rsquo;s total
        with <code>payload.shares</code>. Deltas are totals, not increments,
        so a missed frame self-heals on the next delta for that level.
      </p>

      <h2 id="lifecycle">Connection lifecycle</h2>
      <ul>
        <li>
          The server pings periodically; unresponsive connections are dropped.
          Reply with standard pongs (every client library does this
          automatically).
        </li>
        <li>
          On reconnect, re-subscribe and re-fetch snapshots — subscriptions
          don&rsquo;t survive the connection.
        </li>
        <li>
          Delivery is best-effort; the REST book endpoint is always the
          recoverable source of truth.
        </li>
      </ul>

      <Pager
        prev={{ href: "/docs/api/keys", label: "API keys" }}
      />
    </>
  );
}
