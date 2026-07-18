import React, { useState } from "react";
import { FlatList, Linking, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "../lib/api";
import { bestImageUrl } from "../lib/media";
import { compact, displayName } from "../lib/format";
import { space, useTheme } from "../lib/theme";
import { nextCursorOf, pageItems, type Conversation, type Paged, type Post, type UserProfile } from "../lib/types";
import { FollowButton } from "./FollowButton";
import { EmptyState } from "./states";
import { TradesTabContent } from "./TradesList";
import { Avatar, Segmented, Skeleton } from "./ui";
import { WalletTab } from "./WalletTab";

// Shared profile surface (spec §7): header (avatar, bio, links, counts,
// follow/edit) + content tabs. Every profile has Posts (grid), Reels, and
// Trades; the Wallet tab appears on your own profile only. Private accounts
// show only the header to non-followers; private trades hide the Trades tab
// content for everyone but the owner.

type TabName = "Posts" | "Reels" | "Trades" | "Wallet";

export function ProfileView({
  profile,
  isOwn,
  headerRight,
  onRefetch,
}: {
  profile: UserProfile;
  isOwn: boolean;
  headerRight?: React.ReactNode;
  onRefetch?: () => void;
}) {
  const t = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<TabName>("Posts");

  const canView = isOwn || !profile.is_private || !!profile.is_following || profile.can_view !== false;
  const tradesHidden = !isOwn && profile.can_view_trades === false;
  const tabs: TabName[] = isOwn ? ["Posts", "Reels", "Trades", "Wallet"] : ["Posts", "Reels", "Trades"];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Header */}
      <View style={{ padding: space.lg, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
          <Avatar url={profile.avatar_url} size={84} />
          <View style={{ flex: 1, flexDirection: "row", justifyContent: "space-around" }}>
            <Stat label="Posts" value={profile.post_count} />
            <Stat
              label="Followers"
              value={profile.follower_count}
              onPress={() => router.push(`/user/${profile.username}/connections?tab=followers` as never)}
            />
            <Stat
              label="Following"
              value={profile.following_count}
              onPress={() => router.push(`/user/${profile.username}/connections?tab=following` as never)}
            />
          </View>
        </View>
        <View style={{ gap: 3 }}>
          {/* Display name shown ONLY when the user set one; the username line is
              always present. No generic "user" placeholder. */}
          {profile.display_name?.trim() ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ color: t.text, fontWeight: "800", fontSize: 16 }}>{profile.display_name.trim()}</Text>
              {profile.is_private ? <Ionicons name="lock-closed" size={13} color={t.textDim} /> : null}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ color: profile.display_name?.trim() ? t.textDim : t.text, fontWeight: profile.display_name?.trim() ? "400" : "800", fontSize: profile.display_name?.trim() ? 13.5 : 16 }}>
              @{profile.username}
            </Text>
            {!profile.display_name?.trim() && profile.is_private ? <Ionicons name="lock-closed" size={13} color={t.textDim} /> : null}
          </View>
          {profile.bio ? <Text style={{ color: t.text, fontSize: 14, lineHeight: 19, marginTop: 3 }}>{profile.bio}</Text> : null}
          {(profile.links ?? []).map((l) => (
            <Pressable key={l} onPress={() => Linking.openURL(l.startsWith("http") ? l : `https://${l}`).catch(() => {})}>
              <Text style={{ color: t.blue, fontSize: 13.5, fontWeight: "600" }}>{l}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          {isOwn ? (
            <>
              <Pressable
                onPress={() => router.push("/onboarding?edit=1" as never)}
                style={{ flex: 1, backgroundColor: t.grayTint, borderRadius: 10, paddingVertical: 9, alignItems: "center" }}
              >
                <Text style={{ color: t.text, fontWeight: "700", fontSize: 13.5 }}>Edit profile</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push("/settings" as never)}
                style={{ backgroundColor: t.grayTint, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 }}
              >
                <Ionicons name="settings-outline" size={17} color={t.text} />
              </Pressable>
            </>
          ) : (
            <>
              <FollowButton user={profile} onChange={onRefetch} wide />
              <MessageButton userId={profile.id} />
            </>
          )}
          {headerRight}
        </View>
      </View>

      {!canView ? (
        <EmptyState
          icon="lock-closed-outline"
          title="This account is private"
          subtitle="Follow to see their posts, reels, and trades."
        />
      ) : (
        <>
          <Segmented
            options={tabs}
            value={tab}
            onChange={(v) => setTab(v as TabName)}
            icons={tabs.map((name) => (
              <Ionicons
                key={name}
                name={
                  name === "Posts"
                    ? "grid-outline"
                    : name === "Reels"
                      ? "play-circle-outline"
                      : name === "Trades"
                        ? "stats-chart-outline"
                        : "wallet-outline"
                }
                size={15}
                color={tab === name ? t.text : t.textDim}
              />
            ))}
          />
          {tab === "Posts" ? <PostGrid username={profile.username} kind="posts" /> : null}
          {tab === "Reels" ? <PostGrid username={profile.username} kind="reels" /> : null}
          {tab === "Trades" ? <TradesTabContent username={profile.username} hidden={tradesHidden} /> : null}
          {tab === "Wallet" && isOwn ? <WalletTab /> : null}
        </>
      )}
    </ScrollView>
  );
}

// Starts (or reopens) a DM with this user and jumps into the thread.
function MessageButton({ userId }: { userId: string }) {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          const res = await api.post<{ conversation: Conversation } & Conversation>("/v1/conversations", {
            user_id: userId,
          });
          const conversationId = (res as { conversation?: Conversation }).conversation?.id ?? res.id;
          if (conversationId) router.push(`/conversation/${conversationId}` as never);
        } catch {
          /* button re-enables */
        } finally {
          setBusy(false);
        }
      }}
      style={{
        backgroundColor: t.grayTint,
        borderRadius: 999,
        paddingVertical: 9,
        paddingHorizontal: 18,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Text style={{ color: t.text, fontWeight: "700", fontSize: 13.5 }}>Message</Text>
    </Pressable>
  );
}

function Stat({ label, value, onPress }: { label: string; value: number; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={{ alignItems: "center" }} hitSlop={8}>
      <Text style={{ color: t.text, fontWeight: "800", fontSize: 17 }}>{compact(value)}</Text>
      <Text style={{ color: t.textDim, fontSize: 12.5 }}>{label}</Text>
    </Pressable>
  );
}

// 3-col media grid of a user's posts or reels.
function PostGrid({ username, kind }: { username: string; kind: "posts" | "reels" }) {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cell = width / 3;

  const q = useInfiniteQuery({
    queryKey: ["user-posts", username, kind],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Post>>(
        `/v1/users/${username}/posts?kind=${kind === "reels" ? "reel" : "all"}&limit=24${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`
      ),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  if (q.isLoading) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {[...Array(6)].map((_, i) => (
          <Skeleton key={i} style={{ width: cell - 2, height: cell - 2, margin: 1, borderRadius: 2 }} />
        ))}
      </View>
    );
  }
  const posts = (q.data?.pages.flatMap((p) => pageItems<Post>(p)) ?? []).filter((p) =>
    kind === "reels" ? p.kind === "reel" : true
  );
  if (posts.length === 0) {
    return (
      <EmptyState
        icon={kind === "reels" ? "play-circle-outline" : "images-outline"}
        title={kind === "reels" ? "No reels yet" : "No posts yet"}
      />
    );
  }
  return (
    <FlatList
      data={posts}
      scrollEnabled={false}
      numColumns={3}
      keyExtractor={(p) => p.id}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      renderItem={({ item }) => (
        <Pressable onPress={() => router.push(`/post/${item.id}` as never)} style={{ width: cell, height: cell, padding: 1 }}>
          <Image
            source={{ uri: bestImageUrl(item.media[0], cell) }}
            style={{ flex: 1, backgroundColor: t.surfaceAlt }}
            contentFit="cover"
          />
          {item.kind !== "photo" ? (
            <Ionicons name="play" size={14} color="#fff" style={{ position: "absolute", top: 6, right: 6 }} />
          ) : null}
          {item.market ? (
            <Ionicons name="stats-chart" size={13} color="#fff" style={{ position: "absolute", bottom: 6, left: 6 }} />
          ) : null}
        </Pressable>
      )}
    />
  );
}
