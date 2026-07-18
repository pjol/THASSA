"use client";

// Caption input with @-mention autocomplete (spec §7d.2). As the user types an
// "@" followed by word chars, the active token is detected and GET
// /v1/users/search?q= drives a keyboard-navigable dropdown (avatar + @username
// + display name). Selecting inserts "@username " at the token and records the
// id→username mapping. Mentions are stored by USER ID (rename-safe): on every
// change we re-derive the { user_id, start, len } offsets from the current
// caption text + recorded mappings, so edits keep offsets correct. The derived
// array is handed back through onChange for the parent to POST verbatim.
//
// Reusable: any caption/comment field can drop this in.

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { Avatar } from "@/components/Avatar";
import { Spinner } from "@/components/icons";

import type { MentionInput, UserLite } from "@/lib/types";

const WORD = /[A-Za-z0-9_]/;

// Re-derive wire mentions from the final caption text + recorded id↔username
// mappings. Exported (pure) so it can be reused/tested independently. Every
// boundary-delimited "@name" token whose name is a recorded mention emits an
// offset; a user mentioned twice yields two entries.
export function deriveMentions(
  caption: string,
  recorded: Map<string, string>, // username -> user_id
): MentionInput[] {
  const out: MentionInput[] = [];
  const re = /@([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(caption))) {
    const at = m.index;
    const before = at === 0 ? "" : caption[at - 1];
    if (before && WORD.test(before)) continue; // e.g. an email's "@" — not a mention
    const userId = recorded.get(m[1]);
    if (userId) out.push({ user_id: userId, start: at, len: m[0].length });
  }
  return out;
}

interface ActiveToken {
  start: number; // index of "@"
  query: string; // chars after "@" up to the caret
}

// The @-token the caret currently sits inside, if any.
function activeTokenAt(text: string, caret: number): ActiveToken | null {
  let i = caret;
  while (i > 0 && WORD.test(text[i - 1])) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const at = i - 1;
  const before = at === 0 ? "" : text[at - 1];
  if (before && WORD.test(before)) return null; // must be boundary-delimited
  return { start: at, query: text.slice(i, caret) };
}

export function MentionTextarea({
  value,
  onChange,
  id,
  rows = 3,
  maxLength,
  placeholder,
  className = "",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string, mentions: MentionInput[]) => void;
  id?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const api = useApi();
  const ref = useRef<HTMLTextAreaElement>(null);
  // username -> user_id for every mention the user has ever picked. Stale
  // entries are harmless: deriveMentions only emits ones whose token survives.
  const recorded = useRef<Map<string, string>>(new Map());
  const [token, setToken] = useState<ActiveToken | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);

  const debouncedQuery = useDebounced(token?.query ?? "", 200);
  const open = token !== null && debouncedQuery.trim().length >= 1;

  const search = useQuery({
    queryKey: ["user-search", debouncedQuery],
    queryFn: () =>
      api.get<{ users: UserLite[] }>(
        `/v1/users/search?q=${encodeURIComponent(debouncedQuery)}`,
      ),
    enabled: open,
    staleTime: 30_000,
  });
  const results = open ? (search.data?.users ?? []) : [];

  const emit = (text: string) =>
    onChange(text, deriveMentions(text, recorded.current));

  const syncFromEl = (el: HTMLTextAreaElement) => {
    const c = el.selectionStart ?? el.value.length;
    setCaret(c);
    setToken(activeTokenAt(el.value, c));
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    emit(e.target.value);
    setHighlight(0);
    syncFromEl(e.target);
  };

  // Caret moved without editing (arrow/click) — re-evaluate the active token.
  const handleCaretMove = () => {
    if (ref.current) syncFromEl(ref.current);
  };

  const choose = (u: UserLite) => {
    const el = ref.current;
    if (!el || !token) return;
    recorded.current.set(u.username, u.id);
    const insert = `@${u.username} `;
    const before = value.slice(0, token.start);
    const after = value.slice(caret);
    const next = before + insert + after;
    const nextCaret = before.length + insert.length;
    setToken(null);
    setHighlight(0);
    emit(next);
    // Restore focus + caret after React re-renders the controlled value.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(results[Math.min(highlight, results.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setToken(null);
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={className}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={handleCaretMove}
        onKeyUp={(e) => {
          // Arrow keys move the caret; other keys are handled by onChange.
          if (e.key.startsWith("Arrow")) handleCaretMove();
        }}
        onBlur={() => setTimeout(() => setToken(null), 120)}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? "mention-listbox" : undefined}
      />

      {open && (results.length > 0 || search.isFetching) && (
        <ul
          id="mention-listbox"
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-2xl border border-edge bg-card p-1 shadow-soft"
        >
          {search.isFetching && results.length === 0 && (
            <li className="flex justify-center py-3">
              <Spinner size={16} className="text-muted" />
            </li>
          )}
          {results.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                // onMouseDown (not click) so it fires before the textarea blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(u);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                  i === highlight ? "bg-surface" : "hover:bg-surface"
                }`}
              >
                <Avatar user={u} size="sm" />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-bold text-fg">
                    @{u.username}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
