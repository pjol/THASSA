import React, { useMemo, useState } from "react";
import {
  NativeSyntheticEvent,
  Pressable,
  StyleProp,
  Text,
  TextInput,
  TextInputProps,
  TextInputSelectionChangeEventData,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useApi } from "../lib/api";

import {
  activeMentionToken,
  DraftMention,
  draftFromUser,
  insertMention,
} from "../lib/mentions";
import { radius, space, useTheme } from "../lib/theme";
import type { UserBrief } from "../lib/types";
import { Avatar } from "./ui";

// Reusable @-mention text input (spec §7d.2). As the user types `@word` it calls
// GET /v1/users/search?q= and shows an autocomplete list (avatar + @username +
// display name); picking a user inserts `@username` and records a DraftMention.
// The parent owns the text + drafts state so it can call computeMentions(text,
// drafts) at submit time. Used by the create-post caption and comments.

const MIN_QUERY = 1;
const MAX_RESULTS = 6;

export function MentionInput({
  value,
  onChangeText,
  drafts,
  onDraftsChange,
  inputStyle,
  containerStyle,
  listPosition = "below",
  ...inputProps
}: {
  value: string;
  onChangeText: (text: string) => void;
  drafts: DraftMention[];
  onDraftsChange: (drafts: DraftMention[]) => void;
  inputStyle?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  // Where the suggestion list renders relative to the input. Comments sit at the
  // bottom of the screen, so they pass "above".
  listPosition?: "above" | "below";
} & Omit<TextInputProps, "value" | "onChangeText" | "style">) {
  const t = useTheme();
  const api = useApi();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  // A caret-position override applied for exactly one render after inserting a
  // mention, so the cursor lands after the inserted text; cleared afterwards to
  // hand selection control back to the OS (avoids Android caret jank).
  const [caretOverride, setCaretOverride] = useState<number | null>(null);

  // Only detect a token when there's a collapsed caret (no active range select).
  const token = useMemo(
    () => (selection.start === selection.end ? activeMentionToken(value, selection.start) : null),
    [value, selection]
  );
  const query = token && token.query.length >= MIN_QUERY ? token.query : null;

  const search = useQuery({
    queryKey: ["user-search", query],
    enabled: !!query,
    queryFn: () => api.get<{ users: UserBrief[] }>(`/v1/users/search?q=${encodeURIComponent(query!)}`),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const results = (search.data?.users ?? []).slice(0, MAX_RESULTS);
  const open = !!query && results.length > 0;

  const choose = (u: UserBrief) => {
    if (!token) return;
    const next = insertMention(value, token, u.username);
    onChangeText(next.text);
    setCaretOverride(next.caret);
    setSelection({ start: next.caret, end: next.caret });
    // Record the draft (dedup by id — the same user may be mentioned twice).
    const draft = draftFromUser(u);
    if (!drafts.some((d) => d.user_id === draft.user_id && d.username === draft.username)) {
      onDraftsChange([...drafts, draft]);
    }
  };

  const onSelectionChange = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setSelection(e.nativeEvent.selection);
    setCaretOverride(null);
  };

  const list = open ? (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: radius.md,
        backgroundColor: t.surface,
        overflow: "hidden",
        marginTop: listPosition === "below" ? 6 : 0,
        marginBottom: listPosition === "above" ? 6 : 0,
      }}
    >
      {results.map((u, i) => (
        <Pressable
          key={u.id}
          onPress={() => choose(u)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: space.md,
            paddingVertical: 8,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: t.border,
          }}
        >
          <Avatar url={u.avatar_url} size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: "700", fontSize: 13.5 }}>@{u.username}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  ) : null;

  return (
    <View style={containerStyle}>
      {listPosition === "above" ? list : null}
      <TextInput
        {...inputProps}
        style={inputStyle}
        value={value}
        onChangeText={onChangeText}
        selection={caretOverride !== null ? { start: caretOverride, end: caretOverride } : undefined}
        onSelectionChange={onSelectionChange}
      />
      {listPosition === "below" ? list : null}
    </View>
  );
}
