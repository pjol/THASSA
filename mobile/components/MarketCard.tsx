import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { dollars } from "../lib/format";
import { useSession } from "../lib/session";
import { radius, space, useTheme } from "../lib/theme";
import { useBookChannel } from "../lib/ws";
import { CREATOR_MICROCOPY, type Market, type Position, type Side } from "../lib/types";
import { OrderBook } from "./OrderBook";
import { ResolutionBlock, ResolutionCaption } from "./Resolution";
import { SideBadge, StateChip } from "./StateChip";
import { SettleSheet, TradeSheet } from "./TradeSheet";

// The market card attached to a post (spec §7): question, one-word state chip,
// YES/NO quick-buy price buttons, poster's position badge, settled direction +
// poster PnL, and an Advanced expander with limit orders, the live order book,
// the public settlement query, and the "Settle market — 5¢" button. Orders
// placed here carry the post id as affiliate attribution.

export function MarketCard({
  market: initial,
  affiliatePostId,
  affiliateId,
  posterPosition,
  posterPnl,
  posterUsername,
  standalone,
}: {
  market: Market;
  affiliatePostId?: string | null;
  affiliateId?: number | null;
  posterPosition?: Position | null;
  posterPnl?: number | null;
  posterUsername?: string;
  standalone?: boolean;
}) {
  const t = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const [market, setMarket] = useState(initial);
  const [advanced, setAdvanced] = useState(false);
  const [tradeSide, setTradeSide] = useState<Side | null>(null);
  const [settling, setSettling] = useState(false);

  // Keep prices/status live while the card is on screen (advanced expanded
  // subscribes the book channel; the delta payload carries best prices).
  useBookChannel(advanced ? market.id : null, (e) => {
    if (e.type === "book.delta") {
      setMarket((m) => ({
        ...m,
        yes_price_cents: e.payload.yes_price_cents ?? m.yes_price_cents,
        no_price_cents: e.payload.no_price_cents ?? m.no_price_cents,
      }));
    } else if (e.type === "market.update") {
      setMarket((m) => ({ ...m, status: e.payload.status, direction: e.payload.direction ?? m.direction }));
    }
  });

  const isCreator = !!me && market.creator?.id === me.id;
  const microcopy = isCreator ? CREATOR_MICROCOPY[market.status] : undefined;
  const settled = market.status === "SETTLED";
  const canSettle = market.status === "OPEN" || market.status === "MATCHED";

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: radius.lg,
        padding: space.md,
        gap: 10,
        backgroundColor: t.surface,
      }}
    >
      <Pressable
        onPress={() => (standalone ? undefined : router.push(`/market/${market.id}` as never))}
        style={{ gap: 8 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="stats-chart" size={14} color={t.blue} />
          <StateChip state={market.status} direction={market.direction} size="sm" />
          <ResolutionCaption market={market} />
          <View style={{ flex: 1 }} />
          <Text style={{ color: t.textFaint, fontSize: 12 }}>{dollars(market.volume)} vol</Text>
        </View>
        <Text style={{ color: t.text, fontWeight: "700", fontSize: 15, lineHeight: 20 }}>
          {market.question}
        </Text>
      </Pressable>

      {microcopy ? (
        <Text style={{ color: market.status === "MATCHED" ? t.yes : t.blue, fontSize: 13, fontWeight: "600" }}>
          {microcopy}
        </Text>
      ) : null}

      {/* Poster's position badge (hidden server-side when trades are private). */}
      {posterPosition ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <SideBadge side={posterPosition.side} size="sm" />
          <Text style={{ color: t.textDim, fontSize: 12.5 }}>
            {posterUsername ? `@${posterUsername} holds ` : "Holds "}
            {posterPosition.shares} share{posterPosition.shares === 1 ? "" : "s"} @{" "}
            {posterPosition.avg_price_cents}¢
          </Text>
          {settled && posterPnl != null ? (
            <Text style={{ color: posterPnl >= 0 ? t.yes : t.no, fontWeight: "800", fontSize: 12.5 }}>
              {dollars(posterPnl, { sign: true })}
            </Text>
          ) : null}
        </View>
      ) : settled && posterPnl != null ? (
        <Text style={{ color: posterPnl >= 0 ? t.yes : t.no, fontWeight: "800", fontSize: 13 }}>
          {posterUsername ? `@${posterUsername} ` : ""}
          {dollars(posterPnl, { sign: true })} on this market
        </Text>
      ) : null}

      {/* YES/NO quick-buy, or the outcome once settled. */}
      {!settled && market.status !== "VOID" ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <PriceButton
            label="YES"
            price={market.yes_price_cents}
            color={t.yes}
            tint={t.yesTint}
            disabled={market.status === "SETTLING"}
            onPress={() => setTradeSide("yes")}
          />
          <PriceButton
            label="NO"
            price={market.no_price_cents}
            color={t.no}
            tint={t.noTint}
            disabled={market.status === "SETTLING"}
            onPress={() => setTradeSide("no")}
          />
        </View>
      ) : null}

      {/* Advanced: order book + public settlement query + settle button. */}
      <Pressable onPress={() => setAdvanced((a) => !a)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Ionicons name={advanced ? "chevron-down" : "chevron-forward"} size={15} color={t.textDim} />
        <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 12.5 }}>Advanced</Text>
      </Pressable>
      {advanced ? (
        <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
          {!settled ? <OrderBook marketId={market.id} compact /> : null}
          <ResolutionBlock market={market} />
          {canSettle ? (
            <Pressable
              onPress={() => setSettling(true)}
              style={{ alignSelf: "flex-start", backgroundColor: t.accent, borderRadius: radius.full, paddingVertical: 8, paddingHorizontal: 14 }}
            >
              <Text style={{ color: t.onAccent, fontWeight: "800", fontSize: 13 }}>Settle market — 5¢</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {tradeSide ? (
        <TradeSheet
          visible
          onClose={() => setTradeSide(null)}
          market={market}
          initialSide={tradeSide}
          affiliatePostId={affiliatePostId}
          affiliateId={affiliateId}
        />
      ) : null}
      <SettleSheet
        visible={settling}
        onClose={() => setSettling(false)}
        market={market}
        onSettled={() => setMarket((m) => ({ ...m, status: "SETTLING" }))}
      />
    </View>
  );
}

function PriceButton({
  label,
  price,
  color,
  tint,
  onPress,
  disabled,
}: {
  label: string;
  price: number | null;
  color: string;
  tint: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flex: 1,
        backgroundColor: tint,
        borderRadius: radius.md,
        paddingVertical: 11,
        alignItems: "center",
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontWeight: "800", fontSize: 15 }}>
        {label} {price != null ? `${price}¢` : "—"}
      </Text>
    </Pressable>
  );
}
