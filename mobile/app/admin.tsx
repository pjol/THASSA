import React, { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { errorMessage, useApi } from "../lib/api";
import { useSession } from "../lib/session";
import { useWarp } from "../lib/warp";
import { radius, space, useTheme } from "../lib/theme";
import { useToasts } from "../components/Toasts";
import { Avatar, Button, useInputStyle } from "../components/ui";
import type { AdminUser } from "../lib/types";
import { LogoSpinner } from "../components/LogoSpinner";

// Admin user search + warp (spec §7c.3). Reachable from Settings when the real
// user is an admin and not already warped. Search users by email or username,
// then "Warp" into one to view the app entirely as that user.
export default function Admin() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const toasts = useToasts();
  const inputStyle = useInputStyle();
  const { me } = useSession();
  const { enter } = useWarp();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [warpingId, setWarpingId] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guard: only real admins (never while warped) can reach this surface.
  const blocked = !me?.is_admin || !!me?.warp?.active;

  // Debounced search over GET /v1/admin/users?q= (real-admin gated server-side).
  useEffect(() => {
    if (blocked) return;
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      api
        .get<{ users: AdminUser[] }>(`/v1/admin/users?q=${encodeURIComponent(q)}`)
        .then((r) => setResults(r.users ?? []))
        .catch((e) => {
          setResults([]);
          toasts.show({ title: "Search failed", body: errorMessage(e), icon: "alert-circle" });
        })
        .finally(() => {
          setSearching(false);
          setSearched(true);
        });
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, api, blocked, toasts]);

  const warpInto = async (u: AdminUser) => {
    setWarpingId(u.id);
    try {
      // Validate the target exists via POST /v1/admin/warp; the returned summary
      // is what we persist (the X-Thassa-Warp header is the real mechanism).
      const res = await api.post<{ user: AdminUser }>("/v1/admin/warp", { user_id: u.id });
      await enter(res.user ?? u);
    } catch (e) {
      toasts.show({ title: "Couldn't warp", body: errorMessage(e), icon: "alert-circle" });
      setWarpingId(null);
    }
  };

  if (blocked) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center", padding: space.xl }}>
        <Ionicons name="lock-closed-outline" size={34} color={t.textFaint} />
        <Text style={{ color: t.textDim, marginTop: 10, textAlign: "center" }}>
          Admin tools aren't available here.
        </Text>
        <View style={{ height: 14 }} />
        <Button title="Go back" variant="subtle" small onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ padding: space.lg, gap: 10 }}>
        <Text style={{ color: t.textDim, fontSize: 13, lineHeight: 18 }}>
          Search a user by email or username, then warp in to view the app as them. Warp is
          read-only — you can't act on their behalf.
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, position: "relative", justifyContent: "center" }}>
            <TextInput
              style={[inputStyle, { paddingLeft: 40 }]}
              placeholder="email or @username"
              placeholderTextColor={t.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={query}
              onChangeText={setQuery}
            />
            <Ionicons
              name="search"
              size={18}
              color={t.textFaint}
              style={{ position: "absolute", left: 14 }}
            />
          </View>
          {searching ? <LogoSpinner size={22} /> : null}
        </View>
      </View>

      <FlatList
        data={results}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: 40, gap: 8 }}
        renderItem={({ item }) => (
          <UserRow
            user={item}
            warping={warpingId === item.id}
            disabled={warpingId !== null}
            onWarp={() => warpInto(item)}
          />
        )}
        ListEmptyComponent={
          query.trim().length < 2 ? null : searching ? null : searched ? (
            <Text style={{ color: t.textFaint, textAlign: "center", marginTop: 24 }}>
              No users match “{query.trim()}”.
            </Text>
          ) : null
        }
      />
    </View>
  );
}

function UserRow({
  user,
  warping,
  disabled,
  onWarp,
}: {
  user: AdminUser;
  warping: boolean;
  disabled: boolean;
  onWarp: () => void;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 10,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
      }}
    >
      <Avatar url={user.avatar_url} size={44} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontWeight: "700", fontSize: 15 }} numberOfLines={1}>
          {user.username ? `@${user.username}` : "(no username)"}
        </Text>
        <Text style={{ color: t.textDim, fontSize: 12.5 }} numberOfLines={1}>
          {user.email ?? "no email"}
        </Text>
      </View>
      <Pressable
        onPress={onWarp}
        disabled={disabled}
        hitSlop={6}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: t.amberTint,
          borderRadius: radius.full,
          paddingHorizontal: 14,
          paddingVertical: 8,
          opacity: disabled && !warping ? 0.5 : 1,
        }}
      >
        {warping ? (
          <LogoSpinner size={18} color={t.amber} />
        ) : (
          <Ionicons name="swap-horizontal" size={16} color={t.amber} />
        )}
        <Text style={{ color: t.amber, fontWeight: "800", fontSize: 13 }}>Warp</Text>
      </Pressable>
    </View>
  );
}
