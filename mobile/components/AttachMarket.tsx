import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { errorMessage, useApi } from "../lib/api";
import { cents, dollars } from "../lib/format";
import { tap } from "../lib/haptics";
import { payToWin, sharesForSpend, takerFeeDollars } from "../lib/signing";
import { radius, space, useTheme } from "../lib/theme";
import {
  candidateSettlementQuery,
  pageItems,
  type Market,
  type MarketCandidate,
  type Paged,
  type Side,
} from "../lib/types";
import { OrderBook } from "./OrderBook";
import { PriceSlider } from "./PriceSlider";
import { PriceStepper } from "./TradeSheet";
import { StateChip } from "./StateChip";
import { useInputStyle } from "./ui";

// "Attach market" flow inside Create (spec §7): typeahead over existing
// markets (top matches as chips with prices) → simple $ amount + Advanced
// (limit price, order book preview); or "Generate market" → up to 3 LLM
// candidates from /v1/markets/generate → pick one → spend + 1–99¢ sliding
// scale for the maker price with "you pay X to win Y" copy. New markets
// require ≥ $1 of opening capital.

export type MarketAttachment =
  | { kind: "existing"; market: Market; side: Side; spend: number; limitPriceCents: number | null }
  | { kind: "new"; candidate: MarketCandidate; side: Side; spend: number; priceCents: number };

export const NEW_MARKET_MIN_SPEND = 1;

export function AttachMarket({
  value,
  onChange,
}: {
  value: MarketAttachment | null;
  onChange: (a: MarketAttachment | null) => void;
}) {
  const api = useApi();
  const t = useTheme();
  const inputStyle = useInputStyle();

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Market[]>([]);
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<MarketCandidate[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search-as-you-type over existing markets FIRST (spec §6.5).
  useEffect(() => {
    if (value) return;
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      api
        .get<Paged<Market>>(`/v1/markets/search?q=${encodeURIComponent(q)}`)
        .then((r) => setMatches(pageItems<Market>(r)))
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, api, value]);

  const generate = async () => {
    setGenerating(true);
    setGenError(null);
    setCandidates(null);
    try {
      const res = await api.post<{ candidates: MarketCandidate[]; matches?: Market[] }>(
        "/v1/markets/generate",
        { query: query.trim() }
      );
      setCandidates((res.candidates ?? []).slice(0, 3));
      if (res.matches?.length) setMatches(res.matches);
    } catch (e) {
      setGenError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  // --- attached state ---------------------------------------------------
  if (value) {
    return (
      <AttachedEditor
        value={value}
        onChange={onChange}
        onDetach={() => {
          onChange(null);
          setCandidates(null);
        }}
      />
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          style={[inputStyle, { flex: 1 }]}
          placeholder="Attach a market… e.g. Lakers win tonight"
          placeholderTextColor={t.textFaint}
          value={query}
          onChangeText={setQuery}
        />
        {searching ? <ActivityIndicator color={t.blue} /> : null}
      </View>

      {/* Existing matches as chips with prices */}
      {matches.length > 0 ? (
        <View style={{ gap: 8 }}>
          {matches.slice(0, 5).map((m) => (
            <Pressable
              key={m.id}
              onPress={() => {
                tap();
                onChange({ kind: "existing", market: m, side: "yes", spend: 10, limitPriceCents: null });
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: radius.md,
                padding: space.md,
              }}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ color: t.text, fontWeight: "600", fontSize: 13.5 }} numberOfLines={2}>
                  {m.question}
                </Text>
                <StateChip state={m.status} direction={m.direction} size="sm" />
              </View>
              <Text style={{ color: t.yes, fontWeight: "800", fontSize: 13 }}>YES {cents(m.yes_price_cents)}</Text>
              <Text style={{ color: t.no, fontWeight: "800", fontSize: 13 }}>NO {cents(m.no_price_cents)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Generate */}
      {query.trim().length >= 3 ? (
        <Pressable
          onPress={generate}
          disabled={generating}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: t.blueTint,
            borderRadius: radius.md,
            padding: space.md,
            opacity: generating ? 0.6 : 1,
          }}
        >
          {generating ? <ActivityIndicator color={t.blue} size="small" /> : <Ionicons name="sparkles" size={17} color={t.blue} />}
          <Text style={{ color: t.blue, fontWeight: "700", fontSize: 14 }}>
            {generating ? "Generating candidates…" : `Generate a market for “${query.trim()}”`}
          </Text>
        </Pressable>
      ) : null}
      {genError ? <Text style={{ color: t.danger, fontSize: 13 }}>{genError}</Text> : null}

      {/* LLM candidates */}
      {candidates && candidates.length === 0 ? (
        <Text style={{ color: t.textFaint, fontSize: 13 }}>
          Couldn't draft a market for that. Try rephrasing as a verifiable question.
        </Text>
      ) : null}
      {candidates?.map((c, i) => (
        <Pressable
          key={i}
          onPress={() => {
            tap();
            if (c.existing_market) {
              onChange({ kind: "existing", market: c.existing_market, side: "yes", spend: 10, limitPriceCents: null });
            } else {
              onChange({ kind: "new", candidate: c, side: "yes", spend: 5, priceCents: 50 });
            }
          }}
          style={{ borderWidth: 1.5, borderColor: t.blue, borderRadius: radius.md, padding: space.md, gap: 4 }}
        >
          <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }}>{c.title || c.question}</Text>
          <Text style={{ color: t.textDim, fontSize: 12.5 }} numberOfLines={2}>
            {c.question}
          </Text>
          <Text style={{ color: t.textFaint, fontSize: 11.5 }} numberOfLines={2}>
            Settles by: {candidateSettlementQuery(c)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function AttachedEditor({
  value,
  onChange,
  onDetach,
}: {
  value: MarketAttachment;
  onChange: (a: MarketAttachment) => void;
  onDetach: () => void;
}) {
  const t = useTheme();
  const inputStyle = useInputStyle();
  const [advanced, setAdvanced] = useState(false);
  const [amountText, setAmountText] = useState(String(value.spend));

  const isNew = value.kind === "new";
  const price =
    value.kind === "new"
      ? value.priceCents
      : (value.limitPriceCents ??
        (value.side === "yes" ? value.market.yes_price_cents : value.market.no_price_cents) ??
        50);
  const spend = parseFloat(amountText) || 0;
  const shares = sharesForSpend(spend, price);
  const { pay, win } = payToWin(shares, price);
  const belowMin = isNew && spend < NEW_MARKET_MIN_SPEND;

  const setSpend = (text: string) => {
    setAmountText(text);
    onChange({ ...value, spend: parseFloat(text) || 0 });
  };
  const setSide = (side: Side) => onChange({ ...value, side });

  const question = value.kind === "existing" ? value.market.question : value.candidate.question;

  return (
    <View style={{ borderWidth: 1, borderColor: t.blue, borderRadius: radius.lg, padding: space.md, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Ionicons name="stats-chart" size={15} color={t.blue} style={{ marginTop: 2 }} />
        <Text style={{ color: t.text, fontWeight: "700", fontSize: 14, flex: 1 }}>{question}</Text>
        <Pressable onPress={onDetach} hitSlop={8}>
          <Ionicons name="close-circle" size={20} color={t.textFaint} />
        </Pressable>
      </View>
      {isNew ? (
        <Text style={{ color: t.blue, fontSize: 12, fontWeight: "700" }}>NEW MARKET · you open it with your bet</Text>
      ) : (
        <StateChip state={value.market.status} direction={value.market.direction} size="sm" />
      )}

      {/* Side toggle */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["yes", "no"] as Side[]).map((s) => {
          const active = value.side === s;
          const color = s === "yes" ? t.yes : t.no;
          return (
            <Pressable
              key={s}
              onPress={() => {
                tap();
                setSide(s);
              }}
              style={{
                flex: 1,
                backgroundColor: active ? color : s === "yes" ? t.yesTint : t.noTint,
                borderRadius: radius.md,
                paddingVertical: 9,
                alignItems: "center",
              }}
            >
              <Text style={{ color: active ? "#fff" : color, fontWeight: "800", fontSize: 13.5 }}>{s.toUpperCase()}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Spend amount */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: t.text, fontWeight: "800", fontSize: 18 }}>$</Text>
        <TextInput
          style={[inputStyle, { flex: 1 }]}
          keyboardType="decimal-pad"
          value={amountText}
          onChangeText={setSpend}
          placeholder={isNew ? "1.00 minimum" : "10.00"}
          placeholderTextColor={t.textFaint}
        />
      </View>
      {belowMin ? (
        <Text style={{ color: t.danger, fontSize: 12.5 }}>New markets need at least {dollars(NEW_MARKET_MIN_SPEND)} of opening capital.</Text>
      ) : null}

      {/* New market: sliding scale sets the maker price (bet percentage). */}
      {value.kind === "new" ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: t.textDim, fontSize: 12.5, fontWeight: "700" }}>
            How confident are you? Your price = the chance you're giving it.
          </Text>
          <PriceSlider
            side={value.side}
            value={value.priceCents}
            onChange={(p) => onChange({ ...value, priceCents: p })}
          />
        </View>
      ) : null}

      {shares > 0 ? (
        <Text style={{ color: t.textDim, fontSize: 13 }}>
          You pay <Text style={{ color: t.text, fontWeight: "800" }}>{dollars(pay)}</Text> to win{" "}
          <Text style={{ color: value.side === "yes" ? t.yes : t.no, fontWeight: "800" }}>{dollars(win)}</Text>
          {"  ·  "}
          {shares} share{shares === 1 ? "" : "s"} @ {price}¢
          {!isNew ? ` · est. fee ${dollars(takerFeeDollars(shares, price))}` : " · makers pay no fee"}
        </Text>
      ) : null}

      {/* Advanced for existing markets: limit price + order book preview */}
      {value.kind === "existing" ? (
        <>
          <Pressable onPress={() => setAdvanced((a) => !a)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name={advanced ? "chevron-down" : "chevron-forward"} size={15} color={t.textDim} />
            <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 12.5 }}>Advanced</Text>
          </Pressable>
          {advanced ? (
            <View style={{ gap: space.md, backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: space.md }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13 }}>Limit price</Text>
                <PriceStepper value={price} onChange={(p) => onChange({ ...value, limitPriceCents: p })} />
              </View>
              <OrderBook marketId={value.market.id} compact />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
