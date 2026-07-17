import React, { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
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
  takerFeeDollars,
} from "../lib/signing";
import { radius, space, useTheme } from "../lib/theme";
import { useBookChannel } from "../lib/ws";
import { CREATOR_MICROCOPY, type Market, type Order, type OrderState, type Position, type Side } from "../lib/types";
import { OrderBook } from "./OrderBook";
import { ResolutionBlock } from "./Resolution";
import { SideBadge, StateChip } from "./StateChip";
import { SettleSheet } from "./TradeSheet";
import { Button, useInputStyle } from "./ui";
import { useToasts } from "./Toasts";

// The market widget attached to a post (spec §7). Collapsed default is a SINGLE
// LINE: the question on the left (truncated) with compact YES/NO price pills on
// the right. Choosing a side EXPANDS the card inline into the trade form
// (amount + quick chips, an Advanced limit-price + live book, a cost/payout
// summary, and a submit button that walks SIGNING → QUEUED) — no separate
// sheet. Settled markets keep their direction badge + poster PnL attached; a
// Details expander exposes the live order book, the public settlement query,
// and the 5¢ settle action (via the existing SettleSheet). Orders placed here
// carry the post id as affiliate attribution.

const QUICK_AMOUNTS = [5, 10, 25, 50];

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
  const api = useApi();
  const { me } = useSession();
  const { ensureWallet } = useWallet();
  const toasts = useToasts();
  const queryClient = useQueryClient();
  const inputStyle = useInputStyle();

  const [market, setMarket] = useState(initial);
  // side === null → collapsed (single line). Picking a side expands the form.
  const [side, setSide] = useState<Side | null>(null);
  const [amount, setAmount] = useState("10");
  const [advanced, setAdvanced] = useState(false); // limit price + book in form
  const [limitInput, setLimitInput] = useState("");
  const [stage, setStage] = useState<"idle" | OrderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false); // settlement query / settle
  const [settling, setSettling] = useState(false);

  // Keep prices/status live while the card is expanded (form or details open);
  // the book delta payload carries best prices, market.update carries status.
  useBookChannel(side != null || details ? market.id : null, (e) => {
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
  const tradable = market.status === "OPEN" || market.status === "MATCHED";

  const clampCents = (n: number) => Math.min(99, Math.max(1, n));
  const marketPrice = (side === "no" ? market.no_price_cents : market.yes_price_cents) ?? 50;
  const price = useMemo(() => {
    const parsed = advanced && limitInput ? parseInt(limitInput, 10) : marketPrice;
    return clampCents(Number.isFinite(parsed) ? parsed : marketPrice);
  }, [advanced, limitInput, marketPrice]);

  const spend = parseFloat(amount) || 0;
  const shares = sharesForSpend(spend, price);
  const { pay, win } = payToWin(shares, price);
  const fee = takerFeeDollars(shares, price);
  const busy = stage === "SIGNING" || stage === "QUEUED";
  const canSubmit = tradable && side != null && shares > 0 && !busy;

  const collapse = () => {
    setSide(null);
    setAdvanced(false);
    setLimitInput("");
    setStage("idle");
    setError(null);
  };

  const pick = (s: Side) => {
    if (!tradable) return;
    setStage("idle");
    setError(null);
    setSide(s);
  };

  const submit = async () => {
    if (!canSubmit || side == null) return;
    setError(null);
    setStage("SIGNING");
    try {
      const wallet = await ensureWallet();
      // Next EIP-712 maker nonce comes from the wallet endpoint (web parity).
      const { order_nonce } = await api.get<{ order_nonce: number }>("/v1/wallet");
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
      await api.post<{ order: Order }>("/v1/orders", {
        market_id: market.id,
        side,
        price_cents: price,
        shares,
        max_cost: order.message.maxCost,
        expiry: order.message.expiry,
        nonce: order.message.nonce,
        maker: wallet.address,
        auth,
        affiliate_post_id: affiliatePostId ?? null,
        affiliate_id: affiliateId ?? 0,
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
      collapse();
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
        borderRadius: radius.lg,
        padding: space.md,
        gap: 10,
        backgroundColor: t.surface,
      }}
    >
      {/* ── Single collapsed line: question + YES/NO (or state) on the right ── */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable
          style={{ flex: 1 }}
          disabled={standalone}
          onPress={() => router.push(`/market/${market.id}` as never)}
        >
          <Text style={{ color: t.text, fontWeight: "700", fontSize: 15, lineHeight: 20 }} numberOfLines={1}>
            {market.question}
          </Text>
        </Pressable>

        {settled ? (
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
        ) : tradable ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <PricePill
              label="YES"
              price={market.yes_price_cents}
              color={t.yes}
              tint={t.yesTint}
              active={side === "yes"}
              onPress={() => pick("yes")}
            />
            <PricePill
              label="NO"
              price={market.no_price_cents}
              color={t.no}
              tint={t.noTint}
              active={side === "no"}
              onPress={() => pick("no")}
            />
          </View>
        ) : (
          <StateChip state={market.status} direction={market.direction} size="sm" />
        )}
      </View>

      {/* Creator microcopy (OPEN "committed…" / MATCHED "taken"). */}
      {microcopy ? (
        <Text style={{ color: market.status === "MATCHED" ? t.yes : t.blue, fontSize: 13, fontWeight: "600" }}>
          {microcopy}
        </Text>
      ) : null}

      {/* SETTLED: the poster's PnL stays attached to the post. */}
      {settled && posterPnl != null ? (
        <Text style={{ color: t.textDim, fontSize: 13, fontWeight: "600" }}>
          {posterUsername ? `@${posterUsername} ` : ""}
          <Text style={{ color: posterPnl >= 0 ? t.yes : t.no, fontWeight: "800" }}>
            {dollars(posterPnl, { sign: true })}
          </Text>
        </Text>
      ) : null}

      {/* Poster's position badge (hidden server-side when trades are private). */}
      {posterPosition && side == null ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <SideBadge side={posterPosition.side} size="sm" />
          <Text style={{ color: t.textDim, fontSize: 12.5 }}>
            {posterUsername ? `@${posterUsername} holds ` : "Holds "}
            {posterPosition.shares} share{posterPosition.shares === 1 ? "" : "s"} @ {posterPosition.avg_price_cents}¢
          </Text>
        </View>
      ) : null}

      {/* ── Expanded inline trade form (after choosing a side) ── */}
      {side != null && tradable ? (
        <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: t.textDim, fontWeight: "800", fontSize: 12, letterSpacing: 0.6 }}>
              BUY{" "}
              <Text style={{ color: side === "yes" ? t.yes : t.no }}>{side.toUpperCase()}</Text> @ {price}¢
            </Text>
            <Pressable onPress={collapse} hitSlop={8}>
              <Ionicons name="close" size={20} color={t.textDim} />
            </Pressable>
          </View>

          {/* Amount */}
          <View>
            <Text style={fieldLabel(t)}>AMOUNT</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: t.text, fontSize: 22, fontWeight: "800" }}>$</Text>
              <TextInput
                style={[inputStyle, { flex: 1, fontSize: 20, fontWeight: "700" }]}
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
                placeholder="0"
                placeholderTextColor={t.textFaint}
              />
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
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
          </View>

          {/* Advanced: limit price + live order book */}
          <Pressable
            onPress={() => setAdvanced((a) => !a)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Ionicons name={advanced ? "chevron-down" : "chevron-forward"} size={15} color={t.blue} />
            <Text style={{ color: t.blue, fontWeight: "700", fontSize: 12.5 }}>Advanced</Text>
          </Pressable>
          {advanced ? (
            <View style={{ gap: space.md }}>
              <View>
                <Text style={fieldLabel(t)}>LIMIT PRICE (CENTS)</Text>
                <TextInput
                  style={[inputStyle, { fontWeight: "700" }]}
                  keyboardType="number-pad"
                  value={limitInput}
                  onChangeText={(v) => setLimitInput(v.replace(/[^0-9]/g, ""))}
                  placeholder={String(marketPrice)}
                  placeholderTextColor={t.textFaint}
                />
              </View>
              <OrderBook marketId={market.id} compact />
            </View>
          ) : null}

          {/* Summary */}
          <View style={{ gap: 5, backgroundColor: t.surface, borderRadius: radius.md, padding: space.md }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ color: t.textDim, fontSize: 13 }}>Shares</Text>
              <Text style={{ color: t.text, fontWeight: "700", fontSize: 13 }}>{shares}</Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ color: t.textDim, fontSize: 13 }}>Fee if taking (est.)</Text>
              <Text style={{ color: t.text, fontSize: 13 }}>{dollars(fee)}</Text>
            </View>
            <Text style={{ color: t.text, fontWeight: "700", fontSize: 13.5, marginTop: 2 }}>
              You pay <Text style={{ fontWeight: "800" }}>{dollars(pay)}</Text> to win{" "}
              <Text style={{ color: side === "yes" ? t.yes : t.no, fontWeight: "800" }}>{dollars(win)}</Text>
            </Text>
          </View>

          {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : null}

          {busy ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, justifyContent: "center" }}>
              <StateChip state={stage as OrderState} size="sm" />
              <Text style={{ color: t.textDim, fontSize: 13 }}>
                {stage === "SIGNING" ? "Confirm in your wallet…" : "Submitting to the relayer…"}
              </Text>
            </View>
          ) : null}

          <Button
            title={`Buy ${side.toUpperCase()} at ${price}¢`}
            variant={side}
            disabled={!canSubmit}
            loading={busy}
            onPress={submit}
          />
          <Text style={{ color: t.textFaint, fontSize: 11.5, textAlign: "center" }}>
            Gasless — you sign, our relayer submits. Each share pays $1 if you&apos;re right.
          </Text>
        </View>
      ) : null}

      {/* ── Details: order book + settlement query + settle, when not trading ── */}
      {side == null ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Pressable
              onPress={() => setDetails((d) => !d)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Ionicons name={details ? "chevron-down" : "chevron-forward"} size={15} color={t.blue} />
              <Text style={{ color: t.blue, fontWeight: "700", fontSize: 12.5 }}>Details</Text>
            </Pressable>
            <Text style={{ color: t.textFaint, fontSize: 12 }}>Vol {dollars(market.volume)}</Text>
          </View>

          {details ? (
            <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
              {tradable || market.status === "SETTLING" ? <OrderBook marketId={market.id} compact /> : null}
              <ResolutionBlock market={market} />
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
              {market.status === "SETTLING" ? (
                <Text style={{ color: t.amber, fontWeight: "600", fontSize: 12.5, textAlign: "center" }}>
                  Settlement query is running…
                </Text>
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

// Compact YES/NO price pill on the collapsed single line: "YES 12¢".
function PricePill({
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
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: tint,
        borderRadius: radius.full,
        paddingVertical: 6,
        paddingHorizontal: 11,
        borderWidth: active ? 2 : 0,
        borderColor: color,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontWeight: "800", fontSize: 13 }}>{label}</Text>
      <Text style={{ color, fontWeight: "800", fontSize: 13 }}>{price != null ? `${price}¢` : "—"}</Text>
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
