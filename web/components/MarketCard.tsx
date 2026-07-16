"use client";

// The market widget embedded in post cards (spec §7) and reused on the
// market detail page: question + StateChip, YES/NO price buttons (cents =
// probability) opening the quick-buy sheet, poster's position badge, settled
// direction + PnL, and an Advanced expander with limit orders, the live
// order book, the PUBLIC settlement query, and the 5¢ settle button.

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { StateChip, creatorMicrocopy } from "@/components/StateChip";
import { TradeSheet } from "@/components/TradeSheet";
import { OrderBook } from "@/components/OrderBook";
import { Sheet } from "@/components/Sheet";
import { ChevronDownIcon, Spinner, TradesIcon } from "@/components/icons";
import { useTrading } from "@/lib/trading";
import { errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { useSession } from "@/providers/SessionProvider";
import { fmtCents, fmtSignedUnits, fmtVolume } from "@/lib/format";
import type { PostMarket, Side, UserLite } from "@/lib/types";

export function MarketCard({
  market,
  poster,
  affiliateId,
  affiliatePostId,
  linkToDetail = true,
  showAdvanced = true,
}: {
  market: PostMarket;
  poster?: UserLite | null; // post author, for position badge / PnL copy
  affiliateId?: number | null;
  affiliatePostId?: string | null;
  linkToDetail?: boolean;
  showAdvanced?: boolean;
}) {
  const { me } = useSession();
  const toast = useToast();
  const trading = useTrading();
  const queryClient = useQueryClient();

  const [tradeSide, setTradeSide] = useState<Side | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [settleConfirm, setSettleConfirm] = useState(false);
  const [settling, setSettling] = useState(false);

  const isCreator = me?.id === market.creator?.id;
  const micro = isCreator ? creatorMicrocopy(market.status) : null;
  const tradable = market.status === "OPEN" || market.status === "MATCHED";
  const settleEligible = tradable; // anyone may trigger; backend enforces
  const pos = market.poster_position;

  const settle = async () => {
    setSettling(true);
    try {
      await trading.settleMarket(market);
      toast.success("Settlement requested", "The oracle is on it.");
      queryClient.invalidateQueries({ queryKey: ["market", market.id] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      setSettleConfirm(false);
    } catch (err) {
      toast.error("Couldn't settle", errorMessage(err));
    } finally {
      setSettling(false);
    }
  };

  const question = linkToDetail ? (
    <Link
      href={`/markets/${market.id}`}
      className="font-semibold leading-snug text-fg hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
    >
      {market.question}
    </Link>
  ) : (
    <span className="font-semibold leading-snug text-fg">{market.question}</span>
  );

  return (
    <div className="card border-brand/20 bg-brand-soft/40 p-3.5 dark:bg-brand-soft/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[15px]">{question}</div>
        <StateChip state={market.status} direction={market.direction} />
      </div>

      {/* creator microcopy */}
      {micro && (market.status === "OPEN" || market.status === "MATCHED" || market.status === "PENDING") && (
        <p className="mt-1.5 text-xs font-medium text-muted">{micro}</p>
      )}

      {/* SETTLED: direction + poster PnL stay attached to the post */}
      {market.status === "SETTLED" && (
        <div className="mt-2.5 flex items-center justify-between rounded-xl bg-card px-3 py-2">
          <span className="text-sm text-muted">
            Resolved{" "}
            <strong className={market.direction ? "text-yes" : "text-no"}>
              {market.direction ? "YES" : "NO"}
            </strong>
          </span>
          {poster && market.poster_pnl != null && (
            <span
              className={`font-mono text-sm font-bold tabular-nums ${
                market.poster_pnl.startsWith("-") ? "text-no" : "text-yes"
              }`}
            >
              @{poster.username} {fmtSignedUnits(market.poster_pnl)}
            </span>
          )}
        </div>
      )}

      {/* YES/NO quick-buy buttons */}
      {market.status !== "SETTLED" && market.status !== "VOID" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => tradable && setTradeSide("yes")}
            disabled={!tradable}
            aria-label={`Buy YES at ${market.yes_price_cents} cents`}
            className="btn bg-yes/15 py-2.5 font-extrabold text-yes hover:bg-yes/25 disabled:opacity-40"
          >
            YES <span className="font-mono tabular-nums">{fmtCents(market.yes_price_cents)}</span>
          </button>
          <button
            onClick={() => tradable && setTradeSide("no")}
            disabled={!tradable}
            aria-label={`Buy NO at ${market.no_price_cents} cents`}
            className="btn bg-no/15 py-2.5 font-extrabold text-no hover:bg-no/25 disabled:opacity-40"
          >
            NO <span className="font-mono tabular-nums">{fmtCents(market.no_price_cents)}</span>
          </button>
        </div>
      )}

      {/* poster's position badge (hidden server-side when trades private) */}
      {pos && poster && (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted">
          <TradesIcon size={13} />
          @{poster.username} holds{" "}
          <strong className={pos.side === "yes" ? "text-yes" : "text-no"}>
            {pos.shares} {pos.side.toUpperCase()}
          </strong>{" "}
          @ {fmtCents(pos.avg_price_cents)}
        </p>
      )}

      {/* Advanced */}
      {showAdvanced && (
        <>
          <div className="mt-2.5 flex items-center justify-between">
            <button
              onClick={() => setAdvanced((a) => !a)}
              aria-expanded={advanced}
              className="flex items-center gap-1 text-xs font-bold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              Advanced
              <ChevronDownIcon size={14} className={`transition ${advanced ? "rotate-180" : ""}`} />
            </button>
            <span className="text-[11px] text-muted">Vol {fmtVolume(market.volume)}</span>
          </div>

          {advanced && (
            <div className="mt-2 space-y-3 rounded-xl bg-card p-3">
              <OrderBook marketId={market.id} compact />
              <div>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                  Settlement query (public)
                </p>
                <p className="whitespace-pre-wrap rounded-lg bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-fg/90">
                  {market.settlement_query}
                </p>
              </div>
              {tradable && (
                <button
                  onClick={() => setTradeSide("yes")}
                  className="btn-ghost w-full text-xs"
                >
                  Place a limit order
                </button>
              )}
              {settleEligible && (
                <button
                  onClick={() => setSettleConfirm(true)}
                  className="btn-accent w-full text-xs"
                >
                  Settle market — 5¢
                </button>
              )}
              {market.status === "SETTLING" && (
                <p className="text-center text-xs font-medium text-settling">
                  Settlement query is running…
                </p>
              )}
            </div>
          )}
        </>
      )}

      {tradeSide && (
        <TradeSheet
          market={market}
          initialSide={tradeSide}
          affiliateId={affiliateId}
          affiliatePostId={affiliatePostId}
          onClose={() => setTradeSide(null)}
        />
      )}

      {settleConfirm && (
        <Sheet title="Settle market — 5¢" onClose={() => setSettleConfirm(false)}>
          <p className="text-sm leading-relaxed text-fg/90">
            This runs the public settlement query through the Thassa oracle.
            You pay a <strong>5¢</strong> settlement fee. If the outcome
            isn&apos;t determinable yet, the market stays open and you can
            re-trigger later.
          </p>
          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-fg/90">
            {market.settlement_query}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => setSettleConfirm(false)} className="btn-ghost">
              Cancel
            </button>
            <button onClick={settle} disabled={settling} className="btn-accent">
              {settling ? <Spinner size={16} /> : "Settle — 5¢"}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
