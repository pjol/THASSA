"use client";

// Conversation list: the API inlines each conversation's most recent messages
// so opening a thread is instant — we seed the thread's react-query cache
// here for the top conversations (spec §6.3 / §7 pre-fetch).

import Link from "next/link";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { useSession } from "@/providers/SessionProvider";
import { Avatar } from "@/components/Avatar";
import { RowSkeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { MessageIcon } from "@/components/icons";
import { timeAgo, displayName } from "@/lib/format";
import type { Conversation } from "@/lib/types";

export default function MessagesPage() {
  const api = useApi();
  const { me } = useSession();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get<{ conversations: Conversation[] }>("/v1/conversations"),
  });

  // Seed thread caches with the inlined recent messages for instant open.
  useEffect(() => {
    for (const c of data?.conversations ?? []) {
      queryClient.setQueryData(["messages-initial", c.id], c.recent_messages);
    }
  }, [data, queryClient]);

  const conversations = data?.conversations ?? [];

  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-4 md:pt-8">
      <h1 className="mb-4 text-xl font-extrabold tracking-tight text-fg">Messages</h1>

      {isLoading && <RowSkeleton rows={8} />}

      {!isLoading && conversations.length === 0 && (
        <EmptyState
          icon={<MessageIcon size={40} />}
          title="No messages yet"
          body="DMs with other Thassa users show up here."
        />
      )}

      <ul className="divide-y divide-edge">
        {conversations.map((c) => {
          const others = c.members.filter((m) => m.id !== me?.id);
          const peer = others[0] ?? c.members[0];
          const last = c.recent_messages[c.recent_messages.length - 1];
          return (
            <li key={c.id}>
              <Link
                href={`/messages/${c.id}`}
                className="flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              >
                <Avatar user={peer} size="md" />
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm ${c.unread_count > 0 ? "font-extrabold text-fg" : "font-semibold text-fg"}`}>
                    {c.kind === "group"
                      ? others.map((o) => o.username).join(", ")
                      : displayName(peer)}
                  </p>
                  <p className={`truncate text-sm ${c.unread_count > 0 ? "font-semibold text-fg" : "text-muted"}`}>
                    {last
                      ? last.body ?? (last.media ? "Sent an attachment" : "")
                      : "Say hi"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {last && <span className="text-xs text-muted">{timeAgo(last.created_at)}</span>}
                  {c.unread_count > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                      {c.unread_count}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
