import Link from "next/link";
import { APP_URL } from "@/lib/config";

const PRODUCT: [string, string][] = [
  [APP_URL, "Web app"],
  ["/download", "Download"],
  ["/docs", "Developer docs"],
];
const DEVELOPERS: [string, string][] = [
  ["/docs/getting-started", "Getting started"],
  ["/docs/api/market-data", "API reference"],
  ["/docs/protocol/architecture", "Protocol"],
];
const SOCIALS: [string, string][] = [
  ["#", "X / Twitter"],
  ["#", "Discord"],
  ["#", "GitHub"],
];
const LEGAL: [string, string][] = [
  ["#", "Terms of Service"],
  ["#", "Privacy Policy"],
  ["#", "Market Rules"],
];

function Column({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-faint">
        {title}
      </p>
      <ul className="mt-4 space-y-2.5">
        {links.map(([href, label]) => (
          <li key={label}>
            {href.startsWith("/") ? (
              <Link href={href} className="text-[13.5px] text-muted transition hover:text-brand">
                {label}
              </Link>
            ) : (
              <a href={href} className="text-[13.5px] text-muted transition hover:text-brand">
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Footer({ snap = false }: { snap?: boolean }) {
  return (
    <footer className={`border-t hairline bg-card ${snap ? "snap-end" : ""}`}>
      <div className="container-page grid gap-12 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/thassa-logo.svg" alt="" className="h-7 w-7" />
            <span className="text-[20px] font-bold tracking-tight">
              Thassa<span className="text-brand">.</span>
            </span>
          </div>
          <p className="mt-4 max-w-[32ch] text-[13.5px] leading-relaxed text-muted">
            Social. Markets. Settled. A feed where every post can carry a
            market — and every market settles in the open.
          </p>
          <p className="mt-6 font-mono text-[10.5px] uppercase tracking-[0.16em] text-faint">
            © {new Date().getFullYear()} Thassa
          </p>
        </div>
        <Column title="Product" links={PRODUCT} />
        <Column title="Developers" links={DEVELOPERS} />
        <Column title="Community" links={SOCIALS} />
        <Column title="Legal" links={LEGAL} />
      </div>
    </footer>
  );
}
