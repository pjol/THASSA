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
  title: "API keys",
  description:
    "Manage Thassa API keys: create (secret shown once), list, and revoke keys with read or trade scope.",
  openGraph: {
    title: "API keys",
    description:
      "Manage Thassa API keys: create (secret shown once), list, and revoke keys with read or trade scope.",
  },
};

const B = API_URL;

const createRes = `{
  "key": {
    "id": "9c2e5a10-7f4b-4f9e-a2d1-0b1e8c3d4f55",
    "name": "trading-bot",
    "scope": "trade",
    "prefix": "tk_live_9c2e",
    "secret": "tk_live_9c2e5a107f4b4f9ea2d10b1e8c3d4f55…",  // shown ONCE
    "created_at": "2026-07-16T08:00:00Z"
  }
}`;

const listRes = `{
  "keys": [
    {
      "id": "9c2e5a10-7f4b-4f9e-a2d1-0b1e8c3d4f55",
      "name": "trading-bot",
      "scope": "trade",
      "prefix": "tk_live_9c2e",
      "created_at": "2026-07-16T08:00:00Z"
    },
    {
      "id": "1b8d3c22-05aa-4e01-9c77-d2f4a6b8e901",
      "name": "dashboard-reader",
      "scope": "read",
      "prefix": "tk_live_1b8d",
      "created_at": "2026-07-01T12:30:00Z"
    }
  ]
}`;

const createTabs = [
  {
    label: "curl",
    code: `curl -X POST "${B}/v1/developer/keys" \\
  -H "Authorization: Bearer $APP_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "trading-bot", "scope": "trade" }'`,
  },
  {
    label: "TypeScript",
    code: `const res = await fetch("${B}/v1/developer/keys", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${appAccessToken}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "trading-bot", scope: "trade" }),
});
const { key } = await res.json();
console.log(key.secret); // shown once, store it now`,
  },
  {
    label: "Python",
    code: `import requests

res = requests.post(
    "${B}/v1/developer/keys",
    headers={"Authorization": f"Bearer {app_access_token}"},
    json={"name": "trading-bot", "scope": "trade"},
)
res.raise_for_status()
key = res.json()["key"]
print(key["secret"])  # shown once, store it now`,
  },
];

const listTabs = [
  {
    label: "curl",
    code: `curl "${B}/v1/developer/keys" \\
  -H "Authorization: Bearer $APP_ACCESS_TOKEN"`,
  },
  {
    label: "TypeScript",
    code: `const res = await fetch("${B}/v1/developer/keys", {
  headers: { Authorization: \`Bearer \${appAccessToken}\` },
});
const { keys } = await res.json();`,
  },
  {
    label: "Python",
    code: `import requests

res = requests.get(
    "${B}/v1/developer/keys",
    headers={"Authorization": f"Bearer {app_access_token}"},
)
res.raise_for_status()
keys = res.json()["keys"]`,
  },
];

const deleteTabs = [
  {
    label: "curl",
    code: `curl -X DELETE "${B}/v1/developer/keys/9c2e5a10-7f4b-4f9e-a2d1-0b1e8c3d4f55" \\
  -H "Authorization: Bearer $APP_ACCESS_TOKEN"`,
  },
  {
    label: "TypeScript",
    code: `await fetch(
  "${B}/v1/developer/keys/9c2e5a10-7f4b-4f9e-a2d1-0b1e8c3d4f55",
  {
    method: "DELETE",
    headers: { Authorization: \`Bearer \${appAccessToken}\` },
  }
);`,
  },
  {
    label: "Python",
    code: `import requests

requests.delete(
    "${B}/v1/developer/keys/9c2e5a10-7f4b-4f9e-a2d1-0b1e8c3d4f55",
    headers={"Authorization": f"Bearer {app_access_token}"},
).raise_for_status()`,
  },
];

export default function Keys() {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
        API reference
      </p>
      <h1 className="mt-3">API keys</h1>
      <p>
        Keys are managed by <strong>authenticated app users</strong>, the
        easiest path is the web app (<strong>Settings → Developer</strong>),
        which drives exactly these endpoints. They live under{" "}
        <code>/v1/developer/keys</code> and authenticate with your{" "}
        <em>app session</em> (Bearer access token), not with an API key, a
        key cannot mint or revoke keys.
      </p>
      <ul>
        <li>
          Keys <strong>inherit your identity</strong>: the key&rsquo;s user is the
          identifier for every gating rule, exactly as if you were in the
          app.
        </li>
        <li>
          Scopes: <code>read</code> (authenticated reads + WS) or{" "}
          <code>trade</code> (reads + order placement/cancel). See{" "}
          <Link href="/docs/getting-started#api-keys">Getting started</Link>.
        </li>
        <li>
          Secrets are stored <strong>hashed (SHA-256)</strong>; after
          creation only the <code>prefix</code> identifies a key.
        </li>
      </ul>

      <h2 id="create">Create a key</h2>
      <Endpoint method="POST" path="/v1/developer/keys" auth="app session" />
      <ParamTable
        title="Body field"
        params={[
          { name: "name", type: "string", required: true, desc: "Human label, e.g. \"trading-bot\"." },
          { name: "scope", type: "string", required: true, desc: "\"read\" or \"trade\"." },
        ]}
      />
      <ClientTabs tabs={createTabs} />
      <CodeBlock title="201 response" code={createRes} />
      <Callout kind="danger" title="Secret shown once">
        <code>secret</code> appears only in this response, it is never
        retrievable again. Store it in a secret manager immediately.
      </Callout>

      <h2 id="list">List keys</h2>
      <Endpoint method="GET" path="/v1/developer/keys" auth="app session" />
      <p>Returns metadata and prefixes, never secrets.</p>
      <ClientTabs tabs={listTabs} />
      <CodeBlock title="200 response" code={listRes} />

      <h2 id="revoke">Revoke a key</h2>
      <Endpoint method="DELETE" path="/v1/developer/keys/{id}" auth="app session" />
      <p>
        Revocation is immediate: in-flight and subsequent requests with the
        key fail with <code>401</code>. Revoke and re-mint on any suspicion
        of exposure.
      </p>
      <ClientTabs tabs={deleteTabs} />

      <Pager
        prev={{ href: "/docs/api/trading", label: "Trading (authenticated)" }}
        next={{ href: "/docs/api/websocket", label: "WebSocket" }}
      />
    </>
  );
}
