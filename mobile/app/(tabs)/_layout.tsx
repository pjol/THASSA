import React, { useEffect, useRef } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Tabs } from "expo-router";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scrollTabToTop } from "../../lib/scrollToTop";
import { useTheme } from "../../lib/theme";
import { tap } from "../../lib/haptics";

// Bottom tabs (spec §7), ported from ASSEMBLY's sliding-bubble bar and
// re-themed for Thassa (a social prediction market — NOT Instagram):
//   Home · Watch · Upload(+) · Explore · Profile
// A brand-blue-tint "bubble" springs behind the active side tab and MORPHS
// into a circle as it approaches the raised center Create button, which
// recolors in sync with the bubble's arrival. Labels ride under every icon.

const TABS: {
  name: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  center?: boolean;
}[] = [
  { name: "index", label: "Home", icon: "home" },
  { name: "reels", label: "Watch", icon: "film" },
  { name: "create", label: "Upload", icon: "add", center: true },
  { name: "explore", label: "Explore", icon: "compass" },
  { name: "profile", label: "Profile", icon: "person-circle" },
];

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: t.bg, height: insets.top + 56 },
        headerShadowVisible: false,
        headerTintColor: t.text,
        headerTitle: () => null,
        // Slide/shift transition between tabs (react-navigation bottom-tabs v7).
        animation: "shift",
      }}
    >
      {/* Home renders its own floating app bar (hides on scroll down, returns
          on scroll up), so the navigator header is off. */}
      <Tabs.Screen name="index" options={{ headerShown: false }} />
      <Tabs.Screen name="reels" options={{ headerShown: false }} />
      <Tabs.Screen name="create" options={{ headerTitle: () => <HeaderTitle title="Upload" /> }} />
      <Tabs.Screen name="explore" options={{ headerShown: false }} />
      <Tabs.Screen name="profile" options={{ headerShown: false }} />
    </Tabs>
  );
}

function HeaderTitle({ title }: { title: string }) {
  const t = useTheme();
  return <Text style={{ color: t.text, fontWeight: "800", fontSize: 17 }}>{title}</Text>;
}

// Custom bottom bar with a sliding "bubble" behind the active side tab and a
// raised, recolor-on-arrival center Create button. Ported from ASSEMBLY's
// CustomTabBar (built-in Animated API, useNativeDriver:false so width/height/
// borderRadius can be interpolated for the morph), re-themed to Thassa blue.
function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tabW = width / state.routes.length;

  // Bubble geometry. PAD = horizontal inset within each tab slot so the bubble
  // stays a roomy rounded-rect around the icon+label; CIRCLE matches the raised
  // center button so the bubble morphs exactly into it at the Create tab.
  const PAD = 12;
  const RECT_W = tabW - PAD;
  const RECT_H = 50;
  const CIRCLE = 56;
  const centerIndex = TABS.findIndex((x) => x.center);
  const calX = centerIndex * tabW; // Create is the center (3rd) tab

  // JS-driven so width/height/borderRadius can be interpolated for the morph.
  const tx = useRef(new Animated.Value(state.index * tabW)).current;
  useEffect(() => {
    Animated.spring(tx, {
      toValue: state.index * tabW,
      useNativeDriver: false,
      friction: 11,
      tension: 95,
    }).start();
  }, [state.index, tabW, tx]);

  // 0 = rounded-rect bubble (normal travel); 1 = circle aligned to the Create
  // icon. The morph happens only in the last ~40% of the approach, so the
  // bubble slides along the bar as a rectangle and circularizes on arrival.
  const circleness = tx.interpolate({
    inputRange: [calX - tabW * 0.42, calX, calX + tabW * 0.42],
    outputRange: [0, 1, 0],
    extrapolate: "clamp",
  });
  const lerp = (a: number, b: number) =>
    circleness.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const bubbleW = lerp(RECT_W, CIRCLE);
  const bubbleH = lerp(RECT_H, CIRCLE);
  const bubbleR = lerp(16, CIRCLE / 2);
  const bubbleY = lerp(0, -20); // rise toward the raised center icon
  const bubbleX = Animated.add(tx, lerp(PAD / 2, (tabW - CIRCLE) / 2)); // stay centered as it shrinks
  // Fade out only at the very end so the bubble is invisible at rest on Create,
  // but the slide/morph stays visible while tabbing over or away.
  const bubbleOpacity = circleness.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 1, 0] });

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: t.bg,
          borderTopColor: t.border,
          paddingBottom: insets.bottom,
          height: 70 + insets.bottom,
        },
      ]}
    >
      {/* Sliding bubble: brand-blue tint fill + brand outline; morphs into a
          circle (and fades) as it approaches the raised Create tab. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.bubble,
          {
            width: bubbleW,
            height: bubbleH,
            borderRadius: bubbleR,
            backgroundColor: t.blueTint,
            borderColor: t.blue,
            opacity: bubbleOpacity,
            transform: [{ translateX: bubbleX }, { translateY: bubbleY }],
          },
        ]}
      />
      {state.routes.map((route, i) => {
        const cfg = TABS.find((x) => x.name === route.name) ?? TABS[i];
        const focused = state.index === i;
        const onPress = () => {
          tap();
          const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          // Re-tapping the active tab scrolls its screen back to the top
          // (screens register handlers in lib/scrollToTop).
          if (focused) scrollTabToTop(route.name);
          else if (!e.defaultPrevented) navigation.navigate(route.name);
        };
        if (cfg.center) {
          // Raised Upload button. Inactive: brand-blue fill + white "+".
          // Active (Upload tab focused): inverts to a light fill with a blue
          // ring + blue "+", so the tab reads as selected.
          const active = focused;
          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={styles.tab}
              accessibilityRole="button"
              accessibilityLabel="Upload"
            >
              <View
                style={[
                  styles.centerBtn,
                  {
                    backgroundColor: active ? t.bg : t.blue,
                    borderColor: t.blue,
                    shadowColor: t.blue,
                  },
                ]}
              >
                <Ionicons name="add" color={active ? t.blue : "#FFFFFF"} size={30} />
              </View>
              <Text style={[styles.label, { color: active ? t.blue : t.textDim }]}>{cfg.label}</Text>
            </Pressable>
          );
        }
        const icon = (focused ? cfg.icon : `${cfg.icon}-outline`) as keyof typeof Ionicons.glyphMap;
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            style={styles.tab}
            accessibilityRole="button"
            accessibilityLabel={cfg.label}
          >
            <Ionicons name={icon} size={24} color={focused ? t.blue : t.textDim} />
            <Text style={[styles.label, { color: focused ? t.blue : t.textDim }]}>{cfg.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: 1, paddingTop: 9 },
  // top inset so the bubble doesn't touch the top edge of the bar; left:0 with
  // the translateX offset centers it in each tab slot.
  bubble: { position: "absolute", top: 7, left: 0, borderWidth: 2 },
  tab: { flex: 1, alignItems: "center", justifyContent: "flex-start", gap: 3, paddingTop: 4 },
  label: { fontSize: 11, fontWeight: "700" },
  centerBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -24,
    borderWidth: 4,
    shadowOpacity: 0.35,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
