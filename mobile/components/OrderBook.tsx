import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useApi } from "../lib/api";
import { useTheme } from "../lib/theme";
import { useBookChannel } from "../lib/ws";
import type { BookLevel, OrderBookSummary } from "../lib/types";
import { Skeleton } from "./ui";

// Live order book: initial snapshot via REST, deltas via the shared WS
// book:{marketId} channel (spec §6.4). Rendered as YES / NO buy columns with
// depth bars, best price on top.

export function OrderBook({ marketId, compact }: { marketId: string; compact?: boolean }) {
  const api = useApi();
  const t = useTheme();
  const [book, setBook] = useState<OrderBookSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ book: OrderBookSummary }>(`/v1/markets/${marketId}/book`)
      .then((r) => setBook(r.book))
      .catch(() => setFailed(true));
  }, [api, marketId]);

  useEffect(load, [load]);

  useBookChannel(marketId, (e) => {
    if (e.type === "book.delta") {
      setBook((b) => ({
        market_id: marketId,
        yes: e.payload.yes ?? b?.yes ?? [],
        no: e.payload.no ?? b?.no ?? [],
        last_trade_price_cents: b?.last_trade_price_cents,
      }));
    } else if (e.type === "book.trade") {
      setBook((b) => (b ? { ...b, last_trade_price_cents: e.payload.price_cents } : b));
    }
  });

  if (failed) {
    return <Text style={{ color: t.textFaint, fontSize: 13 }}>Order book unavailable.</Text>;
  }
  if (!book) {
    return (
      <View style={{ gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} style={{ height: 22 }} />
        ))}
      </View>
    );
  }

  const rows = compact ? 4 : 8;
  const yes = (book.yes ?? []).slice(0, rows);
  const no = (book.no ?? []).slice(0, rows);
  const maxShares = Math.max(1, ...yes.map((l) => l.shares), ...no.map((l) => l.shares));

  return (
    <View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <BookColumn label="YES bids" color={t.yes} tint={t.yesTint} levels={yes} maxShares={maxShares} />
        {/* NO bids display as their YES-equivalent (100 − q) so both columns
            read on one price axis: a NO bid at 40¢ appears at 60¢ — exactly
            what a YES taker would pay to cross it. */}
        <BookColumn label="NO bids" color={t.no} tint={t.noTint} levels={no} maxShares={maxShares} complement />
      </View>
      {book.last_trade_price_cents != null ? (
        <Text style={{ color: t.textFaint, fontSize: 12, marginTop: 8, textAlign: "center" }}>
          Last trade {book.last_trade_price_cents}¢
        </Text>
      ) : null}
    </View>
  );
}

function BookColumn({
  label,
  color,
  tint,
  levels,
  maxShares,
  complement,
}: {
  label: string;
  color: string;
  tint: string;
  levels: BookLevel[];
  maxShares: number;
  // Display prices as 100 − p (NO bids on the YES price axis).
  complement?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: 3 }}>
      <Text style={{ color: t.textDim, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginBottom: 2 }}>
        {label.toUpperCase()}
      </Text>
      {levels.length === 0 ? (
        <Text style={{ color: t.textFaint, fontSize: 12 }}>No liquidity</Text>
      ) : (
        levels.map((l) => (
          <View key={l.price_cents} style={{ height: 22, justifyContent: "center" }}>
            <View
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${Math.max(6, (l.shares / maxShares) * 100)}%`,
                backgroundColor: tint,
                borderRadius: 4,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 6 }}>
              <Text style={{ color, fontWeight: "800", fontSize: 12.5 }}>
                {complement ? 100 - l.price_cents : l.price_cents}¢
              </Text>
              <Text style={{ color: t.textDim, fontSize: 12.5 }}>{l.shares}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}
