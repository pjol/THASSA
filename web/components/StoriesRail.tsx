"use client";

// Stories rail atop the feed: avatar rings (brand gradient = unseen), and a
// full-screen story viewer with per-story progress bars, tap left/right
// navigation, photo timers and HLS video support.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { Avatar } from "@/components/Avatar";
import { FullModal } from "@/components/Sheet";
import { StoriesRailSkeleton } from "@/components/Skeleton";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import type { StoryGroup } from "@/lib/types";

const PHOTO_MS = 5000;

export function StoriesRail() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ["stories"],
    queryFn: () => api.get<{ stories: StoryGroup[] }>("/v1/stories"),
    staleTime: 60_000,
  });
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (isLoading) return <StoriesRailSkeleton />;
  const groups = data?.stories ?? [];
  if (groups.length === 0) return null;

  return (
    <>
      <div
        className="no-scrollbar mb-4 flex gap-4 overflow-x-auto px-1 py-2"
        role="list"
        aria-label="Stories"
      >
        {groups.map((g, i) => (
          <button
            key={g.user.id}
            role="listitem"
            onClick={() => setOpenIndex(i)}
            className="flex w-[68px] shrink-0 flex-col items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            aria-label={`${g.user.username}'s story${g.all_viewed ? " (seen)" : ""}`}
          >
            <span
              className={`rounded-full p-[2.5px] ${g.all_viewed ? "story-ring-seen" : "story-ring"}`}
            >
              <span className="block rounded-full bg-bg p-[2px]">
                <Avatar user={g.user} size="lg" />
              </span>
            </span>
            <span className="w-full truncate text-center text-xs text-fg/80">
              {g.user.username}
            </span>
          </button>
        ))}
      </div>

      {openIndex !== null && groups[openIndex] && (
        <StoryViewer
          groups={groups}
          groupIndex={openIndex}
          onGroupChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  );
}

function StoryViewer({
  groups,
  groupIndex,
  onGroupChange,
  onClose,
}: {
  groups: StoryGroup[];
  groupIndex: number;
  onGroupChange: (i: number) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const group = groups[groupIndex];
  const [storyIndex, setStoryIndex] = useState(0);
  const [progress, setProgress] = useState(0); // 0..1 for current story
  const rafRef = useRef<number>();
  const startRef = useRef<number>(0);

  const story = group.stories[storyIndex];

  const next = useCallback(() => {
    if (storyIndex < group.stories.length - 1) {
      setStoryIndex((i) => i + 1);
    } else if (groupIndex < groups.length - 1) {
      setStoryIndex(0);
      onGroupChange(groupIndex + 1);
    } else {
      onClose();
    }
  }, [storyIndex, group.stories.length, groupIndex, groups.length, onGroupChange, onClose]);

  const prev = useCallback(() => {
    if (storyIndex > 0) setStoryIndex((i) => i - 1);
    else if (groupIndex > 0) {
      const prevGroup = groups[groupIndex - 1];
      setStoryIndex(prevGroup.stories.length - 1);
      onGroupChange(groupIndex - 1);
    }
  }, [storyIndex, groupIndex, groups, onGroupChange]);

  // progress timer (photos; videos advance on duration)
  useEffect(() => {
    if (!story) return;
    setProgress(0);
    startRef.current = performance.now();
    const dur = story.kind === "video" ? (story.duration_ms || 15000) : PHOTO_MS;
    const tick = (t: number) => {
      const p = (t - startRef.current) / dur;
      if (p >= 1) {
        next();
        return;
      }
      setProgress(p);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // view tracking
  useEffect(() => {
    if (story) api.post(`/v1/stories/${story.id}/view`).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // keyboard nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  if (!story) return null;

  return (
    <FullModal onClose={onClose} label={`${group.user.username}'s story`}>
      <div className="mx-auto flex h-full max-w-md flex-col justify-center">
        <div className="relative aspect-[9/16] max-h-[92vh] w-full overflow-hidden bg-black md:rounded-2xl">
          {/* progress bars */}
          <div className="absolute inset-x-2 top-2 z-10 flex gap-1">
            {group.stories.map((s, i) => (
              <span key={s.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
                <span
                  className="block h-full bg-white"
                  style={{
                    width:
                      i < storyIndex ? "100%" : i === storyIndex ? `${progress * 100}%` : "0%",
                  }}
                />
              </span>
            ))}
          </div>

          {/* header */}
          <div className="absolute inset-x-0 top-4 z-10 flex items-center gap-2.5 px-3">
            <Avatar user={group.user} size="sm" />
            <span className="text-sm font-bold text-white drop-shadow">
              {group.user.username}
            </span>
            <span className="text-xs text-white/70">{timeAgo(story.created_at)}</span>
          </div>

          {/* media */}
          {story.kind === "video" && (story.hls_url || story.url) ? (
            <VideoPlayer
              src={story.hls_url || story.url}
              active
              loop={false}
              objectFit="cover"
              ariaLabel={`${group.user.username}'s story video`}
              className="h-full w-full"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={story.url}
              alt={`${group.user.username}'s story`}
              className="h-full w-full object-cover"
            />
          )}

          {/* tap zones */}
          <button
            onClick={prev}
            aria-label="Previous story"
            className="absolute inset-y-0 left-0 z-[5] w-1/3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          />
          <button
            onClick={next}
            aria-label="Next story"
            className="absolute inset-y-0 right-0 z-[5] w-1/3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          />
        </div>

        {/* desktop arrows */}
        <button
          onClick={prev}
          aria-label="Previous"
          className="absolute left-6 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 md:block"
        >
          <ChevronLeftIcon size={20} />
        </button>
        <button
          onClick={next}
          aria-label="Next"
          className="absolute right-6 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 md:block"
        >
          <ChevronRightIcon size={20} />
        </button>
      </div>
    </FullModal>
  );
}
