"use client";

// Explore (spec §7): two tabs — Posts (grid, infinite) and Markets (list with
// question, StateChip, prices, volume, top-post thumbnails).

import { useState } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { useLoadMoreRef } from "@/lib/hooks";
import { StateChip } from "@/components/StateChip";
import { GridSkeleton, RowSkeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { PlayIcon, Spinner, TradesIcon } from "@/components/icons";
import { fmtCents, fmtVolume } from "@/lib/format";
import type { Market, Post, PostsPage } from "@/lib/types";

type Tab = "posts" | "markets";

interface ExploreMarket extends Market {
  top_posts?: { id: string; thumbnail_url: string | null }[];
}
type ExploreMarketsPage = { markets: ExploreMarket[]; next_cursor: string | null };

export default function ExplorePage() {
  const [tab, setTab] = useState<Tab>("posts");

  return (
    <div className="mx-auto w-full max-w-3xl px-2 pt-3 sm:px-4 md:pt-6">
      <div className="mb-4 flex gap-2 px-1" role="tablist" aria-label="Explore">
        {(["posts", "markets"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold capitalize transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
              tab === t ? "bg-accent text-accent-fg" : "bg-surface text-muted hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "posts" ? <PostsGrid /> : <MarketsList />}
    </div>
  );
}

function PostsGrid() {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ["explore", "posts"],
    queryFn: ({ pageParam }) =>
      api.get<PostsPage>(
        `/v1/explore/posts?limit=24${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const posts = query.data?.pages.flatMap((p) => p.posts) ?? [];
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  if (query.isLoading) return <GridSkeleton cells={15} />;
  if (posts.length === 0)
    return <EmptyState title="Nothing to explore yet" body="Posts from across Thassa show up here." />;

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        {posts.map((post, i) => (
          <ExploreCell
            key={post.id}
            post={post}
            innerRef={i === Math.max(0, posts.length - 6) ? loadMoreRef : undefined}
          />
        ))}
      </div>
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-5">
          <Spinner className="text-muted" />
        </div>
      )}
    </>
  );
}

function ExploreCell({
  post,
  innerRef,
}: {
  post: Post;
  innerRef?: (node: HTMLElement | null) => void;
}) {
  const m = post.media[0];
  const href = post.market ? `/markets/${post.market.id}` : `/u/${post.author.username}`;
  return (
    <Link
      href={href}
      ref={innerRef as any}
      aria-label={post.caption || `Post by ${post.author.username}`}
      className="group relative block aspect-square overflow-hidden bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
    >
      {m ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={m.url}
          alt={post.caption || `Post by ${post.author.username}`}
          loading="lazy"
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
        />
      ) : (
        <span className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">
          {post.caption?.slice(0, 80)}
        </span>
      )}
      {(post.kind === "video" || post.kind === "reel") && (
        <span className="absolute right-1.5 top-1.5 text-white drop-shadow">
          <PlayIcon size={16} />
        </span>
      )}
      {post.market && (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">
          <TradesIcon size={10} />
          {fmtCents(post.market.yes_price_cents)} YES
        </span>
      )}
    </Link>
  );
}

function MarketsList() {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ["explore", "markets"],
    queryFn: ({ pageParam }) =>
      api.get<ExploreMarketsPage>(
        `/v1/explore/markets?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const markets = query.data?.pages.flatMap((p) => p.markets) ?? [];
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  if (query.isLoading) return <RowSkeleton rows={8} />;
  if (markets.length === 0)
    return <EmptyState title="No markets yet" body="Attach a market to a post to open the first one." />;

  return (
    <ul className="space-y-2">
      {markets.map((m, i) => (
        <li key={m.id} ref={i === Math.max(0, markets.length - 4) ? loadMoreRef : undefined}>
          <Link
            href={`/markets/${m.id}`}
            className="card flex items-center gap-3 p-3.5 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-fg">{m.question}</p>
              <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                <StateChip state={m.status} direction={m.direction} size="xs" />
                <span>Vol {fmtVolume(m.volume)}</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {(m.top_posts ?? []).slice(0, 3).map(
                (p) =>
                  p.thumbnail_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={p.id}
                      src={p.thumbnail_url}
                      alt=""
                      className="-ml-4 h-9 w-9 rounded-lg border-2 border-card object-cover first:ml-0"
                    />
                  ),
              )}
              <div className="text-right font-mono text-sm font-bold tabular-nums">
                <span className="text-yes">{fmtCents(m.yes_price_cents)}</span>
                <span className="mx-1 text-muted">/</span>
                <span className="text-no">{fmtCents(m.no_price_cents)}</span>
              </div>
            </div>
          </Link>
        </li>
      ))}
      {query.isFetchingNextPage && (
        <li className="flex justify-center py-4">
          <Spinner className="text-muted" />
        </li>
      )}
    </ul>
  );
}
