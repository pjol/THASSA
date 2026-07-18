"use client";

// Full market details (spec §6.5b transparency). A comprehensive, read-only
// panel that renders EVERYTHING known about a market — its question and state,
// exactly how it resolves (category, rule, disclosed sources), the verbatim
// public settlement query, live YES/NO prices + order book, volume, creator,
// the fee structure, the viewer's own position/PnL, and (advanced) the
// market/chain id reference. It gracefully handles two shapes:
//   • an existing Market (has an id, live book, volume, creator, …), and
//   • a not-yet-created MarketCandidate from the create flow (question,
//     category, rule, sources, settlement query — but no live book / id yet).
// Reused by MarketCard's Details expander and AttachMarket's "Full market
// details" expander so the collapsed card + trade forms stay untouched.

import Link from "next/link";
import { OrderBook } from "@/components/OrderBook";
import { StateChip } from "@/components/StateChip";
import { fmtCents, fmtVolume, shortAddress } from "@/lib/format";
import type {
  Market,
  MarketCandidate,
  Position,
  PostMarket,
  Settlement,
  SettlementRule,
  SettlementSource,
} from "@/lib/types";

// One-word state vocabulary blurb (spec §5), shown beside the chip.
const STATE_BLURB: Record<string, string> = {
  PENDING: "Being placed onchain.",
  OPEN: "Live — waiting for a taker.",
  MATCHED: "Both sides are in.",
  SETTLING: "Oracle is resolving the outcome.",
  SETTLED: "Outcome is final.",
  VOID: "Voided — deposits refundable.",
};

// Resolution rule → plain-English sentence (spec §6.5b).
function resolutionRuleCopy(rule: SettlementRule, sources: SettlementSource[]): string {
  if (rule === "single") {
    return `Resolves via ${sources[0]?.name ?? "its named source"}`;
  }
  const names = sources.map((s) => s.name).join(", ");
  return names
    ? `Resolves when a majority of ${names} concur`
    : "Resolves by majority of its named sources";
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">
        {label}
      </p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-fg">{value}</span>
    </div>
  );
}

export function MarketDetails({
  market,
  candidate,
  position,
  positionLabel = "Your position",
  posterPnl,
}: {
  // Provide exactly one of `market` / `candidate`.
  market?: Market | PostMarket | null;
  candidate?: MarketCandidate | null;
  // Viewer's (or poster's) position + settled PnL, when known.
  position?: Position | null;
  positionLabel?: string;
  posterPnl?: string | null;
}) {
  const question = market?.question ?? candidate?.question ?? "";
  const settlementQuery = market?.settlement_query ?? candidate?.settlement_query ?? "";

  // Structured settlement: existing markets carry a `settlement` object; a
  // candidate carries the same fields flat. Normalize to one shape.
  const settlement: Settlement | null = market?.settlement
    ? market.settlement
    : candidate && (candidate.rule || candidate.sources || candidate.category)
      ? {
          question: candidate.question,
          category: candidate.category ?? null,
          rule: candidate.rule ?? "single",
          sources: candidate.sources ?? [],
        }
      : null;

  const sources = settlement?.sources ?? [];
  const tradable = market?.status === "OPEN" || market?.status === "MATCHED";
  const showBook = !!market && (tradable || market.status === "SETTLING");
  const pos = position ?? market?.my_position ?? null;

  return (
    <div className="space-y-4 rounded-xl bg-card p-3 text-fg">
      {/* ── Question + state ── */}
      <div className="space-y-1.5">
        <p className="text-[15px] font-semibold leading-snug text-fg">{question}</p>
        {market ? (
          <div className="flex items-center gap-2">
            <StateChip state={market.status} direction={market.direction} />
            <span className="text-xs text-muted">
              {STATE_BLURB[market.status] ?? ""}
            </span>
          </div>
        ) : (
          <span className="inline-flex items-center rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-brand">
            New market
          </span>
        )}
      </div>

      {/* ── How this market settles (§6.5b transparency) ── */}
      <Section label="How this market settles">
        <div className="space-y-2">
          {settlement?.category && (
            <span className="inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
              {settlement.category}
            </span>
          )}
          {settlement && (
            <p className="text-sm font-semibold text-brand">
              {resolutionRuleCopy(settlement.rule, sources)}
            </p>
          )}
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {sources.map((s) => (
                <a
                  key={s.id}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-bold text-brand transition hover:bg-brand-soft/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                >
                  {s.name}
                  <span aria-hidden className="text-[10px]">↗</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* ── Verbatim public settlement query ── */}
      <Section label="Public settlement query">
        <p className="whitespace-pre-wrap rounded-lg bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-fg/90">
          {settlementQuery || "—"}
        </p>
      </Section>

      {/* ── Prices ── */}
      {market && (
        <Section label="Price">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-yes/10 px-3 py-2 text-center">
              <p className="text-[10px] font-bold uppercase tracking-wide text-yes">YES</p>
              <p className="font-mono text-lg font-extrabold tabular-nums text-yes">
                {fmtCents(market.yes_price_cents)}
              </p>
            </div>
            <div className="rounded-lg bg-no/10 px-3 py-2 text-center">
              <p className="text-[10px] font-bold uppercase tracking-wide text-no">NO</p>
              <p className="font-mono text-lg font-extrabold tabular-nums text-no">
                {fmtCents(market.no_price_cents)}
              </p>
            </div>
          </div>
        </Section>
      )}

      {/* ── Live order book (existing, tradable/settling markets only) ── */}
      {showBook && (
        <Section label="Order book">
          <OrderBook marketId={market!.id} compact />
        </Section>
      )}

      {/* ── Market stats ── */}
      {market && (
        <Section label="Market">
          <div className="space-y-1.5">
            <Row label="Volume" value={fmtVolume(market.volume)} />
            {market.creator?.username && (
              <Row
                label="Creator"
                value={
                  <Link
                    href={`/u/${market.creator.username}`}
                    className="text-brand hover:underline"
                  >
                    @{market.creator.username}
                  </Link>
                }
              />
            )}
          </div>
        </Section>
      )}

      {/* HARD RULE: fees are never shown on market cards — not even in the
          advanced/details tiers. The fee schedule lives in the docs. */}

      {/* ── Viewer's / poster's own position + PnL ── */}
      {pos && (
        <Section label={positionLabel}>
          <div className="space-y-1.5">
            <Row
              label="Holding"
              value={
                <span className={pos.side === "yes" ? "text-yes" : "text-no"}>
                  {pos.shares} {pos.side.toUpperCase()} @ {fmtCents(pos.avg_price_cents)}
                </span>
              }
            />
            {posterPnl != null && (
              <Row
                label="PnL"
                value={
                  <span
                    className={`font-mono ${posterPnl.startsWith("-") ? "text-no" : "text-yes"}`}
                  >
                    {posterPnl}
                  </span>
                }
              />
            )}
            {pos.realized_pnl != null && posterPnl == null && (
              <Row
                label="Realized PnL"
                value={
                  <span
                    className={`font-mono ${pos.realized_pnl.startsWith("-") ? "text-no" : "text-yes"}`}
                  >
                    {pos.realized_pnl}
                  </span>
                }
              />
            )}
          </div>
        </Section>
      )}

      {/* ── Advanced: id reference (existing markets) ── */}
      {market && (
        <Section label="Reference (advanced)">
          <div className="space-y-1.5">
            <Row
              label="Market id"
              value={<span className="font-mono text-xs">{shortAddress(market.id)}</span>}
            />
            <Row
              label="Chain market id"
              value={<span className="font-mono text-xs">#{market.chain_market_id}</span>}
            />
          </div>
        </Section>
      )}
    </div>
  );
}
