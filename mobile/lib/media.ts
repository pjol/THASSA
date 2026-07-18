import { PixelRatio } from "react-native";
import type { Media, MediaVariant } from "./types";

// Viewport-aware variant selection (backend multi-quality variants). The client
// picks the SMALLEST variant whose pixel width is >= the target display width
// scaled by the device pixel density, so a phone fetches an appropriately-sized
// image instead of the full-resolution original.
//
// Everything is defensive: media with no `variants` (older uploads, or video,
// which always ships `variants: []`) falls back to `media.url`.

function usableVariants(media: Media): MediaVariant[] {
  const vs = media.variants;
  if (!Array.isArray(vs)) return [];
  return vs
    .filter((v): v is MediaVariant => !!v && typeof v.width === "number" && v.width > 0 && !!v.url)
    .sort((a, b) => a.width - b.width);
}

// bestImageUrl returns the URL of the smallest variant at least as wide as
// `displayWidthPx * PixelRatio.get()`, falling back to the largest variant, then
// to `media.url`. Pass the on-screen (DP) width of where the image renders.
export function bestImageUrl(
  media: Media | null | undefined,
  displayWidthPx: number
): string {
  if (!media) return "";
  const variants = usableVariants(media);
  if (variants.length === 0) return media.url;
  const target = Math.max(1, Math.round(displayWidthPx * PixelRatio.get()));
  const pick = variants.find((v) => v.width >= target) ?? variants[variants.length - 1];
  return pick.url;
}

// posterUrl returns a still image to show for a video (poster / placeholder),
// or undefined when none is available.
export function posterUrl(media: Media | null | undefined): string | undefined {
  return media?.poster_url ?? undefined;
}
