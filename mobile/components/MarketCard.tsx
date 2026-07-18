import React, { useMemo, useState } from "react";
import { LayoutAnimation, Platform, Pressable, Text, TextInput, UIManager, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage, useApi } from "../lib/api";
import { useWallet } from "../lib/auth";
import { dollars } from "../lib/format";
import { success, warn } from "../lib/haptics";
import { useSession } from "../lib/session";
import {
  buildOrder,
  maxCostUnits,
  payToWin,
  sharesForSpend,
  signReceiveAuthorization,
} from "../lib/signing";
import { radius, space, useTheme } from "../lib/theme";
import { useBookChannel } from "../lib/ws";
import { CREATOR_MICROCOPY, type Market, type Order, type OrderState, type Position, type Side } from "../lib/types";
import { OrderBook } from "./OrderBook";
import { MarketDetails } from "./MarketDetails";
import { SideBadge, StateChip } from "./StateChip";
import { SettleSheet } from "./TradeSheet";
import { Button, useInputStyle } from "./ui";
import { useToasts } from "./Toasts";

// The market widget attached to a post (spec §7), in three tiers:
//   • Collapsed — a pure preview and HARD RULE: exactly ONE line, always.
//     Tradable: terse title + compact YES/NO prices. Settled: terse title +
//     poster PnL + position side + direction, all inline on the same line.
//     Nothing below the line until the card is expanded.
//   • First expansion (tap anywhere, or pick a side) — the market in full:
//     the long-form question (shown once, replacing the terse title), BIG
//     YES/NO buttons (replacing the compact pills), the amount + limit-price
//     trade specs inline (no separate trading state), a compact live order
//     book, and a small volume indicator. Submitting walks SIGNING → QUEUED.
//   • "Full market details" (only visible once expanded) — informational:
//     how the market settles, creator, ids. No fees, no repeated question/
//     prices/book (the first tier already shows those).
// Every tier change animates via LayoutAnimation. Orders placed here carry
// the post id as affiliate attribution.

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animate = () =>
  LayoutAnimation.configureNext(
    LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity)
  );

const QUICK_AMOUNTS = [5, 10, 25, 50];

export function MarketCard({
  market: initial,
  affiliatePostId,
  affiliateId,
  posterPosition,
  posterPnl,
  posterUsername,
  standalone,
  fullBleed,
}: {
  market: Market;
  affiliatePostId?: string | null;
  affiliateId?: number | null;
  posterPosition?: Position | null;
  posterPnl?: number | null;
  posterUsername?: string;
  standalone?: boolean;
  // Full-bleed variant (post cards): the card runs edge-to-edge, so side
  // borders and corner radii are dropped.
  fullBleed?: boolean;
}) {
  const t = useTheme();
  const router = useRouter();
  const api = useApi();
  const { me } = useSession();
  const { ensureWallet } = useWallet();
  const toasts = useToasts();
  const queryClient = useQueryClient();
  const inputStyle = useInputStyle();

  const [market, setMarket] = useState(initial);
  // Tap anywhere (or pick a side) to expand tier 1; standalone starts open.
  const [expanded, setExpanded] = useState(!!standalone);
  const [side, setSide] = useState<Side | null>(null);
  const [amount, setAmount] = useState("10");
  const [limitInput, setLimitInput] = useState("");
  const [stage, setStage] = useState<"idle" | OrderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false); // tier 2: informational
  const [settling, setSettling] = useState(false);

  // Keep prices/status live while the card is expanded; the book delta payload
  // carries best prices, market.update carries status.
  useBookChannel(expanded ? market.id : null, (e) => {
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
  const tradable =
    market.status === "OPEN" || market.status === "MATCHED" || market.status === "SETTLING"; // SETTLING stays tradable

  const clampCents = (n: number) => Math.min(99, Math.max(1, n));
  const marketPrice = (side === "no" ? market.no_price_cents : market.yes_price_cents) ?? 50;
  const price = useMemo(() => {
    const parsed = limitInput ? parseInt(limitInput, 10) : marketPrice;
    return clampCents(Number.isFinite(parsed) ? parsed : marketPrice);
  }, [limitInput, marketPrice]);

  const spend = parseFloat(amount) || 0;
  const shares = sharesForSpend(spend, price);
  const { pay, win } = payToWin(shares, price);
  const busy = stage === "SIGNING" || stage === "QUEUED";
  const canSubmit = tradable && side != null && shares > 0 && !busy;

  const resetTrade = () => {
    setSide(null);
    setLimitInput("");
    setStage("idle");
    setError(null);
  };

  const toggleExpand = () => {
    animate();
    setExpanded((e) => {
      if (e) {
        setDetails(false);
        resetTrade();
      }
      return !e;
    });
  };

  // Picking a side (from the collapsed pills or the big buttons) always lands
  // in the first expansion with that side selected; re-tapping deselects.
  const pick = (s: Side) => {
    if (!tradable) return;
    animate();
    setStage("idle");
    setError(null);
    setSide((cur) => (cur === s ? null : s));
    setExpanded(true);
  };

  const toggleDetails = () => {
    animate();
    setDetails((d) => !d);
  };

  const submit = async () => {
    if (!canSubmit || side == null) return;
    setError(null);
    setStage("SIGNING");
    try {
      const wallet = await ensureWallet();
      // Access tokens don't always carry a wallet claim — make sure the
      // backend has this wallet linked before it validates the order.
      await api.post("/v1/me/wallet", { address: wallet.address }).catch(() => {});
      // Next EIP-712 maker nonce comes from the wallet endpoint (web parity).
      const { wallet: { order_nonce } } = await api.get<{ wallet: { order_nonce: number } }>("/v1/wallet");
      const maxCost = maxCostUnits(shares, price);
      // Single-signature carriage: the order's EIP-712 digest rides as the
      // EIP-3009 auth nonce, so one funding signature binds the order terms too.
      const order = buildOrder(wallet.address, {
        chainMarketId: market.chain_market_id,
        side,
        priceCents: price,
        shares,
        maxCost,
        affiliatePostId: BigInt(affiliateId ?? 0), // numeric onchain post id
        nonce: order_nonce,
      });
      const auth = await signReceiveAuthorization(wallet, { value: maxCost, nonce: order.digest });
      setStage("QUEUED");
      // Flat wire shape (backend orderPayload — unknown fields are rejected):
      // numeric max_cost/nonce, no maker (derived server-side from the auth).
      await api.post<{ order: Order }>("/v1/orders", {
        market_id: market.id,
        side,
        price_cents: price,
        shares,
        max_cost: Number(maxCost),
        expiry: order.message.expiry,
        nonce: order_nonce,
        auth,
        affiliate_post_id: affiliatePostId ?? null,
        affiliate_id: affiliateId != null ? String(affiliateId) : null,
      });
      success();
      toasts.show({
        title: "Order placed",
        body: `${side.toUpperCase()} · ${shares} share${shares === 1 ? "" : "s"} @ ${price}¢`,
        icon: "checkmark-circle",
      });
      queryClient.invalidateQueries({ queryKey: ["book", market.id] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      animate();
      resetTrade();
    } catch (e) {
      warn();
      setError(errorMessage(e));
      setStage("idle");
    }
  };

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: fullBleed ? 0 : radius.lg,
        borderLeftWidth: fullBleed ? 0 : 1,
        borderRightWidth: fullBleed ? 0 : 1,
        padding: space.md,
        gap: 10,
        backgroundColor: t.surface,
      }}
    >
      {/* ── Header. Collapsed: terse title + compact prices (pure preview).
          Expanded: the full question, shown exactly once. ── */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable style={{ flex: 1 }} onPress={toggleExpand}>
          <Text style={{ color: t.text, fontWeight: "700", fontSize: 15, lineHeight: 20 }} numberOfLines={expanded ? undefined : 1}>
            {expanded ? market.question : (market.title || market.question)}
          </Text>
        </Pressable>

        {settled ? (
          // Single-line rule: just PnL + the chosen side — the outcome is
          // inferable from that pair. The direction pill only appears as a
          // fallback when there is no position to infer from.
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {posterPnl != null ? (
              <Text style={{ color: posterPnl >= 0 ? t.yes : t.no, fontWeight: "800", fontSize: 13 }}>
                {dollars(posterPnl, { sign: true })}
              </Text>
            ) : null}
            {posterPosition ? (
              <SideBadge side={posterPosition.side} size="sm" />
            ) : posterPnl == null ? (
              market.resolved_fifty ? (
                <View style={{ backgroundColor: t.grayTint, paddingVertical: 5, paddingHorizontal: 11, borderRadius: radius.full }}>
                  <Text style={{ color: t.textDim, fontWeight: "800", fontSize: 12.5 }}>50/50</Text>
                </View>
              ) : (
                <View
                  style={{
                    backgroundColor: market.direction ? t.yesTint : t.noTint,
                    paddingVertical: 5,
                    paddingHorizontal: 11,
                    borderRadius: radius.full,
                  }}
                >
                  <Text style={{ color: market.direction ? t.yes : t.no, fontWeight: "800", fontSize: 12.5 }}>
                    {market.direction ? "YES" : "NO"}
                  </Text>
                </View>
              )
            ) : null}
          </View>
        ) : !tradable ? (
          <StateChip state={market.status} direction={market.direction} size="sm" />
        ) : !expanded ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <PricePill label="YES" price={market.yes_price_cents} color={t.yes} tint={t.yesTint} onPress={() => pick("yes")} />
            <PricePill label="NO" price={market.no_price_cents} color={t.no} tint={t.noTint} onPress={() => pick("no")} />
          </View>
        ) : (
          <Pressable onPress={toggleExpand} hitSlop={8}>
            <Ionicons name="chevron-up" size={18} color={t.textDim} />
          </Pressable>
        )}
      </View>

      {expanded ? (
        <>
          {/* SETTLED detail: whose PnL, and the full position line. */}
          {settled && posterPnl != null ? (
            <Text style={{ color: t.textDim, fontSize: 13, fontWeight: "600" }}>
              {posterUsername ? `@${posterUsername} ` : ""}
              <Text style={{ color: posterPnl >= 0 ? t.yes : t.no, fontWeight: "800" }}>
                {dollars(posterPnl, { sign: true })}
              </Text>
            </Text>
          ) : null}
          {posterPosition ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <SideBadge side={posterPosition.side} size="sm" />
              <Text style={{ color: t.textDim, fontSize: 12.5 }}>
                {posterUsername ? `@${posterUsername} holds ` : "Holds "}
                {posterPosition.shares} share{posterPosition.shares === 1 ? "" : "s"} @ {posterPosition.avg_price_cents}¢
              </Text>
            </View>
          ) : null}

          {/* Creator microcopy (OPEN "committed…" / MATCHED "taken"). */}
          {microcopy ? (
            <Text style={{ color: market.status === "MATCHED" ? t.yes : t.blue, fontSize: 13, fontWeight: "600" }}>
              {microcopy}
            </Text>
          ) : null}

          {/* ── Tier 1: the market itself — big side buttons, trade specs, book ── */}
          {tradable ? (
            <>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <BigSideButton
                  label="YES"
                  price={market.yes_price_cents}
                  color={t.yes}
                  tint={t.yesTint}
                  active={side === "yes"}
                  onPress={() => pick("yes")}
                />
                <BigSideButton
                  label="NO"
                  price={market.no_price_cents}
                  color={t.no}
                  tint={t.noTint}
                  active={side === "no"}
                  onPress={() => pick("no")}
                />
              </View>

              {/* Trade specs — always present in the first expansion. */}
              <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1.4 }}>
                    <Text style={fieldLabel(t)}>AMOUNT</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ color: t.text, fontSize: 18, fontWeight: "800" }}>$</Text>
                      <TextInput
                        style={[inputStyle, { flex: 1, fontSize: 17, fontWeight: "700" }]}
                        keyboardType="decimal-pad"
                        value={amount}
                        onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
                        placeholder="0"
                        placeholderTextColor={t.textFaint}
                      />
                    </View>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={fieldLabel(t)}>LIMIT PRICE (¢)</Text>
                    <TextInput
                      style={[inputStyle, { fontWeight: "700" }]}
                      keyboardType="number-pad"
                      value={limitInput}
                      onChangeText={(v) => setLimitInput(v.replace(/[^0-9]/g, ""))}
                      placeholder={String(marketPrice)}
                      placeholderTextColor={t.textFaint}
                    />
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {QUICK_AMOUNTS.map((a) => {
                    const on = amount === String(a);
                    return (
                      <Pressable
                        key={a}
                        onPress={() => setAmount(String(a))}
                        style={{
                          backgroundColor: on ? t.accent : t.grayTint,
                          borderRadius: radius.full,
                          paddingVertical: 7,
                          paddingHorizontal: 13,
                        }}
                      >
                        <Text style={{ color: on ? t.onAccent : t.textDim, fontWeight: "700", fontSize: 13 }}>${a}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                {side != null && shares > 0 ? (
                  <Text style={{ color: t.text, fontWeight: "700", fontSize: 13.5 }}>
                    {shares} share{shares === 1 ? "" : "s"} — you pay <Text style={{ fontWeight: "800" }}>{dollars(pay)}</Text> to win{" "}
                    <Text style={{ color: side === "yes" ? t.yes : t.no, fontWeight: "800" }}>{dollars(win)}</Text>
                  </Text>
                ) : null}

                {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : null}

                {/* Loading state lives IN the button: spinner + stage copy. */}
                <Button
                  title={
                    stage === "SIGNING"
                      ? "Confirm in your wallet…"
                      : stage === "QUEUED"
                        ? "Submitting…"
                        : side
                          ? `Buy ${side.toUpperCase()} at ${price}¢`
                          : "Pick a side"
                  }
                  variant={side ?? "primary"}
                  disabled={!canSubmit}
                  loading={busy}
                  onPress={submit}
                />
              </View>

              {/* Order book preview. */}
              <OrderBook marketId={market.id} compact />
            </>
          ) : null}

          {market.status === "SETTLING" ? (
            <Text style={{ color: t.amber, fontWeight: "600", fontSize: 12.5 }}>
              Settlement query is running…
            </Text>
          ) : null}

          {settled && market.resolved_fifty ? (
            <Text style={{ color: t.textDim, fontWeight: "600", fontSize: 12.5 }}>
              Expired before settlement — resolved 50/50 (each share pays 50¢).
            </Text>
          ) : null}

          {/* ── Tier 2 toggle: only visible once expanded. Small volume
              indicator lives here, with the open-market-page affordance. ── */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Pressable onPress={toggleDetails} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name={details ? "chevron-down" : "chevron-forward"} size={15} color={t.blue} />
              <Text style={{ color: t.blue, fontWeight: "700", fontSize: 12.5 }}>Full market details</Text>
            </Pressable>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Text style={{ color: t.textFaint, fontSize: 12 }}>Vol {dollars(market.volume)}</Text>
              {!standalone ? (
                <Pressable onPress={() => router.push(`/market/${market.id}` as never)} hitSlop={8}>
                  <Ionicons name="open-outline" size={16} color={t.textDim} />
                </Pressable>
              ) : null}
            </View>
          </View>

          {details ? (
            <View style={{ gap: space.md }}>
              {/* Informational tier: settlement, creator, ids — no question/
                  prices/book/fees repeats (tier 1 owns those). */}
              <MarketDetails market={market} info />
              {tradable ? (
                <Pressable
                  onPress={() => setSettling(true)}
                  style={{
                    alignSelf: "flex-start",
                    backgroundColor: t.accent,
                    borderRadius: radius.full,
                    paddingVertical: 8,
                    paddingHorizontal: 14,
                  }}
                >
                  <Text style={{ color: t.onAccent, fontWeight: "800", fontSize: 13 }}>Settle market — 5¢</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </>
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

// Compact YES/NO price pill on the collapsed preview line: "YES 12¢".
function PricePill({
  label,
  price,
  color,
  tint,
  onPress,
}: {
  label: string;
  price: number | null;
  color: string;
  tint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: tint,
        borderRadius: radius.full,
        paddingVertical: 6,
        paddingHorizontal: 11,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontWeight: "800", fontSize: 13 }}>{label}</Text>
      <Text style={{ color, fontWeight: "800", fontSize: 13 }}>{price != null ? `${price}¢` : "—"}</Text>
    </Pressable>
  );
}

// Big YES/NO side buttons in the first expansion — the collapsed pills grow
// into these (never both at once).
function BigSideButton({
  label,
  price,
  color,
  tint,
  active,
  onPress,
}: {
  label: string;
  price: number | null;
  color: string;
  tint: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: "center",
        gap: 2,
        backgroundColor: tint,
        borderRadius: radius.md,
        paddingVertical: 13,
        borderWidth: 2,
        borderColor: active ? color : "transparent",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color, fontWeight: "800", fontSize: 12, letterSpacing: 0.6 }}>{label}</Text>
      <Text style={{ color, fontWeight: "800", fontSize: 20 }}>{price != null ? `${price}¢` : "—"}</Text>
    </Pressable>
  );
}

const fieldLabel = (t: ReturnType<typeof useTheme>) => ({
  color: t.textDim,
  fontWeight: "800" as const,
  fontSize: 10,
  letterSpacing: 0.6,
  marginBottom: 6,
});
