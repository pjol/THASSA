// @-mention primitives (spec §7d.2). Mentions are stored by user id, never by
// username text, so a rendered mention always shows the mentioned user's CURRENT
// username. These helpers are pure (no React) so they're unit-testable and
// reusable for both post captions and comments.

import type { Mention, UserBrief } from "./types";

// A mention the composer has recorded but not yet submitted: the id + the exact
// username text that was inserted into the caption. Offsets are recomputed from
// the final text at submit time (see computeMentions), so edits before/after a
// mention can't desync the offsets.
export interface DraftMention {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

// Usernames are citext over [A-Za-z0-9_] (spec §6.2). A mention token is `@`
// followed by that word class; `\w` covers it.
const TOKEN = /@(\w+)/g;

// The active `@word` token immediately left of the caret, for autocomplete.
// Returns null when the caret isn't inside a mention token (or the `@` is glued
// to a preceding word char, e.g. an email like a@b — not a mention).
export function activeMentionToken(
  text: string,
  caret: number
): { query: string; start: number; end: number } | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret - 1;
  // Walk left over the word chars that make up the partial username.
  while (i >= 0 && /\w/.test(text[i])) i--;
  if (i < 0 || text[i] !== "@") return null;
  // The `@` must start a word (preceded by whitespace/punctuation or string
  // start) — otherwise it's part of another token (email, etc).
  if (i > 0 && /\w/.test(text[i - 1])) return null;
  return { query: text.slice(i + 1, caret), start: i, end: caret };
}

// Replace the active token [start,end) with `@username ` and return the new text
// plus the caret position that follows the inserted mention.
export function insertMention(
  text: string,
  token: { start: number; end: number },
  username: string
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const insert = `@${username}`;
  // Add a trailing space only when the next char isn't already whitespace.
  const sep = after.startsWith(" ") || after === "" ? "" : " ";
  const head = before + insert + sep;
  return { text: head + after, caret: head.length };
}

// Resolve the final caption text + recorded drafts into the wire format
// `[{user_id, start, len}]` (spec §7d.2). We scan every `@word` token in the
// final text and, for each whose word exactly matches a recorded draft's
// username (case-insensitive), emit a mention with the token's char offsets.
// Greedy `\w+` capture means `@ab` never matches inside `@abcd`, so prefix
// usernames don't collide. Drafts whose token was edited away are dropped.
export function computeMentions(
  text: string,
  drafts: DraftMention[]
): { user_id: string; start: number; len: number }[] {
  if (drafts.length === 0) return [];
  const byName = new Map<string, string>();
  for (const d of drafts) byName.set(d.username.toLowerCase(), d.user_id);
  const out: { user_id: string; start: number; len: number }[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text))) {
    const uid = byName.get(m[1].toLowerCase());
    if (uid) out.push({ user_id: uid, start: m.index, len: m[0].length });
  }
  return out;
}

// Split a caption into ordered plain-text / mention segments for rendering. Each
// mention segment carries the RESOLVED username (spec §7d.2) — we render
// `@{username}` from the mention, not the raw [start,len) slice, so renames
// propagate. Out-of-range / overlapping mentions are skipped defensively.
export type CaptionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; mention: Mention };

export function segmentCaption(
  caption: string,
  mentions: Mention[] | null | undefined
): CaptionSegment[] {
  if (!caption) return [];
  const valid = (mentions ?? [])
    .filter(
      (m) =>
        Number.isFinite(m.start) &&
        Number.isFinite(m.len) &&
        m.len > 0 &&
        m.start >= 0 &&
        m.start + m.len <= caption.length &&
        !!m.username
    )
    .sort((a, b) => a.start - b.start);

  const segments: CaptionSegment[] = [];
  let cursor = 0;
  for (const m of valid) {
    if (m.start < cursor) continue; // overlaps a previous mention — skip
    if (m.start > cursor) segments.push({ kind: "text", text: caption.slice(cursor, m.start) });
    segments.push({ kind: "mention", mention: m });
    cursor = m.start + m.len;
  }
  if (cursor < caption.length) segments.push({ kind: "text", text: caption.slice(cursor) });
  return segments;
}

// Normalize a search-result user (autocomplete row) into a draft mention.
export function draftFromUser(u: UserBrief): DraftMention {
  return {
    user_id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
  };
}
