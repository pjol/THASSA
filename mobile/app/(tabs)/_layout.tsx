import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Link, Tabs } from "expo-router";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LogoWordmark } from "../../components/Logo";
import { useSession } from "../../lib/session";
import { useTheme } from "../../lib/theme";
import { tap } from "../../lib/haptics";

// Bottom tabs (spec §7): Home, Explore, Create (raised center +), Reels,
// Profile — custom bar modeled on ASSEMBLY's, with the raised brand-blue
// center Create button. DMs + notifications hang off the Home header.

const TABS: { name: string; label: string; icon: keyof typeof Ionicons.glyphMap; center?: boolean }[] = [
  { name: "index", label: "Home", icon: "home" },
  { name: "explore", label: "Explore", icon: "search" },
  { name: "create", label: "Create", icon: "add", center: true },
  { name: "reels", label: "Reels", icon: "play-circle" },
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
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          headerLeft: () => (
            <View style={{ paddingLeft: 14 }}>
              <LogoWordmark size={26} />
            </View>
          ),
          headerRight: () => <HomeHeaderRight />,
        }}
      />
      <Tabs.Screen name="explore" options={{ headerShown: false }} />
      <Tabs.Screen name="create" options={{ headerTitle: () => <HeaderTitle title="New post" /> }} />
      <Tabs.Screen name="reels" options={{ headerShown: false }} />
      <Tabs.Screen name="profile" options={{ headerShown: false }} />
    </Tabs>
  );
}

function HeaderTitle({ title }: { title: string }) {
  const t = useTheme();
  return <Text style={{ color: t.text, fontWeight: "800", fontSize: 17 }}>{title}</Text>;
}

// Home header: notifications bell + DM icon, both with unread badges.
function HomeHeaderRight() {
  const t = useTheme();
  const { unreadNotifications, unreadMessages } = useSession();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 18, paddingRight: 16 }}>
      <Link href="/notifications" asChild>
        <Pressable hitSlop={8}>
          <Ionicons name="heart-outline" size={26} color={t.text} />
          {unreadNotifications > 0 ? <Badge count={unreadNotifications} /> : null}
        </Pressable>
      </Link>
      <Link href="/messages" asChild>
        <Pressable hitSlop={8}>
          <Ionicons name="paper-plane-outline" size={25} color={t.text} />
          {unreadMessages > 0 ? <Badge count={unreadMessages} /> : null}
        </Pressable>
      </Link>
    </View>
  );
}

function Badge({ count }: { count: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        position: "absolute",
        top: -4,
        right: -8,
        backgroundColor: t.no,
        minWidth: 17,
        height: 17,
        borderRadius: 9,
        borderWidth: 1.5,
        borderColor: t.bg,
        paddingHorizontal: 3,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{count > 9 ? "9+" : count}</Text>
    </View>
  );
}

function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: t.bg,
          borderTopColor: t.border,
          paddingBottom: insets.bottom,
          height: 62 + insets.bottom,
        },
      ]}
    >
      {state.routes.map((route, i) => {
        const cfg = TABS.find((x) => x.name === route.name) ?? TABS[i];
        const focused = state.index === i;
        const onPress = () => {
          tap();
          const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !e.defaultPrevented) navigation.navigate(route.name);
        };
        if (cfg.center) {
          // Raised brand-blue Create button.
          return (
            <Pressable key={route.key} onPress={onPress} style={styles.tab} accessibilityRole="button" accessibilityLabel="Create">
              <View
                style={[
                  styles.centerBtn,
                  { backgroundColor: t.blue, borderColor: t.bg, shadowColor: t.blue },
                ]}
              >
                <Ionicons name="add" color="#FFFFFF" size={30} />
              </View>
            </Pressable>
          );
        }
        const icon = (focused ? cfg.icon : `${cfg.icon}-outline`) as keyof typeof Ionicons.glyphMap;
        return (
          <Pressable key={route.key} onPress={onPress} style={styles.tab} accessibilityRole="button" accessibilityLabel={cfg.label}>
            <Ionicons name={icon} size={26} color={focused ? t.text : t.textDim} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: 1, paddingTop: 8 },
  tab: { flex: 1, alignItems: "center", justifyContent: "flex-start", paddingTop: 2 },
  centerBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -26,
    borderWidth: 4,
    shadowOpacity: 0.35,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
