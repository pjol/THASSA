import { Linking, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../lib/theme";
import type { Market, Settlement } from "../lib/types";

// settlementOf assembles the structured settlement for a market. The backend
// sends category/rule/sources as FLAT fields on the market (denormalized at
// creation); older payloads may carry a pre-assembled `settlement` object;
// the stored settlement-query JSON is the last resort. This is the ONE place
// that decides how settlement details are derived for display.
export function settlementOf(market: Market): Settlement | null {
  if (market.settlement && market.settlement.sources?.length) return market.settlement;
  if (market.rule && market.sources && market.sources.length > 0) {
    let question = market.question;
    try {
      const p = JSON.parse(market.settlement_query || "{}");
      if (typeof p.question === "string" && p.question) question = p.question;
    } catch {
      /* keep market.question */
    }
    return {
      question,
      category: market.category ?? null,
      rule: market.rule as Settlement["rule"],
      sources: market.sources,
    };
  }
  try {
    const p = JSON.parse(market.settlement_query || "{}");
    if (p && (p.rule === "single" || p.rule === "majority") && Array.isArray(p.sources) && p.sources.length > 0) {
      return { question: p.question ?? market.question, category: p.category ?? null, rule: p.rule, sources: p.sources };
    }
  } catch {
    /* unparsable legacy query */
  }
  return null;
}

// Resolution transparency (spec §6.5b): every market shows exactly how it
// settles — the settlement question, the rule, and tappable sources.
// Single-source markets (weather/price feeds) always name their one
// authoritative source.

export function resolutionRuleCopy(s: Settlement): string {
  if (s.rule === "single") {
    return `Resolves via ${s.sources[0]?.name ?? "its source"}`;
  }
  const names = s.sources.map((x) => x.name).join(", ");
  return `Resolves when a majority of ${names} concur`;
}

// Compact "via ESPN"-style caption for market cards, next to the StateChip.
export function ResolutionCaption({ market }: { market: Market }) {
  const t = useTheme();
  const s = settlementOf(market);
  if (!s || s.sources.length === 0) return null;
  const label =
    s.rule === "single"
      ? `via ${s.sources[0]?.name}`
      : `via majority of ${s.sources.length} sources`;
  return (
    <Text style={{ color: t.textFaint, fontSize: 11.5 }} numberOfLines={1}>
      {label}
    </Text>
  );
}

// Full transparency block for Advanced expanders / the market detail screen:
// question · rule · tappable source names · the raw public settlement query.
export function ResolutionBlock({ market }: { market: Market }) {
  const t = useTheme();
  const s = settlementOf(market);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.textFaint, fontSize: 11, fontWeight: "800", letterSpacing: 0.6 }}>
        HOW THIS MARKET SETTLES
      </Text>
      {s ? (
        <>
          <Text style={{ color: t.text, fontSize: 13.5, lineHeight: 19 }}>{s.question}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name={s.rule === "single" ? "flag-outline" : "people-outline"} size={13} color={t.blue} />
            <Text style={{ color: t.blue, fontSize: 12.5, fontWeight: "700", flex: 1 }}>
              {resolutionRuleCopy(s)}
            </Text>
          </View>
          {s.category ? (
            <Text style={{ color: t.textFaint, fontSize: 11.5 }}>Category: {s.category}</Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {s.sources.map((src) => (
              <Pressable
                key={src.id}
                onPress={() => Linking.openURL(src.url).catch(() => {})}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  backgroundColor: t.blueTint,
                  borderRadius: 999,
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
        </>
      ) : null}
      {/* When the structured settlement is missing, parse the stored query
          JSON and render its fields instead of the raw blob (raw text only as
          a last resort for unparsable queries). */}
      {!s ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: t.textFaint, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginBottom: 4 }}>
            PUBLIC SETTLEMENT QUERY
          </Text>
          <ParsedQuery raw={market.settlement_query} />
        </View>
      ) : null}
    </View>
  );
}

// Pretty-printed settlement query: parses the stored JSON and lays out the
// question / category / rule / sources as readable rows. Settlement JSON is
// NEVER shown raw anywhere — raw text renders only for legacy unparsable
// queries. Reused by MarketDetails' candidate preview.
export function ParsedQuery({ raw }: { raw: string }) {
  const t = useTheme();
  let parsed: {
    question?: string;
    category?: string;
    rule?: string;
    sources?: { id?: string; name?: string; url?: string }[];
  } | null = null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") parsed = v;
  } catch {
    // not JSON — fall through to raw text
  }
  if (!parsed) {
    return <Text style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>{raw}</Text>;
  }
  const row = (label: string, value: string) => (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ color: t.textDim, fontSize: 12.5, width: 74 }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: 12.5, flex: 1, fontWeight: "600" }}>{value}</Text>
    </View>
  );
  return (
    <View style={{ gap: 5 }}>
      {parsed.question ? row("Question", parsed.question) : null}
      {parsed.category ? row("Category", parsed.category) : null}
      {parsed.rule ? row("Rule", parsed.rule === "majority" ? "Majority of sources" : "Single source") : null}
      {parsed.sources?.length
        ? row("Sources", parsed.sources.map((x) => x.name || x.id || x.url || "?").join(", "))
        : null}
    </View>
  );
}
