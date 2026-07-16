import { Text, View } from "react-native";
import { useTheme } from "../lib/theme";
import type { MarketState, OrderState } from "../lib/types";

// One-word state chips (spec §5) — used verbatim, consistent colors:
// PENDING/QUEUED/SIGNING gray · OPEN blue · MATCHED/FILLED green · SETTLING
// amber · SETTLED black(light)/white(dark) + direction badge · VOID/CANCELED
// muted red · RESTING blue-outline · PARTIAL green-outline.

export function StateChip({
  state,
  direction,
  size = "md",
}: {
  state: MarketState | OrderState;
  // For SETTLED markets: true = YES, false = NO.
  direction?: boolean | null;
  size?: "sm" | "md";
}) {
  const t = useTheme();

  let bg = t.grayTint;
  let fg = t.gray;
  switch (state) {
    case "PENDING":
    case "QUEUED":
    case "SIGNING":
      bg = t.grayTint;
      fg = t.gray;
      break;
    case "OPEN":
    case "RESTING":
      bg = t.blueTint;
      fg = t.blue;
      break;
    case "MATCHED":
    case "FILLED":
    case "PARTIAL":
      bg = t.yesTint;
      fg = t.yes;
      break;
    case "SETTLING":
      bg = t.amberTint;
      fg = t.amber;
      break;
    case "SETTLED":
      bg = t.accent;
      fg = t.onAccent;
      break;
    case "VOID":
    case "CANCELED":
      bg = t.noTint;
      fg = t.mutedRed;
      break;
  }

  const fontSize = size === "sm" ? 10 : 11.5;
  const padV = size === "sm" ? 3 : 4;
  const padH = size === "sm" ? 8 : 10;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View
        style={{
          backgroundColor: bg,
          paddingVertical: padV,
          paddingHorizontal: padH,
          borderRadius: 999,
        }}
      >
        <Text style={{ color: fg, fontWeight: "800", fontSize, letterSpacing: 0.8 }}>{state}</Text>
      </View>
      {state === "SETTLED" && direction !== null && direction !== undefined ? (
        <DirectionBadge direction={direction} size={size} />
      ) : null}
    </View>
  );
}

export function DirectionBadge({ direction, size = "md" }: { direction: boolean; size?: "sm" | "md" }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: direction ? t.yes : t.no,
        paddingVertical: size === "sm" ? 3 : 4,
        paddingHorizontal: size === "sm" ? 8 : 10,
        borderRadius: 999,
      }}
    >
      <Text style={{ color: "#FFFFFF", fontWeight: "800", fontSize: size === "sm" ? 10 : 11.5, letterSpacing: 0.8 }}>
        {direction ? "YES" : "NO"}
      </Text>
    </View>
  );
}

export function SideBadge({ side, size = "md" }: { side: "yes" | "no"; size?: "sm" | "md" }) {
  return <DirectionBadge direction={side === "yes"} size={size} />;
}
