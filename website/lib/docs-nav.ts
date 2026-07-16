export type NavItem = { href: string; label: string };
export type NavGroup = { title: string; items: NavItem[] };

export const DOCS_NAV: NavGroup[] = [
  {
    title: "Start here",
    items: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/getting-started", label: "Getting started" },
    ],
  },
  {
    title: "Protocol",
    items: [
      { href: "/docs/protocol/architecture", label: "Architecture" },
      { href: "/docs/protocol/markets", label: "Markets & order book" },
      { href: "/docs/protocol/settlement", label: "Settlement & sources" },
      { href: "/docs/protocol/gasless", label: "Gasless orders" },
      { href: "/docs/protocol/onchain", label: "Direct onchain" },
    ],
  },
  {
    title: "API reference",
    items: [
      { href: "/docs/api/market-data", label: "Market data (public)" },
      { href: "/docs/api/trading", label: "Trading (authenticated)" },
      { href: "/docs/api/keys", label: "API keys" },
      { href: "/docs/api/websocket", label: "WebSocket" },
    ],
  },
];
