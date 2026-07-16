"use client";

// Reels: vertical full-screen snap feed of short HLS videos, infinite, with
// like/comment overlay. Videos autoplay when snapped into view.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { warmHls } from "@/lib/hooks";
import { Avatar } from "@/components/Avatar";
import { VideoPlayer } from "@/components/VideoPlayer";
import { Sheet } from "@/components/Sheet";
import { Comments } from "@/components/Comments";
import { EmptyState } from "@/components/EmptyState";
import { CommentIcon, HeartIcon, ReelsIcon, ShareIcon, Spinner } from "@/components/icons";
import { fmtCount } from "@/lib/format";
import { useToast } from "@/providers/ToastProvider";
import type { Post, PostsPage } from "@/lib/types";

export default function ReelsPage() {
  const api = useApi();
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["reels"],
    queryFn: ({ pageParam }) =>
      api.get<{ reels: Post[]; next_cursor: string | null } | PostsPage>(
        `/v1/reels?limit=6${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });

  const reels =
    query.data?.pages.flatMap((p: any) => p.reels ?? p.posts ?? []) ?? [];

  // Fetch more when nearing the end; warm the next reel's playlist.
  useEffect(() => {
    if (
      reels.length > 0 &&
      activeIndex >= reels.length - 2 &&
      query.hasNextPage &&
      !query.isFetchingNextPage
    ) {
      query.fetchNextPage();
    }
    const next = reels[activeIndex + 1]?.media?.[0];
    if (next) warmHls(next.hls_url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, reels.length]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setActiveIndex(Math.round(el.scrollTop / el.clientHeight));
  };

  if (query.isLoading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-black">
        <Spinner size={28} className="text-white/70" />
      </div>
    );
  }

  if (reels.length === 0) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-bg">
        <EmptyState
          icon={<ReelsIcon size={40} />}
          title="No reels yet"
          body="Short videos posted to Thassa land here."
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="snap-reels no-scrollbar h-[100dvh] overflow-y-auto bg-black"
    >
      {reels.map((reel: Post, i: number) => (
        <ReelSlide key={reel.id} reel={reel} active={i === activeIndex} />
      ))}
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Spinner className="text-white/60" />
        </div>
      )}
    </div>
  );
}

function ReelSlide({ reel, active }: { reel: Post; active: boolean }) {
  const api = useApi();
  const toast = useToast();
  const media = reel.media[0];
  const [liked, setLiked] = useState(reel.liked);
  const [likes, setLikes] = useState(reel.like_count);
  const [showComments, setShowComments] = useState(false);

  const toggleLike = async () => {
    const next = !liked;
    setLiked(next);
    setLikes((n) => Math.max(0, n + (next ? 1 : -1)));
    try {
      if (next) await api.put("/v1/likes", { subject_type: "post", subject_id: reel.id });
      else await api.del("/v1/likes", { subject_type: "post", subject_id: reel.id });
    } catch {
      setLiked(!next);
      setLikes((n) => Math.max(0, n + (next ? -1 : 1)));
    }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/reels?reel=${reel.id}`);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  };

  return (
    <section className="snap-reel relative flex h-[100dvh] items-center justify-center">
      <div className="relative h-full w-full max-w-[480px]">
        {media && (media.hls_url || media.url) ? (
          <VideoPlayer
            src={media.hls_url || media.url}
            poster={media.url}
            active={active}
            objectFit="cover"
            ariaLabel={reel.caption || `Reel by ${reel.author.username}`}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-white/60">
            Video processing…
          </div>
        )}

        {/* overlay: author + caption */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 pb-16 md:pb-6">
          <Link
            href={`/u/${reel.author.username}`}
            className="flex items-center gap-2.5 text-white"
          >
            <Avatar user={reel.author} size="sm" />
            <span className="text-sm font-bold">{reel.author.username}</span>
          </Link>
          {reel.caption && (
            <p className="mt-2 line-clamp-2 pr-16 text-sm text-white/90">{reel.caption}</p>
          )}
        </div>

        {/* action rail */}
        <div className="absolute bottom-24 right-3 flex flex-col items-center gap-5 text-white md:bottom-10">
          <button
            onClick={toggleLike}
            aria-label={liked ? "Unlike reel" : "Like reel"}
            aria-pressed={liked}
            className="flex flex-col items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            <HeartIcon size={30} filled={liked} className={liked ? "text-no" : ""} />
            <span className="text-xs font-semibold">{fmtCount(likes)}</span>
          </button>
          <button
            onClick={() => setShowComments(true)}
            aria-label="Comments"
            className="flex flex-col items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            <CommentIcon size={28} />
            <span className="text-xs font-semibold">{fmtCount(reel.comment_count)}</span>
          </button>
          <button
            onClick={share}
            aria-label="Share reel"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            <ShareIcon size={26} />
          </button>
        </div>
      </div>

      {showComments && (
        <Sheet title="Comments" onClose={() => setShowComments(false)}>
          <Comments subjectType="post" subjectId={reel.id} />
        </Sheet>
      )}
    </section>
  );
}
