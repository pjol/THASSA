"use client";

// The market widget embedded in post cards (spec §7) and reused on the market
// detail page. Collapsed default is a SINGLE LINE: the question with YES/NO
// price buttons on the right. Choosing a side expands the card inline to a
// trade form (amount, optional limit price + live book, cost/payout summary,
// submit) that walks the order through SIGNING → QUEUED. Settled markets keep
// their direction + poster PnL attached; an Advanced row exposes the public
// settlement query, order book, and the 5¢ settle action.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { StateChip, creatorMicrocopy } from "@/components/StateChip";
import { OrderBook } from "@/components/OrderBook";
import { Sheet } from "@/components/Sheet";
import { ChevronDownIcon, Spinner, TradesIcon, CloseIcon } from "@/components/icons";
import { useTrading } from "@/lib/trading";
import { errorMessage, newIdempotencyKey } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { useSession } from "@/providers/SessionProvider";
import { sharesForSpend, takerFeeUnits, escrowUnits } from "@/lib/signing";
import { fmtCents, fmtDollars, fmtUnits, fmtSignedUnits, fmtVolume } from "@/lib/format";
import type { PostMarket, OrderStatus, Side, UserLite } from "@/lib/types";

const QUICK_AMOUNTS = [5, 10, 25, 50];

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

  // side === null → collapsed (single line). Setting a side expands the form.
  const [side, setSide] = useState<Side | null>(null);
  const [amount, setAmount] = useState<string>("10");
  const [advanced, setAdvanced] = useState(false);
  const [limitInput, setLimitInput] = useState<string>("");
  const [phase, setPhase] = useState<OrderStatus | null>(null);
  const [details, setDetails] = useState(false); // settlement query / settle
  const [settleConfirm, setSettleConfirm] = useState(false);
  const [settling, setSettling] = useState(false);
  // One idempotency key per logical order attempt; a retry reuses it.
  const idemKeyRef = useRef(newIdempotencyKey());

  const isCreator = me?.id === market.creator?.id;
  const micro = isCreator ? creatorMicrocopy(market.status) : null;
  const tradable = market.status === "OPEN" || market.status === "MATCHED";
  const pos = market.poster_position;

  const marketPrice =
    side === "no" ? market.no_price_cents : market.yes_price_cents;
  const price = useMemo(() => {
    const p = advanced && limitInput ? parseInt(limitInput, 10) : marketPrice;
    return Math.min(99, Math.max(1, Number.isFinite(p) ? p : marketPrice));
  }, [advanced, limitInput, marketPrice]);

  const dollars = parseFloat(amount) || 0;
  const shares = sharesForSpend(dollars, price);
  const cost = escrowUnits(shares, price);
  const fee = takerFeeUnits(shares, price);
  const canSubmit = tradable && side != null && shares > 0n && !phase;

  const collapse = () => {
    setSide(null);
    setAdvanced(false);
    setLimitInput("");
    setPhase(null);
  };

  const pick = (s: Side) => {
    if (!tradable) return;
    setPhase(null);
    setSide(s);
  };

  const place = async () => {
    if (!canSubmit || side == null) return;
    setPhase("SIGNING");
    try {
      const order = await trading.placeOrder({
        market,
        side,
        priceCents: price,
        shares,
        affiliateId,
        affiliatePostId,
        idempotencyKey: idemKeyRef.current,
      });
      idemKeyRef.current = newIdempotencyKey();
      setPhase(order.status ?? "QUEUED");
      toast.success(
        "Order in",
        `Buy ${side.toUpperCase()} · ${shares.toString()} shares @ ${fmtCents(price)}`,
      );
      queryClient.invalidateQueries({ queryKey: ["book", market.id] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      setTimeout(collapse, 900);
    } catch (err) {
      setPhase(null);
      toast.error("Order failed", errorMessage(err));
    }
  };

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

  // A compact YES/NO pill button used on the collapsed line.
  const sideButton = (s: Side) => {
    const p = s === "yes" ? market.yes_price_cents : market.no_price_cents;
    const active = side === s;
    const on = s === "yes";
    return (
      <button
        onClick={() => pick(s)}
        disabled={!tradable}
        aria-pressed={active}
        aria-label={`Buy ${s.toUpperCase()} at ${p} cents`}
        className={`btn shrink-0 gap-1 px-3 py-1.5 text-sm font-extrabold tabular-nums transition disabled:opacity-40 ${
          on ? "text-yes" : "text-no"
        } ${
          active
            ? on
              ? "bg-yes/25 ring-2 ring-yes"
              : "bg-no/25 ring-2 ring-no"
            : on
              ? "bg-yes/15 hover:bg-yes/25"
              : "bg-no/15 hover:bg-no/25"
        }`}
      >
        {s.toUpperCase()} <span className="font-mono">{fmtCents(p)}</span>
      </button>
    );
  };

  return (
    <div className="card border-brand/20 bg-brand-soft/40 p-3 dark:bg-brand-soft/20">
      {/* ── Single collapsed line: question + YES/NO on the right ── */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate text-[15px]">{question}</div>

        {market.status === "SETTLED" ? (
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-extrabold ${
              market.direction ? "bg-yes/15 text-yes" : "bg-no/15 text-no"
            }`}
          >
            {market.direction ? "YES" : "NO"}
          </span>
        ) : tradable ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {sideButton("yes")}
            {sideButton("no")}
          </div>
        ) : (
          <StateChip state={market.status} direction={market.direction} />
        )}
      </div>

      {/* creator microcopy (OPEN "committed…" / MATCHED "taken") */}
      {micro &&
        (market.status === "OPEN" ||
          market.status === "MATCHED" ||
          market.status === "PENDING") && (
          <p className="mt-1.5 text-xs font-medium text-muted">{micro}</p>
        )}

      {/* SETTLED: poster PnL stays attached to the post */}
      {market.status === "SETTLED" && poster && market.poster_pnl != null && (
        <p className="mt-1.5 text-xs font-medium text-muted">
          @{poster.username}{" "}
          <span
            className={`font-mono font-bold tabular-nums ${
              market.poster_pnl.startsWith("-") ? "text-no" : "text-yes"
            }`}
          >
            {fmtSignedUnits(market.poster_pnl)}
          </span>
        </p>
      )}

      {/* poster's position badge (hidden server-side when trades private) */}
      {pos && poster && side == null && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
          <TradesIcon size={13} />@{poster.username} holds{" "}
          <strong className={pos.side === "yes" ? "text-yes" : "text-no"}>
            {pos.shares} {pos.side.toUpperCase()}
          </strong>{" "}
          @ {fmtCents(pos.avg_price_cents)}
        </p>
      )}

      {/* ── Expanded inline trade form (after choosing a side) ── */}
      {side != null && tradable && (
        <div className="mt-3 space-y-3 rounded-xl bg-card p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">
              Buy{" "}
              <span className={side === "yes" ? "text-yes" : "text-no"}>
                {side.toUpperCase()}
              </span>{" "}
              @ {fmtCents(price)}
            </span>
            <button
              onClick={collapse}
              aria-label="Cancel"
              className="rounded-full p-1 text-muted hover:bg-surface hover:text-fg"
            >
              <CloseIcon size={15} />
            </button>
          </div>

          {/* Amount */}
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-muted">
              Amount
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">
                $
              </span>
              <input
                className="input !pl-6 font-mono text-base tabular-nums"
                inputMode="decimal"
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^0-9.]/g, ""))
                }
                aria-label="Amount in dollars"
              />
            </div>
            <div className="mt-2 flex gap-1.5">
              {QUICK_AMOUNTS.map((a) => (
                <button
                  key={a}
                  onClick={() => setAmount(String(a))}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                    amount === String(a)
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-edge text-muted hover:bg-surface"
                  }`}
                >
                  ${a}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced: limit price + live order book */}
          <button
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            className="flex items-center gap-1 text-xs font-bold text-brand"
          >
            Advanced
            <ChevronDownIcon
              size={14}
              className={`transition ${advanced ? "rotate-180" : ""}`}
            />
          </button>
          {advanced && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-muted">
                  Limit price (cents)
                </label>
                <input
                  className="input font-mono tabular-nums"
                  inputMode="numeric"
                  placeholder={String(marketPrice)}
                  value={limitInput}
                  onChange={(e) =>
                    setLimitInput(e.target.value.replace(/[^0-9]/g, ""))
                  }
                  aria-label="Limit price in cents"
                />
              </div>
              <OrderBook marketId={market.id} compact />
            </div>
          )}

          {/* Summary */}
          <div className="space-y-1 rounded-lg bg-surface/60 p-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Shares</span>
              <span className="font-mono font-semibold tabular-nums">
                {shares.toString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Fee if taking (est.)</span>
              <span className="font-mono tabular-nums">{fmtUnits(fee)}</span>
            </div>
            <div className="font-semibold text-fg">
              You pay {fmtUnits(cost)} to win {fmtDollars(Number(shares))}
            </div>
          </div>

          <button
            onClick={place}
            disabled={!canSubmit}
            className={`btn w-full !py-2.5 text-base text-white ${
              side === "yes" ? "bg-yes hover:bg-yes/90" : "bg-no hover:bg-no/90"
            } disabled:opacity-50`}
          >
            {phase ? (
              <span className="inline-flex items-center gap-2">
                {phase === "SIGNING" && <Spinner size={16} />}
                <StateChip state={phase} />
              </span>
            ) : (
              `Buy ${side.toUpperCase()} at ${fmtCents(price)}`
            )}
          </button>
          <p className="text-center text-[11px] text-muted">
            Gasless — you sign, our relayer submits. Each share pays $1 if
            you&apos;re right.
          </p>
        </div>
      )}

      {/* ── Advanced details (settlement query + settle), when not trading ── */}
      {showAdvanced && side == null && (
        <>
          <div className="mt-2 flex items-center justify-between">
            <button
              onClick={() => setDetails((d) => !d)}
              aria-expanded={details}
              className="flex items-center gap-1 text-xs font-bold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              Details
              <ChevronDownIcon
                size={14}
                className={`transition ${details ? "rotate-180" : ""}`}
              />
            </button>
            <span className="text-[11px] text-muted">
              Vol {fmtVolume(market.volume)}
            </span>
          </div>

          {details && (
            <div className="mt-2 space-y-3 rounded-xl bg-card p-3">
              {(market.status === "OPEN" ||
                market.status === "MATCHED" ||
                market.status === "SETTLING") && (
                <OrderBook marketId={market.id} compact />
              )}
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

      {settleConfirm && (
        <Sheet title="Settle market — 5¢" onClose={() => setSettleConfirm(false)}>
          <p className="text-sm leading-relaxed text-fg/90">
            This runs the public settlement query through the Thassa oracle. You
            pay a <strong>5¢</strong> settlement fee. If the outcome isn&apos;t
            determinable yet, the market stays open and you can re-trigger later.
          </p>
          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-fg/90">
            {market.settlement_query}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              onClick={() => setSettleConfirm(false)}
              className="btn-ghost"
            >
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
