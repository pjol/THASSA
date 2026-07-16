import { Linking, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../lib/theme";
import type { Market, Settlement } from "../lib/types";

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
  const s = market.settlement;
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
  const s = market.settlement;
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
      <View>
        <Text style={{ color: t.textFaint, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginBottom: 4 }}>
          PUBLIC SETTLEMENT QUERY
        </Text>
        <Text style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>{market.settlement_query}</Text>
      </View>
    </View>
  );
}
