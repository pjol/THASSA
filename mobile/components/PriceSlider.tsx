import React, { useRef, useState } from "react";
import { PanResponder, Text, View } from "react-native";
import { useTheme } from "../lib/theme";
import { tap } from "../lib/haptics";

// Custom 1–99¢ sliding scale for maker price / bet percentage (spec §7 create
// flow). Shows the YES/NO split visually: left of the thumb = what YOU pay,
// right = what the other side pays. No native dependency.

export function PriceSlider({
  value,
  onChange,
  side = "yes",
}: {
  value: number; // cents, 1..99
  onChange: (v: number) => void;
  side?: "yes" | "no";
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastHaptic = useRef(value);
  // The PanResponder below is created once and permanently captures the
  // closures from the FIRST render. Route onChange through a ref that we keep
  // pointed at the latest prop, so a drag always calls the CURRENT onChange —
  // otherwise it would spread a stale parent value (e.g. reverting the chosen
  // YES/NO side to its initial default whenever the slider moves).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clamp = (v: number) => Math.max(1, Math.min(99, Math.round(v)));

  const setFromX = (x: number) => {
    if (widthRef.current <= 0) return;
    const v = clamp((x / widthRef.current) * 100);
    if (v !== valueRef.current) {
      if (Math.abs(v - lastHaptic.current) >= 5) {
        lastHaptic.current = v;
        tap();
      }
      onChangeRef.current(v);
    }
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => setFromX(e.nativeEvent.locationX),
      onPanResponderMove: (e) => setFromX(e.nativeEvent.locationX),
    })
  ).current;

  const pct = value / 100;
  const fill = side === "yes" ? t.yes : t.no;
  const rest = side === "yes" ? t.no : t.yes;

  return (
    <View>
      <View
        {...pan.panHandlers}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          widthRef.current = e.nativeEvent.layout.width;
        }}
        style={{ height: 44, justifyContent: "center" }}
      >
        <View style={{ height: 10, borderRadius: 5, backgroundColor: rest, overflow: "hidden" }}>
          <View
            style={{
              width: Math.max(0, pct * width),
              height: 10,
              backgroundColor: fill,
              borderTopRightRadius: 5,
              borderBottomRightRadius: 5,
            }}
          />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: Math.max(0, Math.min(width - 28, pct * width - 14)),
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: t.bg,
            borderWidth: 3,
            borderColor: fill,
            shadowColor: "#000",
            shadowOpacity: 0.2,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
        <Text style={{ color: fill, fontWeight: "800", fontSize: 13 }}>
          {side.toUpperCase()} {value}¢
        </Text>
        <Text style={{ color: rest, fontWeight: "800", fontSize: 13 }}>
          {side === "yes" ? "NO" : "YES"} {100 - value}¢
        </Text>
      </View>
    </View>
  );
}
