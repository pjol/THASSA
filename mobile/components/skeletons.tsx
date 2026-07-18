import React from "react";
import { useWindowDimensions, View } from "react-native";
import { space } from "../lib/theme";
import { Skeleton } from "./ui";

// Shared first-load skeletons (loading-states rule): every list/screen shows a
// content-shaped pulse instead of a bare spinner on its FIRST load. All blocks
// reuse the themed `Skeleton` primitive (Animated opacity loop) from ui.tsx.

// Feed post: avatar circle + name lines + media block + caption line.
export function PostCardSkeleton() {
  return (
    <View style={{ paddingHorizontal: space.md, marginBottom: space.xl, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Skeleton style={{ width: 36, height: 36, borderRadius: 18 }} />
        <View style={{ gap: 5 }}>
          <Skeleton style={{ width: 120, height: 12 }} />
          <Skeleton style={{ width: 64, height: 9 }} />
        </View>
      </View>
      <Skeleton style={{ width: "100%", height: 320, borderRadius: 4 }} />
      <Skeleton style={{ width: "70%", height: 12 }} />
    </View>
  );
}

// Market row: question line + two price-pill blocks.
export function MarketCardSkeleton() {
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 13, gap: 10 }}>
      <Skeleton style={{ width: "85%", height: 14 }} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Skeleton style={{ width: 74, height: 22, borderRadius: 11 }} />
        <Skeleton style={{ width: 74, height: 22, borderRadius: 11 }} />
      </View>
    </View>
  );
}

// Generic list row: avatar + two lines (followers, conversations,
// notifications, comments).
export function ListRowSkeleton({ avatarSize = 44 }: { avatarSize?: number }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: space.md,
        paddingVertical: 11,
      }}
    >
      <Skeleton style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton style={{ width: "45%", height: 12 }} />
        <Skeleton style={{ width: "70%", height: 10 }} />
      </View>
    </View>
  );
}

// Convenience: a column of list rows for a whole first-load screen.
export function ListRowsSkeleton({ rows = 8, avatarSize }: { rows?: number; avatarSize?: number }) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <ListRowSkeleton key={i} avatarSize={avatarSize} />
      ))}
    </View>
  );
}

// Profile: header block (avatar + stats + bio lines + action pill) + 3-col grid.
export function ProfileSkeleton() {
  const { width } = useWindowDimensions();
  const cell = width / 3;
  return (
    <View>
      <View style={{ padding: space.lg, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
          <Skeleton style={{ width: 84, height: 84, borderRadius: 42 }} />
          <View style={{ flex: 1, flexDirection: "row", justifyContent: "space-around" }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={{ alignItems: "center", gap: 6 }}>
                <Skeleton style={{ width: 34, height: 16 }} />
                <Skeleton style={{ width: 52, height: 10 }} />
              </View>
            ))}
          </View>
        </View>
        <View style={{ gap: 7 }}>
          <Skeleton style={{ width: 140, height: 13 }} />
          <Skeleton style={{ width: 90, height: 11 }} />
          <Skeleton style={{ width: "80%", height: 11 }} />
        </View>
        <Skeleton style={{ width: "100%", height: 36, borderRadius: 10 }} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} style={{ width: cell - 2, height: cell - 2, margin: 1, borderRadius: 2 }} />
        ))}
      </View>
    </View>
  );
}
