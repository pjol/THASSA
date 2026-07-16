"use client";

// DM thread (spec §6.4/§7): opens instantly from inlined recent messages,
// live message.new over WS, typing bubbles (typing.start/stop), photo/video
// attachments (upload + inline render/HLS), reactions, read states.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApi, errorMessage, newIdempotencyKey } from "@/lib/api";
import { socket, useChannel } from "@/lib/ws";
import { useSession } from "@/providers/SessionProvider";
import { useToast } from "@/providers/ToastProvider";
import { Avatar } from "@/components/Avatar";
import { VideoPlayer } from "@/components/VideoPlayer";
import { RowSkeleton } from "@/components/Skeleton";
import {
  ChevronLeftIcon,
  ImageIcon,
  SendIcon,
  Spinner,
} from "@/components/icons";
import { timeAgo, displayName } from "@/lib/format";
import type { Conversation, Message, MessagesPage } from "@/lib/types";

const DM_REACTIONS = ["❤️", "😂", "😮", "👍", "😢", "🔥"];

export default function ThreadPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const toast = useToast();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [text, setText] = useState("");
  const [live, setLive] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const { data: convData } = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api.get<{ conversation: Conversation }>(`/v1/conversations/${id}`),
    enabled: !!id,
  });
  const conversation = convData?.conversation;
  const peer = conversation?.members.find((m) => m.id !== me?.id);

  // Instant open: recent messages seeded by the list page.
  const seeded = queryClient.getQueryData<Message[]>(["messages-initial", id]);

  const history = useInfiniteQuery({
    queryKey: ["messages", id],
    queryFn: ({ pageParam }) =>
      api.get<MessagesPage>(
        `/v1/conversations/${id}/messages?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
    enabled: !!id,
  });

  // Merge: history pages (newest-first pages of oldest-last lists) + live WS.
  const messages = useMemo(() => {
    const fromHistory = history.data
      ? history.data.pages.flatMap((p) => p.messages)
      : (seeded ?? []);
    const all = [...fromHistory, ...live];
    const seen = new Set<string>();
    return all
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [history.data, seeded, live]);

  // WS: new messages, typing bubbles, read receipts.
  useChannel(id ? `dm:${id}` : null, (frame) => {
    if (frame.type === "message.new") {
      const msg = frame.payload as Message;
      setLive((ms) => [...ms, msg]);
      setTypingUsers((s) => {
        const n = new Set(s);
        n.delete(msg.sender.id);
        return n;
      });
      socket.send({ type: "read", channel: `dm:${id}` });
    }
    if (frame.type === "typing.start" && frame.payload.user_id !== me?.id) {
      setTypingUsers((s) => new Set(s).add(frame.payload.user_id));
    }
    if (frame.type === "typing.stop") {
      setTypingUsers((s) => {
        const n = new Set(s);
        n.delete(frame.payload.user_id);
        return n;
      });
    }
  });

  // Mark read on open.
  useEffect(() => {
    if (!id) return;
    api.post(`/v1/conversations/${id}/read`).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Auto-scroll to newest.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, typingUsers.size]);

  const onType = (v: string) => {
    setText(v);
    socket.send({ type: "typing.start", channel: `dm:${id}` });
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(
      () => socket.send({ type: "typing.stop", channel: `dm:${id}` }),
      2500,
    );
  };

  const send = async (mediaId?: string) => {
    const body = text.trim();
    if (!body && !mediaId) return;
    setSending(true);
    setText("");
    socket.send({ type: "typing.stop", channel: `dm:${id}` });
    try {
      const res = await api.post<{ message: Message }>(
        `/v1/conversations/${id}/messages`,
        { body: body || null, media_id: mediaId ?? null },
        { idempotencyKey: newIdempotencyKey() },
      );
      setLive((ms) => [...ms, res.message]);
    } catch (err) {
      setText(body);
      toast.error("Message not sent", errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const attach = async (file: File) => {
    setAttaching(true);
    try {
      const media = await api.uploadMedia(file);
      await send(media.id);
    } catch (err) {
      toast.error("Attachment failed", errorMessage(err));
    } finally {
      setAttaching(false);
    }
  };

  const react = async (message: Message, emoji: string) => {
    try {
      const mine = message.reactions.some(
        (r) => r.emoji === emoji && r.user_id === me?.id,
      );
      if (mine)
        await api.del("/v1/reactions", {
          subject_type: "message",
          subject_id: message.id,
          emoji,
        });
      else
        await api.put("/v1/reactions", {
          subject_type: "message",
          subject_id: message.id,
          emoji,
        });
      queryClient.invalidateQueries({ queryKey: ["messages", id] });
    } catch {
      // non-fatal
    }
  };

  const lastMine = [...messages].reverse().find((m) => m.sender.id === me?.id);
  const peerReadAt = conversation?.last_read_at; // peer's read marker

  return (
    <div className="mx-auto flex h-[calc(100dvh-8rem)] w-full max-w-xl flex-col px-3 md:h-[100dvh] md:px-4">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge py-3">
        <Link href="/messages" aria-label="Back to messages" className="rounded-full p-1 hover:bg-surface md:hidden">
          <ChevronLeftIcon size={22} />
        </Link>
        {peer && (
          <Link href={`/u/${peer.username}`} className="flex items-center gap-2.5">
            <Avatar user={peer} size="sm" />
            <div className="leading-tight">
              <p className="text-sm font-bold text-fg">{displayName(peer)}</p>
              <p className="text-xs text-muted">@{peer.username}</p>
            </div>
          </Link>
        )}
      </header>

      {/* messages */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-4">
        {history.hasNextPage && (
          <div className="mb-3 flex justify-center">
            <button
              onClick={() => history.fetchNextPage()}
              disabled={history.isFetchingNextPage}
              className="btn-ghost !py-1 text-xs"
            >
              {history.isFetchingNextPage ? <Spinner size={14} /> : "Load earlier"}
            </button>
          </div>
        )}
        {history.isLoading && !seeded && <RowSkeleton rows={6} />}

        <ul className="space-y-1.5">
          {messages.map((m, i) => {
            const mine = m.sender.id === me?.id;
            const prev = messages[i - 1];
            const gap = !prev || prev.sender.id !== m.sender.id;
            return (
              <li key={m.id} className={`group flex items-end gap-2 ${mine ? "justify-end" : ""} ${gap ? "mt-3" : ""}`}>
                {!mine && (
                  <span className="w-7">
                    {gap && <Avatar user={m.sender} size="xs" />}
                  </span>
                )}
                <div className={`relative max-w-[75%] ${mine ? "items-end" : ""}`}>
                  {m.media && (
                    <div className="mb-1 overflow-hidden rounded-2xl">
                      {m.media.kind === "video" && (m.media.hls_url || m.media.url) ? (
                        <VideoPlayer
                          src={m.media.hls_url || m.media.url}
                          poster={m.media.url}
                          active={false}
                          className="aspect-video w-64"
                          ariaLabel="Video attachment"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.media.url} alt="Attachment" className="max-h-72 w-auto rounded-2xl" />
                      )}
                    </div>
                  )}
                  {m.body && (
                    <p
                      className={`whitespace-pre-wrap rounded-3xl px-3.5 py-2 text-sm leading-snug ${
                        mine ? "bg-brand text-white" : "bg-surface text-fg"
                      }`}
                    >
                      {m.body}
                    </p>
                  )}
                  {/* reactions on message */}
                  {m.reactions.length > 0 && (
                    <span className={`absolute -bottom-2.5 ${mine ? "left-1" : "right-1"} rounded-full border border-edge bg-card px-1.5 text-xs shadow-soft`}>
                      {Array.from(new Set(m.reactions.map((r) => r.emoji))).slice(0, 3).join("")}
                      {m.reactions.length > 1 && (
                        <span className="ml-0.5 text-[10px] text-muted">{m.reactions.length}</span>
                      )}
                    </span>
                  )}
                  {/* hover react bar */}
                  <span
                    className={`absolute top-1/2 hidden -translate-y-1/2 gap-0.5 rounded-full border border-edge bg-card px-1.5 py-1 shadow-soft group-hover:flex ${
                      mine ? "right-full mr-1.5" : "left-full ml-1.5"
                    }`}
                  >
                    {DM_REACTIONS.slice(0, 4).map((e) => (
                      <button
                        key={e}
                        onClick={() => react(m, e)}
                        aria-label={`React ${e}`}
                        className="text-sm transition hover:scale-125"
                      >
                        {e}
                      </button>
                    ))}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        {/* read state */}
        {lastMine && peerReadAt && peerReadAt >= lastMine.created_at && (
          <p className="mt-1 pr-1 text-right text-[11px] text-muted">Seen</p>
        )}

        {/* typing bubble */}
        {typingUsers.size > 0 && (
          <div className="mt-3 flex items-end gap-2">
            <span className="w-7">{peer && <Avatar user={peer} size="xs" />}</span>
            <span className="flex items-center gap-1 rounded-3xl bg-surface px-4 py-3" aria-label="Typing">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      <form
        className="flex items-center gap-2 border-t border-edge py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) attach(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={attaching}
          aria-label="Attach photo or video"
          className="rounded-full p-2 text-muted transition hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {attaching ? <Spinner size={18} /> : <ImageIcon size={20} />}
        </button>
        <input
          className="input flex-1 !rounded-full"
          placeholder="Message…"
          value={text}
          onChange={(e) => onType(e.target.value)}
          aria-label="Message"
        />
        <button
          type="submit"
          disabled={sending || (!text.trim() && !attaching)}
          aria-label="Send message"
          className="rounded-full bg-brand p-2.5 text-white transition hover:bg-brand/90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {sending ? <Spinner size={16} /> : <SendIcon size={16} />}
        </button>
      </form>
    </div>
  );
}
