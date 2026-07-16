import React, { useState } from "react";
import { FlatList, Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { StateChip } from "../../components/StateChip";
import { Segmented, Skeleton } from "../../components/ui";
import { useApi } from "../../lib/api";
import { cents, dollars } from "../../lib/format";
import { space, useTheme } from "../../lib/theme";
import { nextCursorOf, pageItems, type Market, type Paged, type Post } from "../../lib/types";

// Explore (spec §7): two top tabs — Posts (3-col infinite grid) and Markets
// (list with state chips, prices, volume). Cross-linked with market detail.

export default function Explore() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState("Posts");
  const [query, setQuery] = useState("");

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: space.md, paddingVertical: 8 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: t.surfaceAlt,
            borderRadius: 12,
            paddingHorizontal: 12,
          }}
        >
          <Ionicons name="search" size={17} color={t.textFaint} />
          <TextInput
            style={{ flex: 1, color: t.text, paddingVertical: 10, fontSize: 15 }}
            placeholder={tab === "Posts" ? "Search Thassa" : "Search markets"}
            placeholderTextColor={t.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
          />
        </View>
      </View>
      <Segmented options={["Posts", "Markets"]} value={tab} onChange={setTab} />
      {tab === "Posts" ? <PostsGrid /> : <MarketsList query={query} />}
    </View>
  );
}

function PostsGrid() {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cell = width / 3;

  const q = useInfiniteQuery({
    queryKey: ["explore-posts"],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Post>>(`/v1/explore/posts?limit=24${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  if (q.isLoading) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {[...Array(12)].map((_, i) => (
          <Skeleton key={i} style={{ width: cell - 2, height: cell - 2, margin: 1, borderRadius: 2 }} />
        ))}
      </View>
    );
  }
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const posts = q.data?.pages.flatMap((p) => pageItems<Post>(p)) ?? [];

  return (
    <FlatList
      data={posts}
      numColumns={3}
      keyExtractor={(p) => p.id}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push(`/post/${item.id}` as never)}
          style={{ width: cell, height: cell, padding: 1 }}
        >
          <Image source={{ uri: item.media[0]?.url }} style={{ flex: 1, backgroundColor: t.surfaceAlt }} contentFit="cover" transition={100} />
          {item.kind !== "photo" ? (
            <Ionicons name="play" size={14} color="#fff" style={{ position: "absolute", top: 6, right: 6 }} />
          ) : null}
          {item.market ? (
            <Ionicons name="stats-chart" size={13} color="#fff" style={{ position: "absolute", bottom: 6, left: 6 }} />
          ) : null}
        </Pressable>
      )}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      onEndReachedThreshold={0.6}
      refreshing={q.isRefetching && !q.isFetchingNextPage}
      onRefresh={() => q.refetch()}
      ListEmptyComponent={<EmptyState icon="images-outline" title="Nothing here yet" />}
      ListFooterComponent={q.isFetchingNextPage ? <Loading /> : null}
    />
  );
}

function MarketsList({ query }: { query: string }) {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const search = query.trim();

  const q = useInfiniteQuery({
    queryKey: ["explore-markets", search],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Market>>(
        search
          ? `/v1/markets/search?q=${encodeURIComponent(search)}&limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`
          : `/v1/explore/markets?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`
      ),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  if (q.isLoading) {
    return (
      <View style={{ padding: space.md, gap: 10 }}>
        {[...Array(6)].map((_, i) => (
          <Skeleton key={i} style={{ height: 76 }} />
        ))}
      </View>
    );
  }
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const markets = q.data?.pages.flatMap((p) => pageItems<Market>(p)) ?? [];

  return (
    <FlatList
      data={markets}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push(`/market/${item.id}` as never)}
          style={{
            paddingHorizontal: space.md,
            paddingVertical: 13,
            borderBottomWidth: 1,
            borderBottomColor: t.border,
            gap: 8,
          }}
        >
          <Text style={{ color: t.text, fontWeight: "700", fontSize: 14.5, lineHeight: 19 }} numberOfLines={2}>
            {item.question}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <StateChip state={item.status} direction={item.direction} size="sm" />
            <Text style={{ color: t.yes, fontWeight: "800", fontSize: 13 }}>YES {cents(item.yes_price_cents)}</Text>
            <Text style={{ color: t.no, fontWeight: "800", fontSize: 13 }}>NO {cents(item.no_price_cents)}</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ color: t.textFaint, fontSize: 12.5 }}>{dollars(item.volume)} vol</Text>
          </View>
        </Pressable>
      )}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      onEndReachedThreshold={0.5}
      refreshing={q.isRefetching && !q.isFetchingNextPage}
      onRefresh={() => q.refetch()}
      ListEmptyComponent={
        <EmptyState icon="stats-chart-outline" title={search ? "No markets match" : "No markets yet"} subtitle={search ? "Try different words, or create one from a post." : "Attach one to a post to get things going."} />
      }
      ListFooterComponent={q.isFetchingNextPage ? <Loading /> : null}
    />
  );
}
