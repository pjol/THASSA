import { useEffect } from "react";
import { StyleProp, ViewStyle } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
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
  style,
  contentFit = "cover",
}: {
  media: Media;
  active: boolean;
  loop?: boolean;
  muted?: boolean;
  style?: StyleProp<ViewStyle>;
  contentFit?: "cover" | "contain";
}) {
  const player = useVideoPlayer(videoSource(media), (p) => {
    p.loop = loop;
    p.muted = muted;
  });

  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  return <VideoView player={player} style={style} contentFit={contentFit} nativeControls={false} />;
}
