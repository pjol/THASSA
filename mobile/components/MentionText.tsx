import React from "react";
import { StyleProp, Text, TextStyle } from "react-native";
import { useRouter } from "expo-router";
import { segmentCaption } from "../lib/mentions";
import { useTheme } from "../lib/theme";
import type { Mention } from "../lib/types";

// Renders a caption with its resolved @-mentions (spec §7d.2). Each mention
// slice becomes a tappable link to the mentioned user's profile, rendered from
// the RESOLVED username (not re-parsed from the raw text) so renames propagate.
// Used by PostCard, post detail, and comments. The returned children can be
// nested inside a parent <Text> (e.g. after a bold author name), so this renders
// inline <Text> nodes rather than its own block.

export function MentionText({
  caption,
  mentions,
  style,
  linkStyle,
}: {
  caption: string | null | undefined;
  mentions: Mention[] | null | undefined;
  style?: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
}) {
  const t = useTheme();
  const router = useRouter();
  if (!caption) return null;

  const segments = segmentCaption(caption, mentions);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Text key={i} style={style}>
            {seg.text}
          </Text>
        ) : (
          <Text
            key={i}
            onPress={() => router.push(`/user/${seg.mention.username}` as never)}
            suppressHighlighting
            style={[{ color: t.blue, fontWeight: "600" }, linkStyle]}
          >
            @{seg.mention.username}
          </Text>
        )
      )}
    </>
  );
}
