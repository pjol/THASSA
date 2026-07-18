import "../lib/polyfills";
import React from "react";
import { Pressable, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth";
import { SessionProvider } from "../lib/session";
import { ThemeProvider, useTheme } from "../lib/theme";
import { ToastProvider } from "../components/Toasts";
import { WarpBanner } from "../components/WarpBanner";
import { PushSync } from "../components/PushSync";
import { useWarpTarget } from "../lib/warpStore";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

// Provider stack (spec §10.10, Privy in place of Clerk):
// Privy(Auth) → QueryClient → Session → Theme → Toasts → Stack.
export default function RootLayout() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <SessionProvider>
            <ThemeProvider>
              <ToastProvider>
                <PushSync />
                <RootNav />
              </ToastProvider>
            </ThemeProvider>
          </SessionProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

// Explicit back arrow for pushed screens so there's always a visible way out.
function HeaderBack() {
  const router = useRouter();
  const t = useTheme();
  return (
    <Pressable onPress={() => router.back()} hitSlop={12} style={{ paddingRight: 14 }}>
      <Ionicons name="chevron-back" size={28} color={t.text} />
    </Pressable>
  );
}

function RootNav() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const warpTarget = useWarpTarget();
  const backOptions = { headerLeft: () => <HeaderBack /> };
  // While warped, the amber banner sits above the navigator and already clears
  // the status bar, so zero out the top inset for the navigator subtree (spec
  // §7c.3 "offset content so it doesn't overlap") — otherwise headers would add
  // a second status-bar gap beneath the banner.
  const navInsets = warpTarget ? { ...insets, top: 0 } : insets;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style={warpTarget ? "dark" : t.mode === "dark" ? "light" : "dark"} />
      <WarpBanner />
      <SafeAreaInsetsContext.Provider value={navInsets}>
        <View style={{ flex: 1 }}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: t.bg },
              headerTitleStyle: { color: t.text, fontWeight: "700" },
              headerTintColor: t.text,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: t.bg },
              animation: "slide_from_right",
            }}
          >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="post/[id]" options={{ title: "Post", ...backOptions }} />
        <Stack.Screen name="market/[id]" options={{ title: "Market", ...backOptions }} />
        <Stack.Screen name="user/[username]/index" options={{ title: "Profile", ...backOptions }} />
        <Stack.Screen name="user/[username]/connections" options={{ title: "People", ...backOptions }} />
        <Stack.Screen name="messages" options={{ title: "Messages", ...backOptions }} />
        <Stack.Screen name="conversation/[id]" options={{ title: "", ...backOptions }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications", ...backOptions }} />
        <Stack.Screen name="settings" options={{ title: "Settings", ...backOptions }} />
        <Stack.Screen name="admin" options={{ title: "Admin", ...backOptions }} />
        <Stack.Screen
          name="story-viewer"
          options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }}
        />
        <Stack.Screen
          name="story-camera"
          options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }}
        />
          </Stack>
        </View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
