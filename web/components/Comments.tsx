"use client";

// Comments work identically on posts and markets (spec §7): likes, reactions
// via emoji, and replies (parent_id). Rendered inside a Sheet from post cards
// or inline on market detail.

import { useState } from "react";
import Link from "next/link";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { useSession } from "@/providers/SessionProvider";
import { useLoadMoreRef } from "@/lib/hooks";
import { Avatar } from "@/components/Avatar";
import { RowSkeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { HeartIcon, Spinner } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import type { Comment, CommentsPage } from "@/lib/types";

export function Comments({
  subjectType,
  subjectId,
}: {
  subjectType: "post" | "market";
  subjectId: string;
}) {
  const api = useApi();
  const toast = useToast();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const base =
    subjectType === "post"
      ? `/v1/posts/${subjectId}/comments`
      : `/v1/markets/${subjectId}/comments`;

  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["comments", subjectType, subjectId],
    queryFn: ({ pageParam }) =>
      api.get<CommentsPage>(
        `${base}?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });

  const comments = query.data?.pages.flatMap((p) => p.comments) ?? [];
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  const send = useMutation({
    mutationFn: () =>
      api.post<{ comment: Comment }>(base, {
        body,
        parent_id: replyTo?.id ?? null,
      }),
    onSuccess: () => {
      setBody("");
      setReplyTo(null);
      queryClient.invalidateQueries({
        queryKey: ["comments", subjectType, subjectId],
      });
    },
    onError: (err) => toast.error("Comment failed", errorMessage(err)),
  });

  return (
    <div className="flex max-h-[65vh] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <RowSkeleton rows={4} />
        ) : comments.length === 0 ? (
          <EmptyState
            title="No comments yet"
            body="Start the conversation."
          />
        ) : (
          <ul className="space-y-4 py-1">
            {comments.map((c, i) => (
              <li
                key={c.id}
                ref={i === comments.length - 2 ? loadMoreRef : undefined}
              >
                <CommentRow comment={c} onReply={() => setReplyTo(c)} />
              </li>
            ))}
            {query.isFetchingNextPage && (
              <li className="flex justify-center py-2">
                <Spinner size={16} className="text-muted" />
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="mt-3 border-t border-edge pt-3">
        {replyTo && (
          <p className="mb-1.5 flex items-center justify-between text-xs text-muted">
            Replying to @{replyTo.author.username}
            <button
              onClick={() => setReplyTo(null)}
              className="font-semibold text-brand"
            >
              Cancel
            </button>
          </p>
        )}
        <form
          className="flex items-center gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate();
          }}
        >
          <Avatar user={me} size="sm" />
          <input
            className="input flex-1"
            placeholder="Add a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Add a comment"
          />
          <button
            type="submit"
            disabled={!body.trim() || send.isPending}
            className="text-sm font-bold text-brand disabled:opacity-40"
          >
            {send.isPending ? <Spinner size={14} /> : "Post"}
          </button>
        </form>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  onReply,
}: {
  comment: Comment;
  onReply: () => void;
}) {
  const api = useApi();
  const [liked, setLiked] = useState(comment.liked);
  const [likes, setLikes] = useState(comment.like_count);

  const toggleLike = async () => {
    const next = !liked;
    setLiked(next);
    setLikes((n) => n + (next ? 1 : -1));
    try {
      if (next)
        await api.put("/v1/likes", { subject_type: "comment", subject_id: comment.id });
      else
        await api.del("/v1/likes", { subject_type: "comment", subject_id: comment.id });
    } catch {
      setLiked(!next);
      setLikes((n) => n + (next ? -1 : 1));
    }
  };

  return (
    <div className="flex items-start gap-2.5">
      <Link href={`/u/${comment.author.username}`}>
        <Avatar user={comment.author} size="sm" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          <Link
            href={`/u/${comment.author.username}`}
            className="mr-1.5 font-bold text-fg hover:underline"
          >
            {comment.author.username}
          </Link>
          <span className="text-fg/90">{comment.body}</span>
        </p>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted">
          <span>{timeAgo(comment.created_at)}</span>
          {likes > 0 && <span>{likes} likes</span>}
          <button onClick={onReply} className="font-semibold hover:text-fg">
            Reply
          </button>
        </div>
      </div>
      <button
        onClick={toggleLike}
        aria-label={liked ? "Unlike comment" : "Like comment"}
        aria-pressed={liked}
        className="mt-1 p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      >
        <HeartIcon size={14} filled={liked} className={liked ? "text-no" : "text-muted"} />
      </button>
    </div>
  );
}
