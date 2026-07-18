"use client";

// "Attach market" field in the create-post flow (spec §7):
//  1. typeahead over existing markets (top matches, StateChips + prices);
//  2. picking one → simple $ amount + Advanced (limit price, order book);
//  3. "Generate market" → /v1/markets/generate → up to 3 LLM candidates;
//  4. picking a candidate → spend amount + a 1–99¢ sliding scale setting the
//     maker price ("you pay X to win Y"), $1 minimum enforced client-side.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { useDebounced } from "@/lib/hooks";
import { StateChip } from "@/components/StateChip";
import { OrderBook } from "@/components/OrderBook";
import { MarketDetails } from "@/components/MarketDetails";
import {
  ChevronDownIcon,
  CloseIcon,
  SearchIcon,
  SparkleIcon,
  Spinner,
} from "@/components/icons";
import { escrowUnits, sharesForSpend, unitsToDollars } from "@/lib/signing";
import { fmtCents, fmtDollars } from "@/lib/format";
import type { Market, MarketCandidate, Side } from "@/lib/types";

export type MarketAttachment =
  | {
      kind: "existing";
      market: Market;
      side: Side;
      priceCents: number;
      shares: bigint;
    }
  | {
      kind: "new";
      candidate: MarketCandidate;
      side: Side;
      priceCents: number;
      shares: bigint;
    };

export function AttachMarket({
  value,
  onChange,
}: {
  value: MarketAttachment | null;
  onChange: (v: MarketAttachment | null) => void;
}) {
  const api = useApi();
  const toast = useToast();

  const [queryText, setQueryText] = useState("");
  const debounced = useDebounced(queryText, 250);
  const [candidates, setCandidates] = useState<MarketCandidate[] | null>(null);
  const [generating, setGenerating] = useState(false);

  // trade params
  const [side, setSide] = useState<Side>("yes");
  const [amount, setAmount] = useState("10");
  const [slider, setSlider] = useState(50); // maker price for new markets
  const [advanced, setAdvanced] = useState(false);
  const [fullDetails, setFullDetails] = useState(false);
  const [limitInput, setLimitInput] = useState("");

  const search = useQuery({
    queryKey: ["market-search", debounced],
    queryFn: () =>
      api.get<{ markets: Market[] }>(
        `/v1/markets/search?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: !value && debounced.trim().length >= 2,
  });

  const dollars = parseFloat(amount) || 0;

  // Selected existing market → price defaults to current side price.
  const selMarket = value?.kind === "existing" ? value.market : null;
  const selCandidate = value?.kind === "new" ? value.candidate : null;

  const priceCents = useMemo(() => {
    if (selCandidate) return Math.min(99, Math.max(1, slider));
    if (selMarket) {
      const mkt = side === "yes" ? selMarket.yes_price_cents : selMarket.no_price_cents;
      const p = advanced && limitInput ? parseInt(limitInput, 10) : mkt;
      return Math.min(99, Math.max(1, Number.isFinite(p) ? p : mkt));
    }
    return 50;
  }, [selCandidate, selMarket, slider, side, advanced, limitInput]);

  const shares = sharesForSpend(dollars, priceCents);
  const cost = unitsToDollars(escrowUnits(shares, priceCents));
  const win = Number(shares); // $1 per share

  // Push params up whenever they change while something is selected.
  useEffect(() => {
    if (!value) return;
    const next: MarketAttachment =
      value.kind === "existing"
        ? { kind: "existing", market: value.market, side, priceCents, shares }
        : { kind: "new", candidate: value.candidate, side, priceCents, shares };
    if (
      next.side !== value.side ||
      next.priceCents !== value.priceCents ||
      next.shares !== value.shares
    )
      onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, priceCents, shares]);

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await api.post<{ candidates: MarketCandidate[] }>(
        "/v1/markets/generate",
        { query: queryText.trim() },
      );
      setCandidates(res.candidates.slice(0, 3));
      if (res.candidates.length === 0)
        toast.info("Nothing generated", "Try wording your market differently.");
    } catch (err) {
      toast.error("Couldn't generate markets", errorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  const select = (v: MarketAttachment) => {
    setCandidates(null);
    onChange(v);
  };

  const clear = () => {
    onChange(null);
    setCandidates(null);
    setAdvanced(false);
    setFullDetails(false);
    setLimitInput("");
  };

  const newMarketTooSmall = selCandidate !== null && cost < 1;

  // ------------------------------------------------------------ empty state
  if (!value) {
    return (
      <div className="card p-4">
        <label className="mb-1.5 block text-sm font-bold text-fg">
          Attach a market
          <span className="ml-1.5 font-normal text-muted">(optional)</span>
        </label>
        <div className="relative">
          <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input !pl-9"
            placeholder="Will the Warriors win tonight?"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            maxLength={200}
            aria-label="Search or describe a market"
          />
        </div>

        {search.isFetching && (
          <div className="flex justify-center py-3">
            <Spinner size={16} className="text-muted" />
          </div>
        )}

        {/* existing-market matches first (spec §6.5) */}
        {(search.data?.markets ?? []).length > 0 && (
          <ul className="mt-2 divide-y divide-edge overflow-hidden rounded-xl border border-edge">
            {search.data!.markets.slice(0, 5).map((m) => (
              <li key={m.id}>
                <button
                  onClick={() =>
                    select({
                      kind: "existing",
                      market: m,
                      side: "yes",
                      priceCents: m.yes_price_cents,
                      shares: 0n,
                    })
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-surface"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {m.question}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StateChip state={m.status} direction={m.direction} size="xs" />
                    <span className="font-mono text-xs font-bold tabular-nums text-yes">
                      {fmtCents(m.yes_price_cents)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {queryText.trim().length >= 3 && (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="btn-ghost mt-3 w-full border-dashed !text-brand"
          >
            {generating ? <Spinner size={16} /> : <SparkleIcon size={16} />}
            Generate market
          </button>
        )}

        {/* LLM candidates */}
        {candidates && candidates.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted">
              Pick a market
            </p>
            {candidates.map((c, i) => (
              <button
                key={i}
                onClick={() =>
                  select({ kind: "new", candidate: c, side: "yes", priceCents: 50, shares: 0n })
                }
                className="block w-full rounded-xl border border-edge p-3 text-left transition hover:border-brand hover:bg-brand-soft/30"
              >
                <p className="text-sm font-bold text-fg">{c.title}</p>
                <p className="mt-0.5 text-xs text-muted">{c.question}</p>
                {c.suggested_close_note && (
                  <p className="mt-1 text-[11px] text-muted/80">{c.suggested_close_note}</p>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // --------------------------------------------------------- selected state
  return (
    <div className="card border-brand/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold leading-snug text-fg">
            {selMarket ? selMarket.question : selCandidate!.question}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {selMarket ? (
              <span className="inline-flex items-center gap-1.5">
                <StateChip state={selMarket.status} size="xs" /> existing market
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-brand">
                <SparkleIcon size={11} /> new market. You open the book.
              </span>
            )}
          </p>
        </div>
        <button
          onClick={clear}
          aria-label="Remove attached market"
          className="rounded-full p-1 text-muted transition hover:bg-surface hover:text-fg"
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {/* side */}
      <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Your side">
        {(["yes", "no"] as Side[]).map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={side === s}
            onClick={() => setSide(s)}
            className={`rounded-xl border-2 py-2 text-sm font-extrabold uppercase transition ${
              side === s
                ? s === "yes"
                  ? "border-yes bg-yes/10 text-yes"
                  : "border-no bg-no/10 text-no"
                : "border-edge text-muted hover:bg-surface"
            }`}
          >
            {s}
            {selMarket && (
              <span className="ml-1.5 font-mono tabular-nums">
                {fmtCents(s === "yes" ? selMarket.yes_price_cents : selMarket.no_price_cents)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* amount */}
      <label className="mb-1 mt-3 block text-xs font-bold uppercase tracking-wide text-muted">
        Spend
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">
          $
        </span>
        <input
          className="input !pl-7 font-mono tabular-nums"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-label="Amount to spend in dollars"
        />
      </div>

      {/* sliding scale for new markets: maker price = bet percentage */}
      {selCandidate && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <label htmlFor="price-slider" className="text-xs font-bold uppercase tracking-wide text-muted">
              Your price — how likely is {side.toUpperCase()}?
            </label>
            <span className={`font-mono text-lg font-extrabold tabular-nums ${side === "yes" ? "text-yes" : "text-no"}`}>
              {fmtCents(priceCents)}
            </span>
          </div>
          <input
            id="price-slider"
            type="range"
            min={1}
            max={99}
            value={slider}
            onChange={(e) => setSlider(parseInt(e.target.value, 10))}
            className="mt-2 w-full accent-[#307CDE]"
            aria-valuetext={`${priceCents} cents per share`}
          />
          <div className="flex justify-between text-[10px] text-muted">
            <span>1¢ · long shot</span>
            <span>99¢ · near lock</span>
          </div>
        </div>
      )}

      {/* advanced for existing markets */}
      {selMarket && (
        <>
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            className="mt-3 flex items-center gap-1 text-xs font-bold text-brand"
          >
            Advanced
            <ChevronDownIcon size={14} className={`transition ${advanced ? "rotate-180" : ""}`} />
          </button>
          {advanced && (
            <div className="mt-2 space-y-3 rounded-xl bg-surface/60 p-3">
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted">
                  Limit price (cents)
                </label>
                <input
                  className="input font-mono tabular-nums"
                  inputMode="numeric"
                  placeholder={String(side === "yes" ? selMarket.yes_price_cents : selMarket.no_price_cents)}
                  value={limitInput}
                  onChange={(e) => setLimitInput(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </div>
              <OrderBook marketId={selMarket.id} compact />
            </div>
          )}
        </>
      )}

      {/* summary */}
      <div className="mt-3 rounded-xl bg-surface/60 p-3 text-sm">
        {shares > 0n ? (
          <p className="font-semibold text-fg">
            You pay {fmtDollars(cost)} to win {fmtDollars(win)}
            <span className="ml-1.5 font-normal text-muted">
              ({shares.toString()} shares @ {fmtCents(priceCents)})
            </span>
          </p>
        ) : (
          <p className="text-muted">Enter an amount to see your position.</p>
        )}
        {newMarketTooSmall && (
          <p className="mt-1 text-xs font-semibold text-no">
            New markets need at least $1 of opening capital.
          </p>
        )}
      </div>

      {/* Full market details — review exactly what you're attaching, for both a
          selected existing market and a generated candidate. */}
      <button
        type="button"
        onClick={() => setFullDetails((f) => !f)}
        aria-expanded={fullDetails}
        className="mt-3 flex items-center gap-1 text-xs font-bold text-brand"
      >
        Full market details
        <ChevronDownIcon size={14} className={`transition ${fullDetails ? "rotate-180" : ""}`} />
      </button>
      {fullDetails && (
        <div className="mt-2">
          {selMarket ? (
            <MarketDetails market={selMarket} />
          ) : (
            <MarketDetails candidate={selCandidate} />
          )}
        </div>
      )}
    </div>
  );
}
