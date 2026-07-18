import React, { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { errorMessage, useApi } from "../lib/api";
import { useWallet } from "../lib/auth";
import { dollars } from "../lib/format";
import { success, warn } from "../lib/haptics";
import {
  buildOrder,
  dollarsToUnits,
  maxCostUnits,
  payToWin,
  sharesForSpend,
  signReceiveAuthorization,
  takerFeeDollars,
  unitsToDollars,
} from "../lib/signing";
import { radius, space, useTheme } from "../lib/theme";
import type { Market, Order, OrderState, Side } from "../lib/types";
import { OrderBook } from "./OrderBook";
import { ResolutionBlock } from "./Resolution";
import { StateChip } from "./StateChip";
import { Button, Sheet, useInputStyle } from "./ui";
import { useToasts } from "./Toasts";

// Buy/sell ticket (quick-buy bottom sheet + market-detail ticket, spec §7).
// Signs the EIP-712 order + EIP-3009 funding auth with the Privy embedded
// wallet and submits to the relayer queue, showing the SIGNING → QUEUED order
// state progression. Orders placed from a post's market widget carry that post
// id as affiliate attribution.

export function TradeSheet({
  visible,
  onClose,
  market,
  initialSide = "yes",
  affiliatePostId,
  affiliateId,
  onPlaced,
}: {
  visible: boolean;
  onClose: () => void;
  market: Market;
  initialSide?: Side;
  // Post whose widget routed this order (affiliate attribution): backend uuid
  // + numeric onchain id — orders send both.
  affiliatePostId?: string | null;
  affiliateId?: number | null;
  onPlaced?: (order: Order) => void;
}) {
  const t = useTheme();
  const api = useApi();
  const { ensureWallet } = useWallet();
  const toasts = useToasts();
  const inputStyle = useInputStyle();

  const [side, setSide] = useState<Side>(initialSide);
  const [amount, setAmount] = useState("10");
  const [advanced, setAdvanced] = useState(false);
  const [limitOverride, setLimitOverride] = useState<number | null>(null);
  const [stage, setStage] = useState<"idle" | OrderState>("idle");
  const [error, setError] = useState<string | null>(null);

  const bestPrice = side === "yes" ? market.yes_price_cents : market.no_price_cents;
  const price = limitOverride ?? bestPrice ?? 50;
  const spend = parseFloat(amount) || 0;
  const shares = sharesForSpend(spend, price);
  const { pay, win } = payToWin(shares, price);
  const fee = takerFeeDollars(shares, price);

  const canSubmit = shares > 0 && stage !== "SIGNING" && stage !== "QUEUED";

  const reset = () => {
    setStage("idle");
    setError(null);
  };

  const submit = async () => {
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
      // Single-signature carriage: the order is NOT signed separately — its
      // EIP-712 digest rides as the EIP-3009 auth nonce, so the one funding
      // signature binds the order terms too.
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
      const res = await api.post<{ order: Order }>("/v1/orders", {
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
        body: `${side.toUpperCase()} · ${shares} shares @ ${price}¢`,
        icon: "checkmark-circle",
      });
      onPlaced?.(res.order);
      onClose();
      setStage("idle");
    } catch (e) {
      warn();
      setError(errorMessage(e));
      setStage("idle");
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Place a bet"
    >
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <Text style={{ color: t.textDim, fontSize: 14 }} numberOfLines={2}>
          {market.question}
        </Text>

        {/* Side toggle with live prices */}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <SideButton
            label="YES"
            price={market.yes_price_cents}
            active={side === "yes"}
            color={t.yes}
            tint={t.yesTint}
            onPress={() => {
              setSide("yes");
              setLimitOverride(null);
            }}
          />
          <SideButton
            label="NO"
            price={market.no_price_cents}
            active={side === "no"}
            color={t.no}
            tint={t.noTint}
            onPress={() => {
              setSide("no");
              setLimitOverride(null);
            }}
          />
        </View>

        {/* Amount */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ color: t.text, fontSize: 28, fontWeight: "800" }}>$</Text>
          <TextInput
            style={[inputStyle, { flex: 1, fontSize: 24, fontWeight: "700" }]}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
            placeholder="0"
            placeholderTextColor={t.textFaint}
          />
          {[5, 20, 100].map((v) => (
            <Pressable
              key={v}
              onPress={() => setAmount(String(v))}
              style={{ backgroundColor: t.grayTint, borderRadius: radius.full, paddingVertical: 8, paddingHorizontal: 12 }}
            >
              <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>${v}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={{ color: t.textDim, fontSize: 14 }}>
          {shares > 0 ? (
            <>
              You pay <Text style={{ color: t.text, fontWeight: "800" }}>{dollars(pay)}</Text> to win{" "}
              <Text style={{ color: side === "yes" ? t.yes : t.no, fontWeight: "800" }}>{dollars(win)}</Text>
              {"  ·  "}
              {shares} share{shares === 1 ? "" : "s"} @ {price}¢ · est. fee {dollars(fee)}
            </>
          ) : (
            "Enter an amount to see your payout."
          )}
        </Text>

        {/* Advanced: limit price + live order book */}
        <Pressable onPress={() => setAdvanced((a) => !a)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name={advanced ? "chevron-down" : "chevron-forward"} size={16} color={t.textDim} />
          <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>Advanced</Text>
        </Pressable>
        {advanced ? (
          <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.lg, padding: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>Limit price</Text>
              <PriceStepper value={price} onChange={setLimitOverride} />
            </View>
            <OrderBook marketId={market.id} compact />
          </View>
        ) : null}

        {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : null}

        {/* Loading state lives IN the button (same as feed market cards). */}
        <Button
          title={
            stage === "SIGNING"
              ? "Confirm in your wallet…"
              : stage === "QUEUED"
                ? "Submitting…"
                : shares > 0
                  ? `Buy ${side.toUpperCase()} · ${dollars(pay)}`
                  : "Buy"
          }
          variant={side}
          disabled={!canSubmit}
          loading={stage === "SIGNING" || stage === "QUEUED"}
          onPress={submit}
        />
      </View>
    </Sheet>
  );
}

function SideButton({
  label,
  price,
  active,
  color,
  tint,
  onPress,
}: {
  label: string;
  price: number | null;
  active: boolean;
  color: string;
  tint: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        backgroundColor: active ? color : tint,
        borderRadius: radius.lg,
        paddingVertical: 14,
        alignItems: "center",
      }}
    >
      <Text style={{ color: active ? "#FFFFFF" : color, fontWeight: "800", fontSize: 16 }}>
        {label} {price != null ? `${price}¢` : "—"}
      </Text>
    </Pressable>
  );
}

export function PriceStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTheme();
  const step = (d: number) => onChange(Math.max(1, Math.min(99, value + d)));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Pressable onPress={() => step(-1)} hitSlop={8} style={{ backgroundColor: t.grayTint, borderRadius: 999, width: 30, height: 30, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="remove" size={18} color={t.text} />
      </Pressable>
      <Text style={{ color: t.text, fontWeight: "800", fontSize: 17, minWidth: 44, textAlign: "center" }}>{value}¢</Text>
      <Pressable onPress={() => step(1)} hitSlop={8} style={{ backgroundColor: t.grayTint, borderRadius: 999, width: 30, height: 30, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="add" size={18} color={t.text} />
      </Pressable>
    </View>
  );
}

// Confirmation sheet for triggering settlement (spec §7): "Settle market — 5¢".
export function SettleSheet({
  visible,
  onClose,
  market,
  onSettled,
}: {
  visible: boolean;
  onClose: () => void;
  market: Market;
  onSettled?: () => void;
}) {
  const t = useTheme();
  const api = useApi();
  const { ensureWallet } = useWallet();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = async () => {
    setBusy(true);
    setError(null);
    try {
      // The 5¢ settlement fee is pulled via an EIP-3009 auth to the platform.
      const wallet = await ensureWallet();
      const auth = await signReceiveAuthorization(wallet, { value: dollarsToUnits(0.05) });
      await api.post(`/v1/markets/${market.id}/settle`, { auth });
      success();
      toasts.show({ title: "Settlement requested", body: "The oracle is on it.", icon: "hourglass" });
      onSettled?.();
      onClose();
    } catch (e) {
      warn();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const feeCopy = useMemo(() => dollars(unitsToDollars(dollarsToUnits(0.05))), []);

  return (
    <Sheet visible={visible} onClose={onClose} title="Settle market — 5¢">
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <Text style={{ color: t.textDim, fontSize: 14, lineHeight: 20 }}>
          This sends the public settlement query to the Thassa oracle. Anyone can trigger it; you pay
          the {feeCopy} settlement fee. The market flips to SETTLING while the query runs.
        </Text>
        <View style={{ backgroundColor: t.surfaceAlt, borderRadius: radius.lg, padding: space.md }}>
          <ResolutionBlock market={market} />
        </View>
        {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : null}
        <Button title="Settle market — 5¢" onPress={settle} loading={busy} variant="accent" />
        <Button title="Cancel" onPress={onClose} variant="subtle" />
      </View>
    </Sheet>
  );
}
