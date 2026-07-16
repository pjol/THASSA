"use client";

// Quick-buy amount sheet + Advanced (limit price, live order book). Walks the
// order through SIGNING → QUEUED using the one-word order vocabulary.

import { useMemo, useRef, useState } from "react";
import { newIdempotencyKey } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet } from "@/components/Sheet";
import { StateChip } from "@/components/StateChip";
import { OrderBook } from "@/components/OrderBook";
import { ChevronDownIcon, Spinner } from "@/components/icons";
import { useTrading } from "@/lib/trading";
import { errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import {
  sharesForSpend,
  takerFeeUnits,
  escrowUnits,
} from "@/lib/signing";
import { fmtCents, fmtDollars, fmtUnits } from "@/lib/format";
import type { Market, OrderStatus, Side } from "@/lib/types";

const QUICK_AMOUNTS = [5, 10, 25, 50];

export function TradeSheet({
  market,
  initialSide,
  affiliateId,
  affiliatePostId,
  onClose,
}: {
  market: Market;
  initialSide: Side;
  affiliateId?: number | null;
  affiliatePostId?: string | null;
  onClose: () => void;
}) {
  const trading = useTrading();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [side, setSide] = useState<Side>(initialSide);
  const [amount, setAmount] = useState<string>("10");
  const [advanced, setAdvanced] = useState(false);
  const [limitInput, setLimitInput] = useState<string>("");
  const [phase, setPhase] = useState<OrderStatus | null>(null);
  // One key per logical order attempt: a retry after failure reuses it.
  const idemKeyRef = useRef(newIdempotencyKey());

  const marketPrice = side === "yes" ? market.yes_price_cents : market.no_price_cents;
  const price = useMemo(() => {
    const p = advanced && limitInput ? parseInt(limitInput, 10) : marketPrice;
    return Math.min(99, Math.max(1, Number.isFinite(p) ? p : marketPrice));
  }, [advanced, limitInput, marketPrice]);

  const dollars = parseFloat(amount) || 0;
  const shares = sharesForSpend(dollars, price);
  const cost = escrowUnits(shares, price);
  const fee = takerFeeUnits(shares, price);

  const canTrade =
    (market.status === "OPEN" || market.status === "MATCHED") &&
    shares > 0n &&
    !phase;

  const place = async () => {
    if (!canTrade) return;
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
      idemKeyRef.current = newIdempotencyKey(); // next order = new operation
      setPhase(order.status ?? "QUEUED");
      toast.success(
        "Order in",
        `Buy ${side.toUpperCase()} · ${shares.toString()} shares @ ${fmtCents(price)}`,
      );
      queryClient.invalidateQueries({ queryKey: ["book", market.id] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      setTimeout(onClose, 900);
    } catch (err) {
      setPhase(null);
      toast.error("Order failed", errorMessage(err));
    }
  };

  return (
    <Sheet title={market.question} onClose={onClose}>
      {/* Side toggle */}
      <div className="mb-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
        {(["yes", "no"] as Side[]).map((s) => {
          const p = s === "yes" ? market.yes_price_cents : market.no_price_cents;
          const active = side === s;
          return (
            <button
              key={s}
              role="radio"
              aria-checked={active}
              onClick={() => setSide(s)}
              className={`rounded-2xl border-2 px-4 py-3 text-center transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
                active
                  ? s === "yes"
                    ? "border-yes bg-yes/10"
                    : "border-no bg-no/10"
                  : "border-edge bg-card hover:bg-surface"
              }`}
            >
              <span
                className={`block text-sm font-extrabold uppercase ${
                  s === "yes" ? "text-yes" : "text-no"
                }`}
              >
                {s}
              </span>
              <span className="block font-mono text-lg font-bold tabular-nums text-fg">
                {fmtCents(p)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Amount */}
      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
        Amount
      </label>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">
            $
          </span>
          <input
            className="input !pl-7 font-mono text-base tabular-nums"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Amount in dollars"
          />
        </div>
      </div>
      <div className="mb-4 flex gap-2">
        {QUICK_AMOUNTS.map((a) => (
          <button
            key={a}
            onClick={() => setAmount(String(a))}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
              amount === String(a)
                ? "border-accent bg-accent text-accent-fg"
                : "border-edge text-muted hover:bg-surface"
            }`}
          >
            ${a}
          </button>
        ))}
      </div>

      {/* Advanced */}
      <button
        onClick={() => setAdvanced((a) => !a)}
        aria-expanded={advanced}
        className="mb-2 flex items-center gap-1 text-sm font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      >
        Advanced
        <ChevronDownIcon size={16} className={`transition ${advanced ? "rotate-180" : ""}`} />
      </button>
      {advanced && (
        <div className="card mb-4 space-y-3 bg-surface/50 p-3">
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted">
              Limit price (cents)
            </label>
            <input
              className="input font-mono tabular-nums"
              inputMode="numeric"
              placeholder={String(marketPrice)}
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value.replace(/[^0-9]/g, ""))}
              aria-label="Limit price in cents"
            />
          </div>
          <OrderBook marketId={market.id} compact />
        </div>
      )}

      {/* Summary */}
      <div className="mb-4 space-y-1 rounded-2xl bg-surface/60 p-3.5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted">Shares</span>
          <span className="font-mono font-semibold tabular-nums">{shares.toString()}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Fee if taking (est.)</span>
          <span className="font-mono tabular-nums">{fmtUnits(fee)}</span>
        </div>
        <div className="flex justify-between font-semibold text-fg">
          <span>
            You pay {fmtUnits(cost)} to win{" "}
            {fmtDollars(Number(shares))}
          </span>
        </div>
      </div>

      <button
        onClick={place}
        disabled={!canTrade}
        className={`w-full !py-3 text-base ${side === "yes" ? "btn bg-yes text-white hover:bg-yes/90" : "btn bg-no text-white hover:bg-no/90"}`}
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
      <p className="mt-2 text-center text-[11px] text-muted">
        Gasless — you sign, our relayer submits. Each share pays $1 if you&apos;re right.
      </p>
    </Sheet>
  );
}
