import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { radius, SETTLING_AMBER, useTheme } from "../lib/theme";
import { useSession } from "../lib/session";
import { useWarp } from "../lib/warp";
import { LogoSpinner } from "./LogoSpinner";

// Persistent warp banner (spec §7c.3). Rendered in the root layout above the
// navigator: while an admin is impersonating a user, an unmistakable amber bar
// reads "Viewing as @username — Exit warp." Exit clears the target + header and
// refetches as the real admin. Renders nothing when not warped.
export function WarpBanner() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const { isWarped, target, exit } = useWarp();
  const [exiting, setExiting] = useState(false);

  if (!isWarped) return null;

  // Prefer the authoritative name from /v1/me.warp; fall back to the persisted
  // summary while /v1/me is still in flight after entering warp.
  const username = me?.warp?.viewing?.username ?? target?.username ?? "user";
  // High-contrast ink on amber in both themes.
  const ink = "#1A1205";

  const onExit = async () => {
    if (exiting) return;
    setExiting(true);
    try {
      await exit();
    } finally {
      setExiting(false);
    }
  };

  return (
    <View style={{ backgroundColor: SETTLING_AMBER, paddingTop: insets.top }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 14,
          paddingVertical: 9,
          minHeight: 44,
        }}
      >
        <Ionicons name="eye" size={17} color={ink} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: ink, fontWeight: "800", fontSize: 13.5 }} numberOfLines={1}>
            Viewing as @{username}
          </Text>
          <Text style={{ color: "rgba(26,18,5,0.7)", fontSize: 11.5 }} numberOfLines={1}>
            Read-only admin warp
          </Text>
        </View>
        <Pressable
          onPress={onExit}
          disabled={exiting}
          hitSlop={8}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            backgroundColor: ink,
            borderRadius: radius.full,
            paddingHorizontal: 14,
            paddingVertical: 7,
            opacity: exiting ? 0.6 : 1,
          }}
        >
          {exiting ? (
            <LogoSpinner size={18} color={SETTLING_AMBER} />
          ) : (
            <Ionicons name="arrow-undo" size={14} color={SETTLING_AMBER} />
          )}
          <Text style={{ color: SETTLING_AMBER, fontWeight: "800", fontSize: 13 }}>Exit warp</Text>
        </Pressable>
      </View>
    </View>
  );
}
