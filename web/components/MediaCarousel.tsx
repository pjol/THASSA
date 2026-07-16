"use client";

// IG-style media carousel: swipe/scroll-snap horizontally, dot indicators,
// arrow buttons on hover (desktop), videos play only while their slide and
// the card itself are visible.

import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "@/lib/types";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";

export function MediaCarousel({
  media,
  alt,
  aspect = "aspect-square",
}: {
  media: MediaItem[];
  alt: string;
  aspect?: string;
}) {
  const [index, setIndex] = useState(0);
  const [inView, setInView] = useState(true);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Track which slide is snapped.
  const onScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  // Pause videos when the whole carousel scrolls off screen.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => setInView(e.isIntersecting),
      { threshold: 0.35 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const go = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({
      left: (index + dir) * el.clientWidth,
      behavior: "smooth",
    });
  };

  if (media.length === 0) return null;

  return (
    <div ref={rootRef} className="group relative">
      <div
        ref={trackRef}
        onScroll={onScroll}
        className={`no-scrollbar flex w-full snap-x snap-mandatory overflow-x-auto ${aspect}`}
      >
        {media.map((m, i) => (
          <div key={m.id || i} className="h-full w-full flex-none snap-start">
            {m.kind === "video" && (m.hls_url || m.url) ? (
              <VideoPlayer
                src={m.hls_url || m.url}
                poster={m.url}
                active={inView && index === i}
                ariaLabel={alt}
                className="h-full w-full"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.url}
                alt={m.alt || alt}
                className="h-full w-full bg-surface object-cover"
                loading="lazy"
              />
            )}
          </div>
        ))}
      </div>

      {media.length > 1 && (
        <>
          {index > 0 && (
            <button
              onClick={() => go(-1)}
              aria-label="Previous media"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              <ChevronLeftIcon size={16} />
            </button>
          )}
          {index < media.length - 1 && (
            <button
              onClick={() => go(1)}
              aria-label="Next media"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              <ChevronRightIcon size={16} />
            </button>
          )}
          <div
            className="absolute inset-x-0 bottom-2 flex justify-center gap-1"
            aria-label={`Media ${index + 1} of ${media.length}`}
          >
            {media.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full transition ${
                  i === index ? "bg-white" : "bg-white/40"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
