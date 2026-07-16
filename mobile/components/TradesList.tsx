import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi, ApiError } from "../lib/api";
import { cents, dollars, timeAgo } from "../lib/format";
import { space, useTheme } from "../lib/theme";
import { nextCursorOf, pageItems, type Paged, type Trade } from "../lib/types";
import { EmptyState, Loading } from "./states";
import { SideBadge, StateChip } from "./StateChip";
import { Skeleton } from "./ui";

// Trade history rows for the profile Trades tab (spec §7): market question,
// side, price, shares, state chip, PnL when settled. Respects trades
// visibility — a 403 renders the private state.

export function useTrades(username: string | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ["trades", username],
    enabled: !!username,
    queryFn: ({ pageParam }) =>
      api.get<Paged<Trade>>(
        `/v1/users/${username}/trades?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`
      ),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && count < 2,
  });
}

export function TradeRow({ trade }: { trade: Trade }) {
  const t = useTheme();
  const router = useRouter();
  const settled = trade.market_status === "SETTLED";
  return (
    <Pressable
      onPress={() => router.push(`/market/${trade.market_id}` as never)}
      style={{
        paddingHorizontal: space.md,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: t.border,
        gap: 7,
      }}
    >
      <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }} numberOfLines={2}>
        {trade.market_question}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <SideBadge side={trade.side} size="sm" />
        <Text style={{ color: t.textDim, fontSize: 13 }}>
          {trade.shares} × {cents(trade.price_cents)}
        </Text>
        <StateChip state={trade.market_status} direction={trade.market_direction} size="sm" />
        <View style={{ flex: 1 }} />
        {settled && trade.pnl != null ? (
          <Text style={{ color: trade.pnl >= 0 ? t.yes : t.no, fontWeight: "800", fontSize: 14 }}>
            {dollars(trade.pnl, { sign: true })}
          </Text>
        ) : (
          <Text style={{ color: t.textFaint, fontSize: 12 }}>{timeAgo(trade.created_at)}</Text>
        )}
      </View>
    </Pressable>
  );
}

export function TradesTabContent({ username, hidden }: { username: string; hidden?: boolean }) {
  const t = useTheme();
  const q = useTrades(hidden ? null : username);

  if (hidden || (q.error instanceof ApiError && q.error.status === 403)) {
    return (
      <EmptyState icon="lock-closed-outline" title="Trades are private" subtitle="This account keeps its trading history private." />
    );
  }
  if (q.isLoading) {
    return (
      <View style={{ padding: space.md, gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} style={{ height: 64 }} />
        ))}
      </View>
    );
  }
  if (q.isError) return <Loading label="Couldn't load trades." />;
  const trades = q.data?.pages.flatMap((p) => pageItems<Trade>(p)) ?? [];
  if (trades.length === 0) {
    return <EmptyState icon="stats-chart-outline" title="No trades yet" subtitle="Bets show up here once placed." />;
  }
  return (
    <View>
      {trades.map((tr) => (
        <TradeRow key={tr.id} trade={tr} />
      ))}
      {q.hasNextPage ? (
        <Text
          onPress={() => q.fetchNextPage()}
          style={{ color: t.blue, textAlign: "center", padding: space.md, fontWeight: "700" }}
        >
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </Text>
      ) : null}
    </View>
  );
}
