"use client";

// Home feed: stories rail + infinite post feed with just-in-time prefetch —
// next page is requested when the viewer is ~3 posts from the end, and the
// next few posts' images (plus the next video's HLS playlist) are warmed.

import { useEffect } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { useLoadMoreRef, prefetchPostMedia } from "@/lib/hooks";
import { StoriesRail } from "@/components/StoriesRail";
import { PostCard } from "@/components/PostCard";
import { PostCardSkeleton, StoriesRailSkeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { CameraIcon, Spinner } from "@/components/icons";
import type { PostsPage } from "@/lib/types";

const LOAD_AHEAD = 3; // trigger next page ~3 posts before the end

export default function HomePage() {
  const api = useApi();

  const query = useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: ({ pageParam }) =>
      api.get<PostsPage>(
        `/v1/feed?limit=10${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });

  const posts = query.data?.pages.flatMap((p) => p.posts) ?? [];

  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  // Media prefetch: when a new page lands, warm the upcoming posts' media.
  useEffect(() => {
    if (posts.length > 0) prefetchPostMedia(posts, Math.max(0, posts.length - 10));
  }, [posts]);

  return (
    <div className="mx-auto w-full max-w-[520px] px-0 pt-2 sm:px-4 md:pt-6">
      <StoriesRail />

      {query.isLoading && (
        <>
          <PostCardSkeleton />
          <PostCardSkeleton />
        </>
      )}

      {query.isError && (
        <EmptyState
          title="Couldn't load your feed"
          body="Check your connection and try again."
          action={
            <button onClick={() => query.refetch()} className="btn-brand">
              Retry
            </button>
          }
        />
      )}

      {!query.isLoading && !query.isError && posts.length === 0 && (
        <EmptyState
          icon={<CameraIcon size={40} />}
          title="Welcome to Thassa"
          body="Follow people to fill your feed, or post something worth betting on."
          action={
            <Link href="/create" className="btn-brand">
              Create your first post
            </Link>
          }
        />
      )}

      {posts.map((post, i) => (
        <div
          key={post.id}
          ref={i === Math.max(0, posts.length - LOAD_AHEAD) ? loadMoreRef : undefined}
        >
          <PostCard post={post} />
        </div>
      ))}

      {query.isFetchingNextPage && (
        <div className="flex justify-center py-6">
          <Spinner className="text-muted" />
        </div>
      )}
      {!query.hasNextPage && posts.length > 0 && (
        <p className="py-8 text-center text-sm text-muted">You&apos;re all caught up.</p>
      )}
    </div>
  );
}
