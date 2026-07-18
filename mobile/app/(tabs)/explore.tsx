import React, { useState } from "react";
import { FlatList, Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { MarketCardSkeleton } from "../../components/skeletons";
import { BrandRefreshControl, EmptyState, ErrorState, FooterLoading } from "../../components/states";
import { StateChip } from "../../components/StateChip";
import { Segmented, Sheet, Skeleton } from "../../components/ui";
import { tap } from "../../lib/haptics";
import { useApi } from "../../lib/api";
import { bestImageUrl } from "../../lib/media";
import { cents, dollars } from "../../lib/format";
import { space, useTheme } from "../../lib/theme";
import { nextCursorOf, pageItems, type Market, type Paged, type Post } from "../../lib/types";

// Explore (spec §7): two top tabs — Posts (3-col infinite grid) and Markets
// (list with state chips, prices, volume). Cross-linked with market detail.
// The top-left options icon opens the markets filter/sort sheet; by default
// the Markets tab lists only ACTIVE (tradable) markets.

export type MarketStatusFilter = "active" | "settling" | "settled" | "all";
export type MarketSort = "trending" | "newest" | "volume";

const STATUS_OPTIONS: { key: MarketStatusFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "settling", label: "Settling" },
  { key: "settled", label: "Settled" },
  { key: "all", label: "All" },
];
const SORT_OPTIONS: { key: MarketSort; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "newest", label: "Newest" },
  { key: "volume", label: "Volume" },
];

export default function Explore() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState("Posts");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<MarketStatusFilter>("active");
  const [sort, setSort] = useState<MarketSort>("trending");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtered = status !== "active" || sort !== "trending";

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.md, paddingVertical: 8 }}>
        {/* Top-left: markets filter & sort. */}
        <Pressable
          onPress={() => {
            tap();
            setTab("Markets");
            setFiltersOpen(true);
          }}
          hitSlop={6}
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: filtered ? t.blueTint : t.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="options-outline" size={19} color={filtered ? t.blue : t.text} />
        </Pressable>
        <View
          style={{
            flex: 1,
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
      {tab === "Posts" ? <PostsGrid /> : <MarketsList query={query} status={status} sort={sort} />}

      {/* Markets filter & sort sheet. */}
      <Sheet visible={filtersOpen} onClose={() => setFiltersOpen(false)} title="Markets — filter & sort">
        <View style={{ gap: 18 }}>
          <View style={{ gap: 10 }}>
            <Text style={{ color: t.textFaint, fontSize: 11, fontWeight: "800", letterSpacing: 0.6 }}>STATUS</Text>
            <OptionPills options={STATUS_OPTIONS} value={status} onChange={(v) => setStatus(v as MarketStatusFilter)} />
          </View>
          <View style={{ gap: 10 }}>
            <Text style={{ color: t.textFaint, fontSize: 11, fontWeight: "800", letterSpacing: 0.6 }}>SORT BY</Text>
            <OptionPills options={SORT_OPTIONS} value={sort} onChange={(v) => setSort(v as MarketSort)} />
          </View>
        </View>
      </Sheet>
    </View>
  );
}

function OptionPills({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => {
              tap();
              onChange(o.key);
            }}
            style={{
              backgroundColor: on ? t.blue : t.grayTint,
              borderRadius: 999,
              paddingVertical: 8,
              paddingHorizontal: 16,
            }}
          >
            <Text style={{ color: on ? "#fff" : t.textDim, fontWeight: "700", fontSize: 13.5 }}>{o.label}</Text>
          </Pressable>
        );
      })}
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
          <Image source={{ uri: bestImageUrl(item.media[0], cell) }} style={{ flex: 1, backgroundColor: t.surfaceAlt }} contentFit="cover" transition={100} />
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
      refreshControl={<BrandRefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => q.refetch()} />}
      ListEmptyComponent={<EmptyState icon="images-outline" title="Nothing here yet" />}
      ListFooterComponent={q.isFetchingNextPage ? <FooterLoading /> : null}
    />
  );
}

function MarketsList({
  query,
  status,
  sort,
}: {
  query: string;
  status: MarketStatusFilter;
  sort: MarketSort;
}) {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const search = query.trim();

  const q = useInfiniteQuery({
    queryKey: ["explore-markets", search, status, sort],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Market>>(
        search
          ? `/v1/markets/search?q=${encodeURIComponent(search)}&limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`
          : `/v1/explore/markets?limit=20&status=${status}&sort=${sort}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`
      ),
    initialPageParam: "",
    getNextPageParam: (last) => nextCursorOf(last) ?? undefined,
  });

  if (q.isLoading) {
    return (
      <View style={{ paddingTop: 4 }}>
        {[...Array(6)].map((_, i) => (
          <MarketCardSkeleton key={i} />
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
      refreshControl={<BrandRefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => q.refetch()} />}
      ListEmptyComponent={
        <EmptyState icon="stats-chart-outline" title={search ? "No markets match" : "No markets yet"} subtitle={search ? "Try different words, or create one from a post." : "Attach one to a post to get things going."} />
      }
      ListFooterComponent={q.isFetchingNextPage ? <FooterLoading /> : null}
    />
  );
}
