import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage, useApi } from "../lib/api";
import { useAuth, useWallet } from "../lib/auth";
import { success, warn } from "../lib/haptics";
import { useSession } from "../lib/session";
import { space, useTheme } from "../lib/theme";
import type { Me } from "../lib/types";
import { ConfirmModal } from "../components/ConfirmModal";
import { Avatar, Button, Field, useInputStyle } from "../components/ui";

// Validate a profile link (regex-based — RN/Hermes has no reliable URL parser).
// A missing scheme defaults to https; requires an http(s) URL whose host has a
// dot (a real domain).
function isValidUrl(raw: string): boolean {
  const s = raw.includes("://") ? raw : `https://${raw}`;
  return /^https?:\/\/[^\s./]+\.[^\s]+$/i.test(s);
}

// Onboarding (username, avatar, bio, link) — also reused as "Edit profile"
// via ?edit=1. Ensures the embedded wallet exists before finishing so the
// backend can capture the wallet address.
export default function Onboarding() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const inputStyle = useInputStyle();
  const { me, setMe, refresh } = useSession();
  const { ensureWallet } = useWallet();
  const { logout } = useAuth();
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  const isEdit = edit === "1";

  const [username, setUsername] = useState(me?.username ?? "");
  const [displayNameV, setDisplayNameV] = useState(me?.display_name ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [link, setLink] = useState(me?.links?.[0] ?? "");
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const pickAvatar = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!res.canceled && res.assets[0]) setAvatarUri(res.assets[0].uri);
  };

  const submit = async () => {
    const trimmedLink = link.trim();
    if (trimmedLink && !isValidUrl(trimmedLink)) {
      setError("Enter a valid link, e.g. https://example.com");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Make sure the embedded wallet exists (gasless orders need it).
      if (!isEdit) await ensureWallet().catch(() => {});

      let avatar_url: string | undefined;
      if (avatarUri) {
        const up = await api.uploadMedia(avatarUri, "image/jpeg");
        avatar_url = up.url;
      }
      const res = await api.patch<{ me: Me }>("/v1/me", {
        username: username.trim().toLowerCase(),
        display_name: displayNameV.trim() || null,
        bio: bio.trim() || null,
        links: trimmedLink ? [trimmedLink] : [],
        ...(avatar_url ? { avatar_url } : {}),
      });
      setMe(() => res.me);
      await refresh();
      success();
      router.replace(isEdit ? "/(tabs)/profile" : "/");
    } catch (e) {
      warn();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const usernameOk = /^[a-z0-9_.]{3,24}$/.test(username.trim().toLowerCase());

  // Back button: while editing, just go back; during signup it cancels the
  // whole signup and logs the user out (after confirmation via the branded
  // ConfirmModal — whitelabel rule: no native Alert.alert).
  const onBack = () => {
    if (isEdit) {
      router.back();
      return;
    }
    setConfirmCancel(true);
  };

  const cancelSignup = async () => {
    setCancelling(true);
    // Privy's SDK clears local auth even when its remote session call
    // fails (it only console.warns "Error destroying session") — but
    // nothing auto-navigates this standalone route, so route to
    // sign-in explicitly after the session is gone.
    try {
      await logout();
    } catch {
      /* local state is cleared regardless */
    }
    router.replace("/sign-in");
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: space.xl, paddingTop: insets.top + space.xl, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={onBack}
          hitSlop={10}
          accessibilityLabel={isEdit ? "Go back" : "Cancel signup and log out"}
          style={{ marginBottom: space.md, alignSelf: "flex-start", padding: 4, marginLeft: -4 }}
        >
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={{ color: t.text, fontSize: 26, fontWeight: "800", marginBottom: 4 }}>
          {isEdit ? "Edit profile" : "Set up your profile"}
        </Text>
        <Text style={{ color: t.textDim, fontSize: 14.5, marginBottom: space.xl }}>
          {isEdit ? "Update how you show up on Thassa." : "Pick a username — you can change everything later."}
        </Text>

        <Pressable onPress={pickAvatar} style={{ alignSelf: "center", marginBottom: space.xl }}>
          <Avatar url={avatarUri ?? me?.avatar_url} size={96} />
          <View
            style={{
              position: "absolute",
              bottom: 0,
              right: 0,
              backgroundColor: t.blue,
              width: 30,
              height: 30,
              borderRadius: 15,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 2,
              borderColor: t.bg,
            }}
          >
            <Ionicons name="camera" size={15} color="#fff" />
          </View>
        </Pressable>

        <Field label="Username" hint="3–24 characters: letters, numbers, dots, underscores.">
          <TextInput
            style={inputStyle}
            placeholder="yourname"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
          />
        </Field>
        <Field label="Display name">
          <TextInput
            style={inputStyle}
            placeholder="Your Name"
            placeholderTextColor={t.textFaint}
            value={displayNameV}
            onChangeText={setDisplayNameV}
          />
        </Field>
        <Field label="Bio">
          <TextInput
            style={[inputStyle, { minHeight: 80, textAlignVertical: "top" }]}
            placeholder="Say something about yourself…"
            placeholderTextColor={t.textFaint}
            multiline
            value={bio}
            onChangeText={setBio}
          />
        </Field>
        <Field label="Link">
          <TextInput
            style={inputStyle}
            placeholder="https://example.com"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={link}
            onChangeText={setLink}
          />
        </Field>

        {error ? <Text style={{ color: t.danger, fontSize: 13, marginBottom: space.md }}>{error}</Text> : null}
        <Button
          title={isEdit ? "Save" : "Let's go"}
          onPress={submit}
          loading={busy}
          disabled={!usernameOk}
        />
      </ScrollView>

      <ConfirmModal
        visible={confirmCancel}
        title="Cancel your signup?"
        message="Are you sure you want to cancel your signup? You'll be logged out and your profile won't be saved."
        cancelLabel="Keep going"
        confirmLabel="Log out"
        destructive
        loading={cancelling}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={cancelSignup}
      />
    </KeyboardAvoidingView>
  );
}
