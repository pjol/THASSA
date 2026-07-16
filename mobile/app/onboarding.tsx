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
import { useWallet } from "../lib/auth";
import { success, warn } from "../lib/haptics";
import { useSession } from "../lib/session";
import { space, useTheme } from "../lib/theme";
import type { Me } from "../lib/types";
import { Avatar, Button, Field, useInputStyle } from "../components/ui";

// Onboarding (username, avatar, bio, links) — also reused as "Edit profile"
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
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  const isEdit = edit === "1";

  const [username, setUsername] = useState(me?.username ?? "");
  const [displayNameV, setDisplayNameV] = useState(me?.display_name ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [links, setLinks] = useState((me?.links ?? []).join("\n"));
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const updated = await api.patch<Me>("/v1/me", {
        username: username.trim().toLowerCase(),
        display_name: displayNameV.trim() || null,
        bio: bio.trim() || null,
        links: links
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
        ...(avatar_url ? { avatar_url } : {}),
      });
      setMe(() => updated);
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

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: space.xl, paddingTop: insets.top + space.xl, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
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
        <Field label="Links" hint="One per line.">
          <TextInput
            style={[inputStyle, { minHeight: 60, textAlignVertical: "top" }]}
            placeholder="yoursite.com"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            value={links}
            onChangeText={setLinks}
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
    </KeyboardAvoidingView>
  );
}
