import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { CommentsList } from "../../components/CommentsList";
import { OrderBook } from "../../components/OrderBook";
import { ResolutionBlock, ResolutionCaption } from "../../components/Resolution";
import { SideBadge, StateChip } from "../../components/StateChip";
import { ErrorState, Loading, EmptyState } from "../../components/states";
import { SettleSheet, TradeSheet } from "../../components/TradeSheet";
import { useToasts } from "../../components/Toasts";
import { Avatar, Button, Segmented } from "../../components/ui";
import { errorMessage, useApi } from "../../lib/api";
import { cents, dollars, timeAgo } from "../../lib/format";
import { success } from "../../lib/haptics";
import { useSession } from "../../lib/session";
import { radius, space, useTheme } from "../../lib/theme";
import { useBookChannel } from "../../lib/ws";
import { CREATOR_MICROCOPY, pageItems, type Market, type Order, type Paged, type Position, type Post } from "../../lib/types";

// Market detail (spec §7): prices, live order book, buy/sell ticket, your
// positions/orders, Top Posts tab, Comments tab, and Advanced (public
// settlement query + "Settle market — 5¢").

export default function MarketDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const t = useTheme();
  const { me } = useSession();
  const [tab, setTab] = useState("Trade");
  const [tradeSide, setTradeSide] = useState<"yes" | "no" | null>(null);
  const [settling, setSettling] = useState(false);
  const [live, setLive] = useState<Partial<Market>>({});

  const q = useQuery({
    queryKey: ["market", id],
    enabled: !!id,
    queryFn: () => api.get<Market>(`/v1/markets/${id}`),
  });

  useBookChannel(id ?? null, (e) => {
    if (e.type === "book.delta") {
      setLive((m) => ({
        ...m,
        yes_price_cents: e.payload.yes_price_cents ?? m.yes_price_cents,
        no_price_cents: e.payload.no_price_cents ?? m.no_price_cents,
      }));
    } else if (e.type === "market.update") {
      setLive((m) => ({ ...m, status: e.payload.status, direction: e.payload.direction ?? m.direction }));
      q.refetch();
    }
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;

  const market: Market = { ...q.data, ...live };
  const isCreator = !!me && market.creator?.id === me.id;
  const microcopy = isCreator ? CREATOR_MICROCOPY[market.status] : undefined;
  const tradable = market.status === "OPEN" || market.status === "MATCHED";
  const canSettle = tradable;

  const header = (
    <View style={{ padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StateChip state={market.status} direction={market.direction} />
        <ResolutionCaption market={market} />
        <View style={{ flex: 1 }} />
        <Text style={{ color: t.textFaint, fontSize: 12.5 }}>{dollars(market.volume)} vol</Text>
      </View>
      <Text style={{ color: t.text, fontWeight: "800", fontSize: 19, lineHeight: 25 }}>{market.question}</Text>
      {microcopy ? (
        <Text style={{ color: market.status === "MATCHED" ? t.yes : t.blue, fontSize: 13.5, fontWeight: "600" }}>
          {microcopy}
        </Text>
      ) : null}
      {market.creator ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Avatar url={market.creator.avatar_url} size={24} />
          <Text style={{ color: t.textDim, fontSize: 13 }}>
            by @{market.creator.username} · {timeAgo(market.created_at)}
          </Text>
        </View>
      ) : null}

      {/* Big price buttons */}
      {tradable || market.status === "SETTLING" ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          {(["yes", "no"] as const).map((s) => {
            const color = s === "yes" ? t.yes : t.no;
            const price = s === "yes" ? market.yes_price_cents : market.no_price_cents;
            return (
              <Pressable
                key={s}
                disabled={!tradable}
                onPress={() => setTradeSide(s)}
                style={{
                  flex: 1,
                  backgroundColor: s === "yes" ? t.yesTint : t.noTint,
                  borderRadius: radius.lg,
                  paddingVertical: 16,
                  alignItems: "center",
                  gap: 2,
                  opacity: tradable ? 1 : 0.5,
                }}
              >
                <Text style={{ color, fontWeight: "900", fontSize: 20 }}>{s.toUpperCase()}</Text>
                <Text style={{ color, fontWeight: "700", fontSize: 14 }}>{cents(price)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : market.status === "SETTLED" && market.direction != null ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: t.surfaceAlt, borderRadius: radius.lg, padding: space.md }}>
          <SideBadge side={market.direction ? "yes" : "no"} />
          <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }}>
            Settled {market.direction ? "YES" : "NO"}. Winners redeem $1 per share.
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {tab === "Comments" ? (
        <CommentsList
          subjectType="market"
          subjectId={market.id}
          header={
            <>
              {header}
              <Segmented options={["Trade", "Top Posts", "Comments"]} value={tab} onChange={setTab} />
            </>
          }
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
          {header}
          <Segmented options={["Trade", "Top Posts", "Comments"]} value={tab} onChange={setTab} />
          {tab === "Trade" ? (
            <TradeTab market={market} canSettle={canSettle} onSettle={() => setSettling(true)} />
          ) : (
            <TopPosts marketId={market.id} />
          )}
        </ScrollView>
      )}

      {tradeSide ? (
        <TradeSheet visible onClose={() => setTradeSide(null)} market={market} initialSide={tradeSide} onPlaced={() => q.refetch()} />
      ) : null}
      <SettleSheet visible={settling} onClose={() => setSettling(false)} market={market} onSettled={() => q.refetch()} />
    </View>
  );
}

function TradeTab({ market, canSettle, onSettle }: { market: Market; canSettle: boolean; onSettle: () => void }) {
  const t = useTheme();
  const api = useApi();
  const { me } = useSession();
  const toasts = useToasts();
  const [advanced, setAdvanced] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemed, setRedeemed] = useState(false);

  const positions = useQuery({
    queryKey: ["positions", market.id],
    enabled: !!me,
    queryFn: () => api.get<Paged<Position>>(`/v1/positions?market=${market.id}`),
  });
  const orders = useQuery({
    queryKey: ["orders", market.id],
    enabled: !!me,
    queryFn: () => api.get<Paged<Order>>(`/v1/orders?market=${market.id}`),
  });

  const myPositions = pageItems<Position>(positions.data);
  const myOrders = pageItems<Order>(orders.data).filter(
    (o) => o.status === "RESTING" || o.status === "PARTIAL" || o.status === "QUEUED"
  );

  // Winners redeem $1/share after settlement (minus the flat withdrawal fee).
  const winningShares =
    market.status === "SETTLED" && market.direction != null
      ? myPositions
          .filter((p) => p.side === (market.direction ? "yes" : "no"))
          .reduce((n, p) => n + p.shares, 0)
      : 0;

  const redeem = async () => {
    setRedeeming(true);
    try {
      await api.post(`/v1/markets/${market.id}/redeem`);
      setRedeemed(true);
      success();
      toasts.show({ title: "Redeemed", body: `${dollars(winningShares)} on the way to your wallet.`, icon: "cash" });
      positions.refetch();
    } catch (e) {
      toasts.show({ title: "Couldn't redeem", body: errorMessage(e), icon: "alert-circle" });
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <View style={{ padding: space.lg, gap: space.lg }}>
      {/* Live order book */}
      <View style={{ gap: 8 }}>
        <Text style={sectionTitle(t)}>ORDER BOOK · LIVE</Text>
        <OrderBook marketId={market.id} />
      </View>

      {/* My positions */}
      {myPositions.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={sectionTitle(t)}>YOUR POSITION</Text>
          {myPositions.map((p) => (
            <View key={`${p.market_id}-${p.side}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <SideBadge side={p.side} size="sm" />
              <Text style={{ color: t.text, fontSize: 13.5 }}>
                {p.shares} shares @ {cents(p.avg_price_cents)}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={{ color: (p.unrealized_pnl ?? p.realized_pnl) >= 0 ? t.yes : t.no, fontWeight: "800" }}>
                {dollars(p.unrealized_pnl ?? p.realized_pnl, { sign: true })}
              </Text>
            </View>
          ))}
          {winningShares > 0 && !redeemed ? (
            <Button
              title={`Redeem ${dollars(winningShares)}`}
              variant="yes"
              small
              loading={redeeming}
              onPress={redeem}
            />
          ) : null}
        </View>
      ) : null}

      {/* My open orders */}
      {myOrders.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={sectionTitle(t)}>YOUR OPEN ORDERS</Text>
          {myOrders.map((o) => (
            <OpenOrderRow key={o.id} order={o} />
          ))}
        </View>
      ) : null}

      {/* Advanced: settlement query + settle */}
      <Pressable onPress={() => setAdvanced((a) => !a)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Ionicons name={advanced ? "chevron-down" : "chevron-forward"} size={16} color={t.textDim} />
        <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>Advanced</Text>
      </Pressable>
      {advanced ? (
        <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.lg, padding: space.md }}>
          <ResolutionBlock market={market} />
          {canSettle ? <Button title="Settle market — 5¢" variant="accent" small onPress={onSettle} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function OpenOrderRow({ order }: { order: Order }) {
  const t = useTheme();
  const api = useApi();
  const [canceled, setCanceled] = useState(false);
  const [busy, setBusy] = useState(false);
  if (canceled) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <SideBadge side={order.side} size="sm" />
      <Text style={{ color: t.text, fontSize: 13.5 }}>
        {order.shares - order.filled_shares} @ {cents(order.price_cents)}
      </Text>
      <StateChip state={order.status} size="sm" />
      <View style={{ flex: 1 }} />
      <Pressable
        disabled={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await api.del(`/v1/orders/${order.id}`);
            setCanceled(true);
          } catch {
            /* leave row */
          } finally {
            setBusy(false);
          }
        }}
        hitSlop={8}
      >
        <Text style={{ color: t.mutedRed, fontWeight: "700", fontSize: 12.5, opacity: busy ? 0.5 : 1 }}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function TopPosts({ marketId }: { marketId: string }) {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();

  const q = useQuery({
    queryKey: ["market-posts", marketId],
    queryFn: () => api.get<Paged<Post>>(`/v1/markets/${marketId}/posts?limit=12`),
  });

  if (q.isLoading) return <Loading />;
  const posts = pageItems<Post>(q.data);
  if (posts.length === 0) {
    return <EmptyState icon="images-outline" title="No posts yet" subtitle="Posts that feature this market show up here." />;
  }
  return (
    <View style={{ padding: space.md, gap: 10 }}>
      {posts.map((p) => (
        <Pressable
          key={p.id}
          onPress={() => router.push(`/post/${p.id}` as never)}
          style={{ flexDirection: "row", gap: 10, alignItems: "center", borderWidth: 1, borderColor: t.border, borderRadius: radius.md, padding: 8 }}
        >
          <Image source={{ uri: p.media[0]?.url }} style={{ width: 54, height: 54, borderRadius: 8, backgroundColor: t.surfaceAlt }} contentFit="cover" />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: "700", fontSize: 13.5 }}>@{p.author.username}</Text>
            <Text style={{ color: t.textDim, fontSize: 12.5 }} numberOfLines={2}>
              {p.caption ?? ""}
            </Text>
          </View>
          <Text style={{ color: t.textFaint, fontSize: 12 }}>{timeAgo(p.created_at)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const sectionTitle = (t: ReturnType<typeof useTheme>) => ({
  color: t.textDim,
  fontWeight: "800" as const,
  fontSize: 11.5,
  letterSpacing: 0.8,
});
