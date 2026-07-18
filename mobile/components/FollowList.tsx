import React from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "../lib/api";

import { useSession } from "../lib/session";
import { space, useTheme } from "../lib/theme";
import { nextCursorOf, pageItems, type Paged, type UserBrief, type UserProfile } from "../lib/types";
import { FollowButton } from "./FollowButton";
import { ListRowsSkeleton } from "./skeletons";
import { BrandRefreshControl, EmptyState, ErrorState } from "./states";
import { Avatar } from "./ui";

// Browsable followers / following list (spec §7d.3). Rows are UserBrief; the
// backend may enrich them with the viewer's relationship (is_following, …) —
// when present we show a follow/unfollow button. Both endpoints return
// {followers|following: [UserBrief]}; pageItems() picks whichever array key is
// present and nextCursorOf() enables pagination if the backend adds a cursor.

// A follower/following row: UserBrief plus optional relationship fields.
type ConnectionUser = UserBrief &
  Partial<Pick<UserProfile, "is_following" | "follow_requested" | "is_private" | "is_me">>;

export function FollowList({ username, kind }: { username: string; kind: "followers" | "following" }) {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const { me } = useSession();

  const q = useInfiniteQuery({
    queryKey: ["connections", username, kind],
    queryFn: ({ pageParam }) =>
      api.get<Paged<ConnectionUser>>(
        `/v1/users/${encodeURIComponent(username)}/${kind}?limit=30${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`
      ),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  if (q.isLoading) return <ListRowsSkeleton rows={8} avatarSize={44} />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;

  const users = q.data?.pages.flatMap((p) => pageItems<ConnectionUser>(p)) ?? [];
  if (users.length === 0) {
    return (
      <EmptyState
        icon="people-outline"
        title={kind === "followers" ? "No followers yet" : "Not following anyone yet"}
      />
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      data={users}
      keyExtractor={(u) => u.id}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      refreshControl={<BrandRefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => q.refetch()} />}
      renderItem={({ item }) => (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingHorizontal: space.md,
            paddingVertical: 10,
          }}
        >
          <Pressable
            onPress={() => router.push(`/user/${item.username}` as never)}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}
          >
            <Avatar url={item.avatar_url} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }}>@{item.username}</Text>
            </View>
          </Pressable>
          {me && item.id !== me.id && item.is_me !== true ? (
            <FollowButton user={item} />
          ) : null}
        </View>
      )}
    />
  );
}
