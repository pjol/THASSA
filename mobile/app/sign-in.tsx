import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useLoginWithEmail, useLoginWithOAuth } from "@privy-io/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LogoWordmark } from "../components/Logo";
import { Button, useInputStyle } from "../components/ui";
import { space, useTheme } from "../lib/theme";
import { success, warn } from "../lib/haptics";

// Privy login (spec §6.1/§7): email OTP + social OAuth. On success the entry
// gate re-routes to onboarding/tabs.
export default function SignIn() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const inputStyle = useInputStyle();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);

  // Surface the real Privy error (its message usually names the actual cause —
  // e.g. missing/invalid app id or client id, unconfigured login method, wrong
  // code) instead of a generic string that hides configuration problems.
  const describe = (err: unknown, fallback: string) => {
    const raw =
      (err as { message?: string } | null)?.message ??
      (typeof err === "string" ? err : "");
    if (__DEV__ && raw) console.warn("[privy] sign-in error:", err);
    return raw ? `${fallback} (${raw})` : fallback;
  };

  const { sendCode, loginWithCode, state } = useLoginWithEmail({
    onError: (err) => {
      warn();
      setError(describe(err, "That didn't work. Check the address / code and try again."));
    },
    onLoginSuccess: () => {
      success();
      router.replace("/");
    },
  });
  const oauth = useLoginWithOAuth({
    onSuccess: () => {
      success();
      router.replace("/");
    },
    onError: (err) => {
      warn();
      setError(describe(err, "Social sign-in didn't complete. Try again."));
    },
  });

  // Guard: if Privy isn't configured, say so plainly rather than failing on send.
  const privyConfigured = !!(process.env.EXPO_PUBLIC_PRIVY_APP_ID || "").trim();

  const busy = state.status === "sending-code" || state.status === "submitting-code" || oauth.state.status === "loading";

  const submitEmail = async () => {
    setError(null);
    if (!privyConfigured) {
      setError(
        "Sign-in isn't configured: EXPO_PUBLIC_PRIVY_APP_ID is missing. Set it in mobile/.env (and add EXPO_PUBLIC_PRIVY_CLIENT_ID from the Privy dashboard's App clients).",
      );
      return;
    }
    try {
      await sendCode({ email: email.trim() });
      setStage("code");
    } catch {
      /* onError shows the message */
    }
  };

  const submitCode = async () => {
    setError(null);
    try {
      await loginWithCode({ code: code.trim(), email: email.trim() });
    } catch {
      /* onError shows the message */
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}
    >
      <View style={{ flex: 1, padding: space.xl, justifyContent: "center", gap: space.lg }}>
        <View style={{ alignItems: "center", marginBottom: space.xl }}>
          <LogoWordmark size={44} />
          <Text style={{ color: t.textDim, fontSize: 15, marginTop: 10, textAlign: "center" }}>
            Post it. Bet on it.
          </Text>
        </View>

        {stage === "email" ? (
          <>
            <TextInput
              style={inputStyle}
              placeholder="Email address"
              placeholderTextColor={t.textFaint}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <Button
              title="Continue"
              onPress={submitEmail}
              loading={state.status === "sending-code"}
              disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || busy}
            />
          </>
        ) : (
          <>
            <Text style={{ color: t.textDim, textAlign: "center", fontSize: 14 }}>
              We sent a code to <Text style={{ color: t.text, fontWeight: "700" }}>{email.trim()}</Text>
            </Text>
            <TextInput
              style={[inputStyle, { textAlign: "center", fontSize: 22, letterSpacing: 8, fontWeight: "700" }]}
              placeholder="000000"
              placeholderTextColor={t.textFaint}
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={setCode}
              autoFocus
            />
            <Button
              title="Sign in"
              onPress={submitCode}
              loading={state.status === "submitting-code"}
              disabled={code.trim().length < 6 || busy}
            />
            <Pressable onPress={() => setStage("email")}>
              <Text style={{ color: t.blue, textAlign: "center", fontWeight: "600" }}>Use a different email</Text>
            </Pressable>
          </>
        )}

        {error ? <Text style={{ color: t.danger, textAlign: "center", fontSize: 13 }}>{error}</Text> : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 4 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
          <Text style={{ color: t.textFaint, fontSize: 12.5 }}>or</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
        </View>

        <View style={{ gap: 10 }}>
          <SocialButton
            icon="logo-google"
            label="Continue with Google"
            onPress={() => oauth.login({ provider: "google" })}
          />
          {Platform.OS === "ios" ? (
            <SocialButton
              icon="logo-apple"
              label="Continue with Apple"
              onPress={() => oauth.login({ provider: "apple" })}
            />
          ) : null}
        </View>

        <Text style={{ color: t.textFaint, fontSize: 11.5, textAlign: "center", marginTop: space.md }}>
          A gasless embedded wallet is created for you automatically. You never pay gas on Thassa.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function SocialButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        borderWidth: 1.5,
        borderColor: t.borderStrong,
        borderRadius: 999,
        paddingVertical: 13,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={19} color={t.text} />
      <Text style={{ color: t.text, fontWeight: "700", fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}
