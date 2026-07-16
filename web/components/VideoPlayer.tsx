"use client";

// HLS video player: uses hls.js where MSE is available, falls back to native
// HLS (Safari). Autoplays muted when `active`, pauses when not.

import { useEffect, useRef, useState } from "react";
import { MuteIcon, PlayIcon } from "@/components/icons";

export function VideoPlayer({
  src,
  poster,
  active = true,
  loop = true,
  className = "",
  rounded = false,
  objectFit = "cover",
  ariaLabel = "Video",
}: {
  src: string; // HLS master playlist (or direct mp4 fallback)
  poster?: string | null;
  active?: boolean;
  loop?: boolean;
  className?: string;
  rounded?: boolean;
  objectFit?: "cover" | "contain";
  ariaLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: any;
    let cancelled = false;
    const isHls = src.includes(".m3u8");

    async function attach() {
      if (!video) return;
      if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
        const Hls = (await import("hls.js")).default;
        if (cancelled) return;
        if (Hls.isSupported()) {
          hls = new Hls({ maxBufferLength: 12 });
          hls.loadSource(src);
          hls.attachMedia(video);
          return;
        }
      }
      video.src = src;
    }
    attach();
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active && !paused) video.play().catch(() => {});
    else video.pause();
  }, [active, paused]);

  return (
    <div className={`group relative ${className}`}>
      <video
        ref={videoRef}
        poster={poster ?? undefined}
        muted={muted}
        loop={loop}
        playsInline
        aria-label={ariaLabel}
        onClick={() => setPaused((p) => !p)}
        className={`h-full w-full ${objectFit === "cover" ? "object-cover" : "object-contain"} ${rounded ? "rounded-2xl" : ""} cursor-pointer bg-black`}
      />
      {paused && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/40 p-4 text-white">
            <PlayIcon size={28} />
          </span>
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMuted((m) => !m);
        }}
        aria-label={muted ? "Unmute video" : "Mute video"}
        className="absolute bottom-3 right-3 rounded-full bg-black/50 p-2 text-white opacity-90 transition hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
      >
        <MuteIcon size={14} muted={muted} />
      </button>
    </div>
  );
}
