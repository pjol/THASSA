import { useEffect } from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { posterUrl } from "../lib/media";
import type { Media } from "../lib/types";

// HLS-first video playback via expo-video (HLS is native on iOS). Feed/reels
// autoplay muted-by-default is controlled by the parent through `active`.

export function videoSource(media: Media): string {
  return media.hls_url || media.url;
}

export function VideoPlayer({
  media,
  active,
  loop = true,
  muted = false,
  rewind = false,
  style,
  contentFit = "cover",
}: {
  media: Media;
  active: boolean;
  loop?: boolean;
  muted?: boolean;
  // When true (the parent scrolled 2+ items past this video), seek back to
  // the start so returning to it plays from the beginning.
  rewind?: boolean;
  style?: StyleProp<ViewStyle>;
  contentFit?: "cover" | "contain";
}) {
  const player = useVideoPlayer(videoSource(media), (p) => {
    p.loop = loop;
    p.muted = muted;
    // Aggressive read-ahead for lagless scroll playback: buffer well past the
    // playhead and start as soon as a minimal buffer exists. (HLS over HTTP
    // is the right transport — chunked delivery + range requests + CDN
    // caching; the lever for smoothness is buffer depth + mounting players
    // ahead, not a different protocol.)
    try {
      p.bufferOptions = {
        preferredForwardBufferDuration: 30, // iOS/web: seconds ahead
        minBufferForPlayback: 1, // android: start fast
        prioritizeTimeOverSizeThreshold: true,
      };
    } catch {
      /* older expo-video without bufferOptions */
    }
  });

  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  useEffect(() => {
    if (rewind) {
      try {
        player.currentTime = 0;
      } catch {
        /* player may be released */
      }
    }
  }, [rewind, player]);

  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  // Poster underlay (spec: video keeps hls_url, poster_url is the placeholder):
  // the still shows behind the VideoView until the first frame paints. No poster
  // → nothing rendered (defensive fallback for older/posterless media).
  const poster = posterUrl(media);
  return (
    <View style={style}>
      {poster ? (
        <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} contentFit={contentFit} />
      ) : null}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit={contentFit}
        nativeControls={false}
      />
    </View>
  );
}
