import React from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { cents, dollars } from "../lib/format";
import { radius, space, useTheme } from "../lib/theme";
import {
  candidateSettlementQuery,
  type Market,
  type MarketCandidate,
  type Position,
  type SettlementRule,
  type SettlementSource,
} from "../lib/types";
import { OrderBook } from "./OrderBook";
import { ParsedQuery, ResolutionBlock, resolutionRuleCopy } from "./Resolution";
import { StateChip } from "./StateChip";

// Full market details (spec §6.5b transparency). A comprehensive, read-only
// panel rendering EVERYTHING known about a market — its question and state,
// exactly how it resolves (category, rule, disclosed tappable sources), the
// verbatim public settlement query, live YES/NO prices + order book, volume,
// creator, the fee structure, the viewer's position/PnL, and (advanced) the
// market/chain id reference. Handles two shapes gracefully:
//   • an existing Market (live book, id, volume, creator, structured settlement)
//   • a not-yet-created MarketCandidate from Create (question + settlement
//     query, and any structured preview the generator supplies — no live book).
// Reused by MarketCard's Details expander and AttachMarket's "Full market
// details" expander so the collapsed card + trade forms stay untouched.

// One-word state vocabulary blurb (spec §5).
const STATE_BLURB: Record<string, string> = {
  PENDING: "Being placed onchain.",
  OPEN: "Live. Waiting for a taker.",
  MATCHED: "Both sides are in.",
  SETTLING: "Oracle is resolving the outcome.",
  SETTLED: "Outcome is final.",
  VOID: "Voided. Deposits are refundable.",
};

function sectionLabel(t: ReturnType<typeof useTheme>) {
  return {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: "800" as const,
    letterSpacing: 0.6,
    marginBottom: 6,
  };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <Text style={{ color: t.textDim, fontSize: 13 }}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={{ color: t.text, fontSize: 13, fontWeight: "700" }}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

export function MarketDetails({
  market,
  candidate,
  position,
  positionLabel = "YOUR POSITION",
  posterPnl,
  info,
}: {
  // Provide exactly one of `market` / `candidate`.
  market?: Market | null;
  candidate?: MarketCandidate | null;
  position?: Position | null;
  positionLabel?: string;
  posterPnl?: number | null;
  // Informational mode (MarketCard's second expansion): settlement details,
  // creator, and ids only — the card's first expansion already shows the
  // question, prices, book, position, and volume, so those are omitted here
  // (and fees are never listed on cards).
  info?: boolean;
}) {
  const t = useTheme();
  const router = useRouter();

  const question = market?.question ?? candidate?.question ?? "";
  const tradable = market?.status === "OPEN" || market?.status === "MATCHED";
  const showBook = !!market && (tradable || market.status === "SETTLING");
  const pos = position ?? market?.my_position ?? null;

  // Structured settlement for a candidate (flat fields), when the generator
  // supplies them — existing markets render via ResolutionBlock instead.
  const candRule: SettlementRule | null = candidate?.rule ?? null;
  const candSources: SettlementSource[] = candidate?.sources ?? [];

  return (
    <View style={{ gap: space.lg, backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
      {/* ── Question + state (omitted in info mode — the card shows both) ── */}
      {info ? null : (
      <View style={{ gap: 6 }}>
        <Text style={{ color: t.text, fontWeight: "700", fontSize: 15, lineHeight: 20 }}>{question}</Text>
        {market ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <StateChip state={market.status} direction={market.direction} size="sm" />
            <Text style={{ color: t.textFaint, fontSize: 12, flex: 1 }}>{STATE_BLURB[market.status] ?? ""}</Text>
          </View>
        ) : (
          <View
            style={{
              alignSelf: "flex-start",
              backgroundColor: t.blueTint,
              borderRadius: radius.full,
              paddingVertical: 4,
              paddingHorizontal: 10,
            }}
          >
            <Text style={{ color: t.blue, fontWeight: "800", fontSize: 11, letterSpacing: 0.6 }}>NEW MARKET</Text>
          </View>
        )}
      </View>
      )}

      {/* ── How this market settles (§6.5b transparency) ── */}
      {market ? (
        <ResolutionBlock market={market} />
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={sectionLabel(t)}>HOW THIS MARKET SETTLES</Text>
          {candidate?.category ? (
            <Text style={{ color: t.textFaint, fontSize: 11.5 }}>Category: {candidate.category}</Text>
          ) : null}
          {candRule ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name={candRule === "single" ? "flag-outline" : "people-outline"} size={13} color={t.blue} />
              <Text style={{ color: t.blue, fontSize: 12.5, fontWeight: "700", flex: 1 }}>
                {resolutionRuleCopy({ question, category: candidate?.category ?? null, rule: candRule, sources: candSources })}
              </Text>
            </View>
          ) : null}
          {candSources.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {candSources.map((src) => (
                <Pressable
                  key={src.id}
                  onPress={() => Linking.openURL(src.url).catch(() => {})}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    backgroundColor: t.blueTint,
                    borderRadius: radius.full,
                    paddingVertical: 5,
                    paddingHorizontal: 10,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ color: t.blue, fontWeight: "700", fontSize: 12 }}>{src.name}</Text>
                  <Ionicons name="open-outline" size={11} color={t.blue} />
                </Pressable>
              ))}
            </View>
          ) : null}
          <View>
            <Text style={sectionLabel(t)}>PUBLIC SETTLEMENT QUERY</Text>
            {candidate && candidateSettlementQuery(candidate) ? (
              <ParsedQuery raw={candidateSettlementQuery(candidate)} />
            ) : (
              <Text style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>—</Text>
            )}
          </View>
        </View>
      )}

      {/* ── Prices (omitted in info mode) ── */}
      {market && !info ? (
        <View>
          <Text style={sectionLabel(t)}>PRICE</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1, backgroundColor: t.yesTint, borderRadius: radius.md, paddingVertical: 8, alignItems: "center" }}>
              <Text style={{ color: t.yes, fontWeight: "800", fontSize: 10, letterSpacing: 0.6 }}>YES</Text>
              <Text style={{ color: t.yes, fontWeight: "800", fontSize: 18 }}>{cents(market.yes_price_cents)}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: t.noTint, borderRadius: radius.md, paddingVertical: 8, alignItems: "center" }}>
              <Text style={{ color: t.no, fontWeight: "800", fontSize: 10, letterSpacing: 0.6 }}>NO</Text>
              <Text style={{ color: t.no, fontWeight: "800", fontSize: 18 }}>{cents(market.no_price_cents)}</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ── Live order book (omitted in info mode — the card has a preview) ── */}
      {showBook && !info ? (
        <View>
          <Text style={sectionLabel(t)}>ORDER BOOK</Text>
          <OrderBook marketId={market!.id} compact />
        </View>
      ) : null}

      {/* ── Market stats (volume omitted in info mode — the card shows it) ── */}
      {market ? (
        <View style={{ gap: 8 }}>
          <Text style={sectionLabel(t)}>MARKET</Text>
          {!info ? <Row label="Volume" value={dollars(market.volume)} /> : null}
          {market.expires_at ? (
            <Row
              label={market.status === "SETTLED" || market.status === "VOID" ? "Expiry was" : "Expires"}
              value={`${new Date(market.expires_at).toLocaleDateString()} · 50/50 if unsettled`}
            />
          ) : null}
          {market.creator?.username ? (
            <Row
              label="Creator"
              value={
                <Pressable onPress={() => router.push(`/user/${market.creator!.username}` as never)}>
                  <Text style={{ color: t.blue, fontSize: 13, fontWeight: "700" }}>@{market.creator!.username}</Text>
                </Pressable>
              }
            />
          ) : null}
        </View>
      ) : null}

      {/* ── Fee structure (spec §4.2/§9): ONE taker fee is collected per fill
          (Kalshi's formula — 7% × price × (1−price), at most 1.75¢/share);
          the creator and affiliate shares come out of that collected fee, not
          on top of it. ── */}
      {/* HARD RULE: fees are never shown on market cards — not even in the
          advanced/details tiers. The fee schedule lives in the docs. */}

      {/* ── Viewer's / poster's own position + PnL (card tier 1 shows it) ── */}
      {pos && !info ? (
        <View style={{ gap: 8 }}>
          <Text style={sectionLabel(t)}>{positionLabel}</Text>
          <Row
            label="Holding"
            value={
              <Text style={{ color: pos.side === "yes" ? t.yes : t.no, fontSize: 13, fontWeight: "800" }}>
                {pos.shares} {pos.side.toUpperCase()} @ {cents(pos.avg_price_cents)}
              </Text>
            }
          />
          {posterPnl != null ? (
            <Row
              label="PnL"
              value={
                <Text style={{ color: posterPnl >= 0 ? t.yes : t.no, fontSize: 13, fontWeight: "800" }}>
                  {dollars(posterPnl, { sign: true })}
                </Text>
              }
            />
          ) : pos.realized_pnl != null ? (
            <Row
              label="Realized PnL"
              value={
                <Text style={{ color: pos.realized_pnl >= 0 ? t.yes : t.no, fontSize: 13, fontWeight: "800" }}>
                  {dollars(pos.realized_pnl, { sign: true })}
                </Text>
              }
            />
          ) : null}
        </View>
      ) : null}

      {/* ── Advanced: id reference (existing markets) ── */}
      {market ? (
        <View style={{ gap: 8 }}>
          <Text style={sectionLabel(t)}>REFERENCE (ADVANCED)</Text>
          <Row
            label="Market id"
            value={<Text style={{ color: t.textDim, fontSize: 11.5, fontWeight: "600" }}>{market.id}</Text>}
          />
          <Row label="Chain market id" value={`#${market.chain_market_id}`} />
        </View>
      ) : null}
    </View>
  );
}
