"use client";

// Live order book: seeds from GET /v1/markets/{id}/book, then applies WS
// book:{marketId} snapshots (spec §6.4). Two-sided YES/NO bid ladder with
// depth bars; execution is at the maker's price (spec §4.2).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { useChannel } from "@/lib/ws";
import { Skeleton } from "@/components/Skeleton";
import { fmtCents } from "@/lib/format";
import type { OrderBook as Book } from "@/lib/types";

export function OrderBook({ marketId, compact = false }: { marketId: string; compact?: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["book", marketId],
    queryFn: () => api.get<{ book: Book }>(`/v1/markets/${marketId}/book`),
  });

  useChannel(`book:${marketId}`, (frame) => {
    if (frame.type === "book") {
      queryClient.setQueryData(["book", marketId], { book: frame.payload });
    }
  });

  if (isLoading) {
    return (
      <div className="space-y-1.5" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  const book = data?.book;
  const rows = compact ? 4 : 8;
  const yes = (book?.yes ?? []).slice(0, rows);
  const no = (book?.no ?? []).slice(0, rows);
  const maxShares = Math.max(
    1,
    ...yes.map((l) => l.shares),
    ...no.map((l) => l.shares),
  );

  if (yes.length === 0 && no.length === 0) {
    return (
      <p className="py-3 text-center text-sm text-muted">
        No resting orders yet — be the first to quote.
      </p>
    );
  }

  const Ladder = ({
    levels,
    color,
    label,
  }: {
    levels: { price_cents: number; shares: number }[];
    color: "yes" | "no";
    label: string;
  }) => (
    <div className="min-w-0 flex-1">
      <p
        className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${
          color === "yes" ? "text-yes" : "text-no"
        }`}
      >
        {label}
      </p>
      <ul className="space-y-0.5" aria-label={`${label} bids`}>
        {levels.length === 0 && (
          <li className="py-1 text-xs text-muted">—</li>
        )}
        {levels.map((l) => (
          <li key={l.price_cents} className="relative overflow-hidden rounded-md">
            <span
              aria-hidden
              className={`absolute inset-y-0 ${color === "yes" ? "left-0 bg-yes/10" : "right-0 bg-no/10"}`}
              style={{ width: `${(l.shares / maxShares) * 100}%` }}
            />
            <span className="relative flex justify-between px-1.5 py-0.5 font-mono text-xs tabular-nums">
              <span className={color === "yes" ? "text-yes" : "text-no"}>
                {fmtCents(l.price_cents)}
              </span>
              <span className="text-muted">{l.shares.toLocaleString()}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div>
      <div className="flex gap-4">
        <Ladder levels={yes} color="yes" label="Buy YES" />
        <Ladder levels={no} color="no" label="Buy NO" />
      </div>
      {book?.last_trade_price_cents != null && (
        <p className="mt-2 text-[11px] text-muted">
          Last trade {fmtCents(book.last_trade_price_cents)}
        </p>
      )}
    </div>
  );
}
