import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ScrollFX from "@/components/ScrollFX";
import SnapRoot from "@/components/SnapRoot";
import StateChip from "@/components/StateChip";
import { MarketCardMock, OrderBookMock, PostCardMock } from "@/components/mocks";
import { APP_URL } from "@/lib/config";

const Arrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] transition-transform group-hover:translate-x-0.5" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

function Kicker({ index, label, className = "" }: { index: string; label: string; className?: string }) {
  return (
    <p className={`inline-flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-brand ${className}`}>
      <span className="h-px w-8 bg-gradient-to-r from-brand to-brand-soft" />
      <span className="text-faint">{index} /</span> {label}
    </p>
  );
}

function SourcePill({ name, verdict }: { name: string; verdict: "YES" | "NO" }) {
  const yes = verdict === "YES";
  return (
    <div className="flex items-center justify-between rounded-xl border hairline bg-bg text-fg px-3.5 py-2.5">
      <span className="text-[13px] font-semibold">{name}</span>
      <span className={`rounded-full px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] ${yes ? "bg-yes/10 text-yes" : "bg-no/10 text-no"}`}>
        {verdict}
      </span>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <SnapRoot />
      <ScrollFX />
      <Navbar />

      <main>
        {/* ─────────── 00 · Hero ─────────── */}
        <section className="snap-section hero-grid-bg">
          <div className="anim-aurora pointer-events-none absolute -inset-x-[20%] -top-[30%] h-[140%] [background:radial-gradient(30%_26%_at_72%_38%,rgba(48,124,222,0.22),transparent_70%),radial-gradient(26%_22%_at_28%_16%,rgba(48,124,222,0.14),transparent_70%)]" />
          <div className="container-page relative grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
            <div>
              <p className="anim-rise inline-flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
                <span className="pulse-dot" aria-hidden="true" />
                The social prediction platform
              </p>
              <h1 className="anim-rise-1 mt-6 max-w-[620px] text-[clamp(46px,7vw,88px)] font-extrabold leading-[0.98] tracking-[-0.04em]">
                Social. Markets.{" "}
                <span className="text-gradient-brand">Settled.</span>
              </h1>
              <p className="anim-rise-2 mt-6 max-w-[500px] text-[17px] leading-relaxed text-muted">
                Post your predictions.
              </p>
              <div className="anim-rise-3 mt-9 flex flex-wrap gap-3.5">
                <a href={APP_URL} className="group inline-flex items-center gap-2.5 rounded-xl bg-brand px-7 py-3.5 text-[15px] font-semibold text-white shadow-[0_14px_34px_-12px_rgba(48,124,222,0.7)] transition hover:-translate-y-0.5 hover:bg-brand-deep">
                  Open the app <Arrow />
                </a>
                {/* <Link href="/download" className="group inline-flex items-center gap-2.5 rounded-xl border hairline bg-bg/60 px-7 py-3.5 text-[15px] font-semibold transition hover:-translate-y-0.5 hover:border-brand hover:text-brand">
                  Download <Arrow />
                </Link> */}
                <Link href="/docs" className="group inline-flex items-center gap-2.5 rounded-xl border hairline bg-bg/60 px-7 py-3.5 text-[15px] font-semibold transition hover:-translate-y-0.5 hover:border-brand hover:text-brand">
                  Docs <Arrow />
                </Link>
              </div>
              <div className="anim-rise-4 mt-11 flex flex-wrap gap-x-7 gap-y-2 border-t border-dashed hairline pt-4 font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint">
                <span><b className="font-semibold text-muted">No gas fees</b>. One signature.</span>
                <span><b className="font-semibold text-muted">$1</b> shares, priced in cents</span>
                <span><b className="font-semibold text-muted">Settled</b> against public sources</span>
              </div>
            </div>
            <div className="anim-rise-2 relative hidden justify-center md:flex">
              <div className="anim-float">
                <PostCardMock />
              </div>
              <div className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-brand/15 blur-3xl" />
            </div>
          </div>
        </section>

        {/* ─────────── 01 · Feed × markets ─────────── */}
        <section className="snap-section border-t hairline bg-card">
          <div className="container-page grid items-center gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div>
              <Kicker index="01" label="Feed × markets" className="fx" />
              <h2 className="fx mt-6 text-[clamp(32px,4.6vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
                Every post can carry a{" "}
                <span className="text-gradient-brand">market</span>.
              </h2>
              <p className="fx fx-d1 mt-5 max-w-[560px] text-[16.5px] leading-relaxed text-muted">
                A social feed with posts, stories, reels, and DMs. The twist
                is that you can attach a YES/NO market to anything you post.
                Friends take the other side right from the post card. Shares
                are priced in cents, pay out $1 if you win, and trade on a
                real order book.
              </p>
              <ul className="fx fx-d2 mt-7 grid max-w-[540px] gap-3 text-[14.5px] text-muted">
                <li className="flex gap-3">
                  <span className="mt-0.5 text-brand">▸</span>
                  Creating a market from a post is free. A $1 opening bet gets
                  it started.
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5 text-brand">▸</span>
                  Always know where a market stands:{" "}
                  <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
                    <StateChip state="OPEN" />
                    <StateChip state="MATCHED" />
                    <StateChip state="SETTLING" />
                    <StateChip state="SETTLED" direction="YES" />
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5 text-brand">▸</span>
                  YES at 62¢ means the crowd puts the odds at 62%. Price is probability.
                </li>
              </ul>
            </div>
            <div className="fx-scale fx-d1 flex flex-col items-center gap-5">
              <MarketCardMock
                question="Will the Warriors win game 7 tonight?"
                state="MATCHED"
                yes={44}
                volume="$18,904"
              />
              <div className="w-full max-w-[360px]">
                <MarketCardMock
                  question="Will it rain in San Francisco on Saturday?"
                  state="SETTLED"
                  direction="NO"
                  yes={12}
                  volume="$2,730"
                  compact
                />
              </div>
            </div>
          </div>
        </section>

        {/* ─────────── 02 · Gasless trading ─────────── */}
        <section className="snap-section border-t hairline">
          <div className="container-page grid items-center gap-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <div className="order-2 lg:order-1">
              <div className="fx-scale mx-auto w-full max-w-[420px] rounded-3xl border hairline bg-card p-6 shadow-card">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                  One signature, start to finish
                </p>
                <div className="mt-5 space-y-0">
                  {[
                    {
                      n: "1",
                      t: "You sign once",
                      d: "One signature approves your order and its payment together. There is nothing else to confirm.",
                    },
                    {
                      n: "2",
                      t: "Thassa submits it",
                      d: "Your order is bundled with others and placed onchain for you. Thassa pays the gas, not you.",
                    },
                    {
                      n: "3",
                      t: "The book matches",
                      d: "You fill at the best available price, never worse than your limit. Whatever doesn't fill waits on the book.",
                    },
                  ].map((s, i) => (
                    <div key={s.n} className="relative flex gap-4 pb-6 last:pb-0">
                      {i < 2 && <span className="absolute left-[15px] top-9 h-[calc(100%-36px)] w-px bg-brand/25" />}
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand/40 bg-brand/10 font-mono text-[12px] font-semibold text-brand">
                        {s.n}
                      </span>
                      <div>
                        <p className="text-[14.5px] font-semibold">{s.t}</p>
                        <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.d}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex items-center justify-between rounded-xl bg-fg px-4 py-3 text-bg">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em]">Gas paid by you</span>
                  <span className="text-[17px] font-bold">$0.00</span>
                </div>
              </div>
            </div>
            <div className="order-1 lg:order-2">
              <Kicker index="02" label="Gasless trading" className="fx" />
              <h2 className="fx mt-6 text-[clamp(32px,4.6vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
                One signature. <span className="text-gradient-brand">Zero gas.</span>
              </h2>
              <p className="fx fx-d1 mt-5 max-w-[540px] text-[16.5px] leading-relaxed text-muted">
                There is no deposit step and nothing to bridge. When you trade,
                money moves straight from your wallet into the market. Thassa
                never holds your keys or your funds. One signature approves
                the order and its payment together, so there is exactly one
                thing to confirm.{" "}
                <Link href="/docs/protocol/gasless" className="font-medium text-brand hover:underline">
                  Want the details? Read the docs.
                </Link>
              </p>
              <div className="fx fx-d2 mt-8 grid max-w-[540px] grid-cols-3 divide-x divide-dashed hairline border-y border-dashed hairline">
                {[
                  ["1", "signature per trade"],
                  ["0", "gas paid by users"],
                  ["100%", "self-custodied"],
                ].map(([b, s]) => (
                  <div key={s} className="px-4 py-5 first:pl-0">
                    <p className="text-[26px] font-bold tracking-tight text-brand">{b}</p>
                    <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">{s}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ─────────── 03 · Oracle & sources ─────────── */}
        <section className="snap-section border-t hairline bg-fg text-bg">
          <div className="pointer-events-none absolute -right-32 -top-40 h-[480px] w-[480px] rounded-full bg-brand/25 blur-[80px]" />
          <div className="pointer-events-none absolute -bottom-36 -left-24 h-[380px] w-[380px] rounded-full bg-brand/15 blur-[70px]" />
          <div className="container-page relative grid items-center gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div>
              <Kicker index="03" label="Settlement" className="fx" />
              <h2 className="fx mt-6 text-[clamp(32px,4.6vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
                Settled in the open, against{" "}
                <span className="text-gradient-brand">named sources</span>.
              </h2>
              <p className="fx fx-d1 mt-5 max-w-[560px] text-[16.5px] leading-relaxed text-bg/65">
                Every market declares how it will settle before a single
                share trades: the question, the resolution rule, and the
                exact sources that decide it. Anyone can inspect them. When
                it&rsquo;s time to settle, Thassa checks those sources, and
                nothing pays out until the result is verified onchain.
              </p>
              <ul className="fx fx-d2 mt-7 grid max-w-[560px] gap-3 text-[14.5px] text-bg/65">
                <li className="flex gap-3">
                  <span className="mt-0.5 text-brand-soft">▸</span>
                  <span>
                    <b className="font-semibold text-bg">Facts and figures settle on one named source.</b>{" "}
                    Sports on ESPN, weather on NWS/NOAA, crypto prices on
                    Coinbase. The source is always disclosed.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5 text-brand-soft">▸</span>
                  <span>
                    <b className="font-semibold text-bg">News settles by majority.</b>{" "}
                    NYT, WSJ, Reuters, AP, and BBC each give an independent
                    verdict. A majority has to agree before the market
                    settles.
                  </span>
                </li>
              </ul>
            </div>
            <div className="fx-scale fx-d1 mx-auto w-full max-w-[400px] rounded-3xl border border-bg/15 bg-bg/[0.04] p-6 backdrop-blur">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bg/50">
                  Majority rule
                </p>
                <StateChip state="SETTLING" />
              </div>
              <p className="mt-3 text-[14px] font-semibold leading-snug text-bg">
                “Did the bill pass the Senate before July 1?”
              </p>
              <div className="mt-4 grid gap-2">
                <SourcePill name="Reuters" verdict="YES" />
                <SourcePill name="AP" verdict="YES" />
                <SourcePill name="BBC" verdict="YES" />
                <SourcePill name="NYT" verdict="NO" />
                <SourcePill name="WSJ" verdict="YES" />
              </div>
              <div className="mt-4 rounded-xl border border-yes/30 bg-yes/10 px-4 py-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-yes">
                  4 of 5 agree: settles YES
                </p>
                <p className="mt-1 text-[12px] leading-snug text-bg/60">
                  If there is no majority, the market stays SETTLING and Thassa
                  checks again later.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ─────────── 04 · Creator economics ─────────── */}
        <section className="snap-section border-t hairline">
          <div className="container-page grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <Kicker index="04" label="Creator economics" className="fx" />
              <h2 className="fx mt-6 text-[clamp(32px,4.6vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
                Your markets <span className="text-gradient-brand">pay you</span>.
              </h2>
              <p className="fx fx-d1 mt-5 max-w-[540px] text-[16.5px] leading-relaxed text-muted">
                Takers pay a small fee on each trade, at most 1.75¢ per
                share. Makers pay nothing. Of every fee collected, 10% goes
                to the market&rsquo;s creator and 10% to the post that routed the
                trade. If your post sends people to a busy market, you get
                paid for it.
              </p>
              <p className="fx fx-d2 mt-4 max-w-[540px] text-[14.5px] leading-relaxed text-muted">
                Creating a market is free. You just need a $1 minimum opening
                bet. Settlement costs 5¢ and withdrawals cost a flat 10¢.
                That is the entire fee schedule.
              </p>
            </div>
            <div className="fx-scale fx-d1 mx-auto w-full max-w-[420px]">
              <div className="rounded-3xl border hairline bg-card p-6 shadow-card">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                  Where every taker fee goes
                </p>
                <div className="mt-5 space-y-3">
                  {[
                    { label: "Market creator", pct: 10, color: "bg-brand" },
                    { label: "Affiliate post", pct: 10, color: "bg-yes" },
                    { label: "Protocol", pct: 80, color: "bg-fg/70" },
                  ].map((r) => (
                    <div key={r.label}>
                      <div className="flex items-baseline justify-between text-[13px]">
                        <span className="font-semibold">{r.label}</span>
                        <span className="font-mono text-[12px] text-muted">{r.pct}%</span>
                      </div>
                      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-fg/10">
                        <div className={`h-full rounded-full ${r.color}`} style={{ width: `${r.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-6 grid grid-cols-3 divide-x divide-dashed hairline border-t border-dashed hairline pt-4 text-center">
                  {[
                    ["Free", "market creation"],
                    ["$0.05", "settlement trigger"],
                    ["$0.10", "flat withdrawal"],
                  ].map(([b, s]) => (
                    <div key={s} className="px-2">
                      <p className="text-[17px] font-bold text-brand">{b}</p>
                      <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">{s}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ─────────── 05 · Builders CTA ─────────── */}
        <section className="snap-section border-t hairline bg-card text-center">
          <div className="container-page relative mx-auto max-w-[760px]">
            <Kicker index="05" label="Builders" className="fx justify-center" />
            <h2 className="fx mt-6 text-[clamp(36px,5.4vw,64px)] font-bold leading-[1.02] tracking-[-0.04em]">
              One account. App and{" "}
              <span className="text-gradient-brand">API</span>.
            </h2>
            <p className="fx fx-d1 mx-auto mt-5 max-w-[560px] text-[16.5px] leading-relaxed text-muted">
              Everything the app can do, your code can do: same accounts,
              same order book, same one-signature orders. Create a key in
              the app, stream live prices over WebSocket, and place orders
              from code.
            </p>
            <div className="fx fx-d2 mt-9 flex flex-wrap justify-center gap-3.5">
              <Link href="/docs" className="group inline-flex items-center gap-2.5 rounded-xl bg-brand px-7 py-3.5 text-[15px] font-semibold text-white shadow-[0_14px_34px_-12px_rgba(48,124,222,0.7)] transition hover:-translate-y-0.5 hover:bg-brand-deep">
                Read the docs <Arrow />
              </Link>
              <Link href="/docs/api/market-data" className="group inline-flex items-center gap-2.5 rounded-xl border hairline bg-bg px-7 py-3.5 text-[15px] font-semibold transition hover:-translate-y-0.5 hover:border-brand hover:text-brand">
                API reference <Arrow />
              </Link>
            </div>
            <div className="fx fx-d3 mx-auto mt-12 w-full max-w-[560px] min-w-0 overflow-hidden rounded-2xl border hairline bg-[#0d1117] text-left shadow-pop">
              <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-no/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-settling/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-yes/70" />
                <span className="ml-3 font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">terminal</span>
              </div>
              {/* Lines kept ≤ ~46ch (curl -G splits the query) so the block
                  fits a 320px phone without the page ever scrolling sideways;
                  anything wider scrolls INSIDE the card. */}
              <pre className="w-full max-w-full overflow-x-auto p-4 font-mono text-[11px] leading-relaxed text-[#e6edf3] sm:p-5 sm:text-[12.5px]">
{`$ curl -G "$THASSA_API/trade-api/v1/markets" \\
    -d status=OPEN -d limit=1
{
  "markets": [
    {
      "id": "42",
      "question": "Will it rain in SF Saturday?",
      "status": "OPEN",
      "yes_price_cents": 12,
      "volume": "2730000000"
    }
  ],
  "next_cursor": "eyJvZmZzZXQiOjF9"
}`}
              </pre>
            </div>
          </div>
        </section>
      </main>

      <Footer snap />
    </>
  );
}
