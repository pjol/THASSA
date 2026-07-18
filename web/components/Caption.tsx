import Link from "next/link";
import type { Mention } from "@/lib/types";

// renderCaption (spec §7d.2): given a caption string and its resolved mentions
// (each a [start,len) slice into the RAW caption), render the text with every
// mentioned slice replaced by a link to the mentioned user, labelled with their
// CURRENT username — we never re-parse "@" tokens from the raw text, so renames
// propagate. Non-mention text renders verbatim.
//
// Truncation is handled by the caller passing an already-sliced `text` plus the
// mentions clipped to that slice (see clipMentions).
export function renderCaption(
  text: string,
  mentions?: Mention[] | null,
): React.ReactNode {
  const ms = (mentions ?? [])
    .filter((m) => m.start >= 0 && m.len > 0 && m.start + m.len <= text.length)
    .sort((a, b) => a.start - b.start);
  if (ms.length === 0) return text;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  ms.forEach((m, i) => {
    if (m.start < cursor) return; // skip overlapping/duplicate offsets
    if (m.start > cursor)
      nodes.push(<span key={`t${i}`}>{text.slice(cursor, m.start)}</span>);
    nodes.push(
      <Link
        key={`m${i}`}
        href={`/u/${m.username}`}
        className="font-semibold text-brand hover:underline"
      >
        @{m.username}
      </Link>,
    );
    cursor = m.start + m.len;
  });
  if (cursor < text.length)
    nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return nodes;
}

// Keep only the mentions that fit entirely within the first `max` characters —
// used when a caption is truncated so a mention link is never cut mid-token.
export function clipMentions(
  mentions: Mention[] | null | undefined,
  max: number,
): Mention[] {
  return (mentions ?? []).filter((m) => m.start + m.len <= max);
}
