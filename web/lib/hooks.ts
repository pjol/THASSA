"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Post } from "@/lib/types";

// Just-in-time infinite scroll: attach the returned ref to an element ~N items
// before the end of the list; when it enters the (padded) viewport, fetch the
// next page. Re-creates the observer whenever the callback identity changes.
export function useLoadMoreRef(
  loadMore: () => void,
  enabled: boolean,
): (node: HTMLElement | null) => void {
  const observer = useRef<IntersectionObserver | null>(null);
  return useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!node || !enabled) return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { rootMargin: "600px 0px" },
      );
      observer.current.observe(node);
    },
    [loadMore, enabled],
  );
}

const warmedImages = new Set<string>();
const warmedPlaylists = new Set<string>();

export function prefetchImage(url: string | null | undefined) {
  if (!url || warmedImages.has(url) || typeof window === "undefined") return;
  warmedImages.add(url);
  const img = new Image();
  img.src = url;
}

// Warm an HLS playlist (and by extension the CDN cache / DNS / TLS) so the
// next video starts instantly when scrolled into view.
export function warmHls(url: string | null | undefined) {
  if (!url || warmedPlaylists.has(url) || typeof window === "undefined") return;
  warmedPlaylists.add(url);
  fetch(url, { mode: "cors" }).catch(() => {});
}

// Prefetch media for the next few posts past the visible index.
export function prefetchPostMedia(posts: Post[], fromIndex: number, count = 4) {
  let warmedVideo = false;
  for (let i = fromIndex; i < Math.min(posts.length, fromIndex + count); i++) {
    for (const m of posts[i]?.media ?? []) {
      if (m.kind === "image") prefetchImage(m.url);
      else {
        prefetchImage(m.url); // poster
        if (!warmedVideo) {
          warmHls(m.hls_url);
          warmedVideo = true; // warm only the next video's playlist
        }
      }
    }
  }
}

// Debounced value (typeahead search).
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
