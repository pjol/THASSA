import React, { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import QRCode from "react-native-qrcode-svg";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useApi } from "../lib/api";
import { useWallet } from "../lib/auth";
import { cents, dollars, shortAddress, timeAgo } from "../lib/format";
import { success, tap, warn } from "../lib/haptics";
import { dollarsToUnits, signReceiveAuthorization } from "../lib/signing";
import { radius, space, useTheme } from "../lib/theme";
import { pageItems, type Paged, type Position, type WalletActivityItem, type WalletInfo, type OnrampSession } from "../lib/types";
import { SideBadge } from "./StateChip";
import { EmptyState } from "./states";
import { useToasts } from "./Toasts";
import { Button, Field, Sheet, Skeleton, useInputStyle } from "./ui";

// Wallet tab, own profile only (spec §7): payment-token balance card, Receive
// (address + QR), Send (EIP-3009 auth → relayed, payment token only), Fund
// (fiat onramp checkout / cross-chain crypto deposit), activity, positions.

export function WalletTab() {
  const api = useApi();
  const t = useTheme();
  const [sheet, setSheet] = useState<"receive" | "send" | "fund" | null>(null);

  const wallet = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.get<WalletInfo>("/v1/wallet"),
  });
  const positions = useQuery({
    queryKey: ["positions"],
    queryFn: () => api.get<Paged<Position>>("/v1/positions"),
  });
  const activity = useQuery({
    queryKey: ["wallet-activity"],
    queryFn: () => api.get<Paged<WalletActivityItem>>("/v1/wallet/activity?limit=20"),
  });

  const w = wallet.data;
  const positionItems = pageItems<Position>(positions.data);
  const activityItems = pageItems<WalletActivityItem>(activity.data);

  return (
    <View style={{ padding: space.md, gap: space.lg }}>
      {/* Balance card */}
      <View
        style={{
          backgroundColor: t.blue,
          borderRadius: radius.xl,
          padding: space.xl,
          gap: 6,
        }}
      >
        <Text style={{ color: "rgba(255,255,255,0.75)", fontWeight: "700", fontSize: 12, letterSpacing: 0.8 }}>
          BALANCE · {w?.token_symbol ?? "USD"}
        </Text>
        {wallet.isLoading ? (
          <Skeleton style={{ height: 40, width: 160, backgroundColor: "rgba(255,255,255,0.25)" }} />
        ) : (
          <Text style={{ color: "#FFFFFF", fontWeight: "900", fontSize: 40, letterSpacing: -1 }}>
            {dollars(w?.balance ?? 0)}
          </Text>
        )}
        <Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 13 }}>{shortAddress(w?.address)}</Text>
        <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
          <WalletAction icon="arrow-down" label="Receive" onPress={() => setSheet("receive")} />
          <WalletAction icon="arrow-up" label="Send" onPress={() => setSheet("send")} />
          <WalletAction icon="card" label="Fund" onPress={() => setSheet("fund")} />
        </View>
      </View>

      {/* Positions */}
      <Section title="Positions">
        {positions.isLoading ? (
          <Skeleton style={{ height: 56 }} />
        ) : positionItems.length === 0 ? (
          <Text style={{ color: t.textFaint, fontSize: 13 }}>No open positions.</Text>
        ) : (
          positionItems.map((p) => (
            <View
              key={`${p.market_id}-${p.side}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border }}
            >
              <SideBadge side={p.side} size="sm" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 13.5, fontWeight: "600" }} numberOfLines={1}>
                  {p.market?.question ?? p.market_id}
                </Text>
                <Text style={{ color: t.textDim, fontSize: 12 }}>
                  {p.shares} shares @ {cents(p.avg_price_cents)}
                </Text>
              </View>
              <Text
                style={{
                  color: (p.unrealized_pnl ?? p.realized_pnl) >= 0 ? t.yes : t.no,
                  fontWeight: "800",
                }}
              >
                {dollars(p.unrealized_pnl ?? p.realized_pnl, { sign: true })}
              </Text>
            </View>
          ))
        )}
      </Section>

      {/* Activity */}
      <Section title="Activity">
        {activity.isLoading ? (
          <Skeleton style={{ height: 56 }} />
        ) : activityItems.length === 0 ? (
          <Text style={{ color: t.textFaint, fontSize: 13 }}>Nothing yet.</Text>
        ) : (
          activityItems.map((a) => (
            <View key={a.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 13.5 }}>{a.description ?? a.kind}</Text>
                <Text style={{ color: t.textFaint, fontSize: 11.5 }}>{timeAgo(a.created_at)}</Text>
              </View>
              <Text style={{ color: a.amount >= 0 ? t.yes : t.text, fontWeight: "700" }}>
                {dollars(a.amount, { sign: true })}
              </Text>
            </View>
          ))
        )}
      </Section>

      {w ? (
        <>
          <ReceiveSheet visible={sheet === "receive"} onClose={() => setSheet(null)} wallet={w} />
          <SendSheet visible={sheet === "send"} onClose={() => setSheet(null)} wallet={w} />
          <FundSheet visible={sheet === "fund"} onClose={() => setSheet(null)} />
        </>
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.textDim, fontWeight: "800", fontSize: 12, letterSpacing: 0.8 }}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function WalletAction({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flex: 1,
        backgroundColor: "rgba(255,255,255,0.16)",
        borderRadius: radius.md,
        paddingVertical: 10,
        alignItems: "center",
        gap: 3,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={19} color="#FFFFFF" />
      <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 12.5 }}>{label}</Text>
    </Pressable>
  );
}

function ReceiveSheet({ visible, onClose, wallet }: { visible: boolean; onClose: () => void; wallet: WalletInfo }) {
  const t = useTheme();
  const toasts = useToasts();
  return (
    <Sheet visible={visible} onClose={onClose} title="Receive">
      <View style={{ alignItems: "center", gap: space.lg, padding: space.lg }}>
        <View style={{ padding: 14, backgroundColor: "#FFFFFF", borderRadius: radius.lg }}>
          <QRCode value={wallet.address} size={190} backgroundColor="#FFFFFF" color="#0A0A0A" />
        </View>
        <Text style={{ color: t.textDim, fontSize: 13, textAlign: "center" }}>
          Send only {wallet.token_symbol} on the Thassa chain to this address.
        </Text>
        <Pressable
          onPress={async () => {
            await Clipboard.setStringAsync(wallet.address);
            success();
            toasts.show({ title: "Address copied", icon: "copy" });
          }}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: t.surfaceAlt, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 14 }}
        >
          <Text style={{ color: t.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
            {wallet.address}
          </Text>
          <Ionicons name="copy-outline" size={16} color={t.textDim} />
        </Pressable>
      </View>
    </Sheet>
  );
}

function SendSheet({ visible, onClose, wallet }: { visible: boolean; onClose: () => void; wallet: WalletInfo }) {
  const t = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const { ensureWallet } = useWallet();
  const toasts = useToasts();
  const inputStyle = useInputStyle();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amt = parseFloat(amount) || 0;
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to.trim()) && amt > 0 && amt <= wallet.balance;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const handle = await ensureWallet();
      // EIP-3009 auth paying the recipient directly; the relayer submits it
      // (backend validates the recipient before relaying — spec §6.6).
      const auth = await signReceiveAuthorization(handle, {
        to: to.trim(),
        value: dollarsToUnits(amt, wallet.token_decimals),
        token: { name: wallet.token_name, version: wallet.token_version, address: wallet.token_address },
      });
      await api.post("/v1/wallet/send", { to: to.trim(), amount: amt, auth });
      success();
      toasts.show({ title: "Sent", body: `${dollars(amt)} to ${shortAddress(to)}`, icon: "arrow-up-circle" });
      qc.invalidateQueries({ queryKey: ["wallet"] });
      qc.invalidateQueries({ queryKey: ["wallet-activity"] });
      setTo("");
      setAmount("");
      onClose();
    } catch (e) {
      warn();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Send">
      <View style={{ padding: space.lg }}>
        <Field label="Recipient address">
          <TextInput
            style={inputStyle}
            placeholder="0x…"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            value={to}
            onChangeText={setTo}
          />
        </Field>
        <Field label={`Amount (${wallet.token_symbol})`} hint={`Balance ${dollars(wallet.balance)}. Payment token only.`}>
          <TextInput
            style={inputStyle}
            placeholder="0.00"
            placeholderTextColor={t.textFaint}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />
        </Field>
        {error ? <Text style={{ color: t.danger, fontSize: 13, marginBottom: 10 }}>{error}</Text> : null}
        <Button title={amt > 0 ? `Send ${dollars(amt)}` : "Send"} disabled={!valid} loading={busy} onPress={send} />
      </View>
    </Sheet>
  );
}

function FundSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const api = useApi();
  const toasts = useToasts();
  const [busy, setBusy] = useState<"fiat" | "crypto" | null>(null);
  const [crypto, setCrypto] = useState<OnrampSession | null>(null);

  const startFiat = async () => {
    setBusy("fiat");
    try {
      const s = await api.post<OnrampSession>("/v1/onramp/sessions", { kind: "fiat" });
      if (s.checkout_url) {
        // Provider-hosted checkout (Stripe-style rail) in an in-app browser.
        await WebBrowser.openBrowserAsync(s.checkout_url);
      }
      onClose();
    } catch (e) {
      warn();
      toasts.show({ title: "Couldn't start checkout", body: errorMessage(e), icon: "alert-circle" });
    } finally {
      setBusy(null);
    }
  };

  const startCrypto = async () => {
    setBusy("crypto");
    try {
      const s = await api.post<OnrampSession>("/v1/onramp/sessions", { kind: "crypto" });
      setCrypto(s);
    } catch (e) {
      warn();
      toasts.show({ title: "Couldn't get a deposit address", body: errorMessage(e), icon: "alert-circle" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Add funds">
      <View style={{ padding: space.lg, gap: space.md }}>
        {crypto ? (
          <View style={{ alignItems: "center", gap: space.md }}>
            <Text style={{ color: t.textDim, fontSize: 13.5, textAlign: "center" }}>
              {crypto.deposit_note ??
                `Send funds on ${crypto.deposit_chain ?? "a supported chain"} to this address. They'll arrive as your Thassa balance.`}
            </Text>
            {crypto.deposit_address ? (
              <>
                <View style={{ padding: 12, backgroundColor: "#FFFFFF", borderRadius: radius.lg }}>
                  <QRCode value={crypto.deposit_address} size={160} backgroundColor="#FFFFFF" color="#0A0A0A" />
                </View>
                <Pressable
                  onPress={async () => {
                    await Clipboard.setStringAsync(crypto.deposit_address!);
                    success();
                    toasts.show({ title: "Deposit address copied", icon: "copy" });
                  }}
                >
                  <Text style={{ color: t.blue, fontWeight: "700", fontSize: 13 }}>{shortAddress(crypto.deposit_address)} · Copy</Text>
                </Pressable>
              </>
            ) : null}
            <Button title="Done" variant="subtle" onPress={onClose} />
          </View>
        ) : (
          <>
            <FundOption
              icon="card"
              title="Pay with card or bank"
              subtitle="Hosted checkout, funds land in minutes."
              loading={busy === "fiat"}
              onPress={startFiat}
            />
            <FundOption
              icon="swap-horizontal"
              title="Deposit crypto"
              subtitle="Cross-chain deposit from any wallet."
              loading={busy === "crypto"}
              onPress={startCrypto}
            />
          </>
        )}
      </View>
    </Sheet>
  );
}

function FundOption({
  icon,
  title,
  subtitle,
  onPress,
  loading,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
  loading?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        backgroundColor: t.surfaceAlt,
        borderRadius: radius.lg,
        padding: space.lg,
        opacity: pressed || loading ? 0.7 : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: t.blueTint, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={20} color={t.blue} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontWeight: "700", fontSize: 15 }}>{title}</Text>
        <Text style={{ color: t.textDim, fontSize: 12.5 }}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.textFaint} />
    </Pressable>
  );
}
