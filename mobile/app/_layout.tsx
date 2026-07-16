import "../lib/polyfills";
import React from "react";
import { Pressable } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth";
import { SessionProvider } from "../lib/session";
import { ThemeProvider, useTheme } from "../lib/theme";
import { ToastProvider } from "../components/Toasts";

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
  const backOptions = { headerLeft: () => <HeaderBack /> };
  return (
    <>
      <StatusBar style={t.mode === "dark" ? "light" : "dark"} />
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
        <Stack.Screen name="user/[username]" options={{ title: "Profile", ...backOptions }} />
        <Stack.Screen name="messages" options={{ title: "Messages", ...backOptions }} />
        <Stack.Screen name="conversation/[id]" options={{ title: "", ...backOptions }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications", ...backOptions }} />
        <Stack.Screen name="settings" options={{ title: "Settings", ...backOptions }} />
        <Stack.Screen
          name="story-viewer"
          options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }}
        />
      </Stack>
    </>
  );
}
