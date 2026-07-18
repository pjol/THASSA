import React, { useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { errorMessage, useApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { tap, warn } from "../lib/haptics";
import { useSession } from "../lib/session";
import { radius, space, useTheme, useThemePref, type ThemePref } from "../lib/theme";
import { useToasts } from "../components/Toasts";
import { Button } from "../components/ui";
import type { Me, TradesVisibility } from "../lib/types";

// Settings (spec §7): theme (system/light/dark), privacy — private account
// (follow requests) and trades visibility (hides the Trades tab + position
// badges for everyone but you) — per-category notification toggles, and log
// out. Privacy + notification prefs persist via PATCH /v1/me/settings and are
// enforced server-side (a toggled-off category is never stored or pushed).

// The user-facing notification categories (keys match the backend's
// notify.Categories; a missing key means enabled).
const NOTIFICATION_CATEGORIES: { key: string; title: string; subtitle: string }[] = [
  { key: "likes", title: "Likes", subtitle: "When someone likes your post." },
  { key: "comments", title: "Comments", subtitle: "When someone comments on your post." },
  { key: "mentions", title: "Mentions", subtitle: "When someone @mentions you." },
  { key: "follows", title: "Followers", subtitle: "New followers, follow requests, and accepts." },
  { key: "messages", title: "Messages", subtitle: "New direct messages." },
  { key: "markets", title: "Market activity", subtitle: "Your markets and orders: opened, matched, filled, settled." },
  { key: "trading", title: "Trading alerts", subtitle: "Big swings in your positions and large entries by people you follow." },
];

export default function Settings() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const toasts = useToasts();
  const { pref, setPref } = useThemePref();
  const { logout } = useAuth();
  const { me, setMe } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

  const patchSettings = async (
    patch: Partial<{
      is_private: boolean;
      trades_visibility: TradesVisibility;
      notification_prefs: Record<string, boolean>;
    }>,
    revert: (m: Me) => Me
  ) => {
    // notification_prefs is a partial merge on both sides: the backend ORs the
    // sent keys over the stored map, and we mirror that optimistically.
    setMe((m) => ({
      ...m,
      ...patch,
      ...(patch.notification_prefs
        ? { notification_prefs: { ...m.notification_prefs, ...patch.notification_prefs } }
        : {}),
    }));
    try {
      await api.patch("/v1/me/settings", patch);
    } catch (e) {
      warn();
      setMe(revert);
      toasts.show({ title: "Couldn't save", body: errorMessage(e), icon: "alert-circle" });
    }
  };

  const isPrivate = !!me?.is_private;
  const tradesPrivate = me?.trades_visibility === "private";
  const notifOn = (key: string) => me?.notification_prefs?.[key] !== false;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.xl }}>
      {/* Appearance */}
      <Section title="Appearance">
        <View style={{ flexDirection: "row", gap: 10 }}>
          {(["system", "light", "dark"] as ThemePref[]).map((p) => {
            const active = pref === p;
            return (
              <Pressable
                key={p}
                onPress={() => {
                  tap();
                  setPref(p);
                }}
                style={{
                  flex: 1,
                  alignItems: "center",
                  gap: 6,
                  paddingVertical: 14,
                  borderRadius: radius.lg,
                  borderWidth: 1.5,
                  borderColor: active ? t.blue : t.border,
                  backgroundColor: active ? t.blueTint : "transparent",
                }}
              >
                <Ionicons
                  name={p === "system" ? "phone-portrait-outline" : p === "light" ? "sunny-outline" : "moon-outline"}
                  size={20}
                  color={active ? t.blue : t.textDim}
                />
                <Text style={{ color: active ? t.blue : t.textDim, fontWeight: "700", fontSize: 13, textTransform: "capitalize" }}>
                  {p}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {/* Privacy */}
      <Section title="Privacy">
        <ToggleRow
          title="Private account"
          subtitle="Only approved followers see your posts, reels, and trades. New followers must request."
          value={isPrivate}
          onChange={(v) =>
            patchSettings({ is_private: v }, (m) => ({ ...m, is_private: !v }))
          }
        />
        <ToggleRow
          title="Private trades"
          subtitle="Hides your Trades tab and position badges on your posts from everyone but you."
          value={tradesPrivate}
          onChange={(v) =>
            patchSettings(
              { trades_visibility: v ? "private" : "public" },
              (m) => ({ ...m, trades_visibility: v ? "public" : "private" })
            )
          }
        />
      </Section>

      {/* Notifications: one toggle per category. */}
      <Section title="Notifications">
        {NOTIFICATION_CATEGORIES.map((c) => (
          <ToggleRow
            key={c.key}
            title={c.title}
            subtitle={c.subtitle}
            value={notifOn(c.key)}
            onChange={(v) =>
              patchSettings({ notification_prefs: { [c.key]: v } }, (m) => ({
                ...m,
                notification_prefs: { ...m.notification_prefs, [c.key]: !v },
              }))
            }
          />
        ))}
      </Section>

      {/* Developer: API trading access. */}
      <Section title="Developer">
        <ToggleRow
          title="Server-side signing"
          subtitle="Let Thassa sign API orders with your delegated wallet. Plain API keys can then place trades without a live login."
          value={!!me?.server_signing_enabled}
          onChange={async (v) => {
            setMe((m) => ({ ...m, server_signing_enabled: v }));
            try {
              await api.post("/v1/me/server-signing", { enabled: v });
            } catch (e) {
              warn();
              setMe((m) => ({ ...m, server_signing_enabled: !v }));
              toasts.show({ title: "Couldn't save", body: errorMessage(e), icon: "alert-circle" });
            }
          }}
        />
      </Section>

      {/* Admin (spec §7c.3) — only for real admins, hidden while warped. */}
      {me?.is_admin && !me?.warp?.active ? (
        <Section title="Admin">
          <Pressable
            onPress={() => {
              tap();
              router.push("/admin");
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 14,
              paddingHorizontal: 14,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
            }}
          >
            <Ionicons name="swap-horizontal" size={20} color={t.amber} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "700", fontSize: 15 }}>Warp into a user</Text>
              <Text style={{ color: t.textDim, fontSize: 12.5, marginTop: 2 }}>
                Search a user and view the app as them (read-only).
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={t.textFaint} />
          </Pressable>
        </Section>
      ) : null}

      {/* Account */}
      <Section title="Account">
        <Button
          title="Log out"
          variant="danger"
          loading={busy === "logout"}
          onPress={async () => {
            setBusy("logout");
            try {
              await logout();
              router.replace("/sign-in");
            } finally {
              setBusy(null);
            }
          }}
        />
      </Section>

      <Text style={{ color: t.textFaint, fontSize: 12, textAlign: "center" }}>Thassa · v1.0.0</Text>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: t.textDim, fontWeight: "800", fontSize: 12, letterSpacing: 0.8 }}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontWeight: "700", fontSize: 15 }}>{title}</Text>
        <Text style={{ color: t.textDim, fontSize: 12.5, lineHeight: 17, marginTop: 2 }}>{subtitle}</Text>
      </View>
      {/* Fully themed (whitelabel rule): brand-blue track when on, themed
          gray track when off — never the OS-default green/gray. */}
      <Switch
        value={value}
        onValueChange={(v) => {
          tap();
          onChange(v);
        }}
        trackColor={{ true: t.blue, false: t.grayTint }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={t.grayTint}
      />
    </View>
  );
}
