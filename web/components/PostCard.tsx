"use client";

// IG-style post card: header, media carousel, actions (optimistic like,
// comments sheet, emoji reactions, share), caption, comments preview, and
// the embedded MarketCard when a market is attached. Orders placed from the
// widget automatically carry this post's affiliate attribution.

import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { Avatar } from "@/components/Avatar";
import { MediaCarousel } from "@/components/MediaCarousel";
import { MarketCard } from "@/components/MarketCard";
import { Sheet } from "@/components/Sheet";
import { Comments } from "@/components/Comments";
import { renderCaption, clipMentions } from "@/components/Caption";
import {
  CommentIcon,
  HeartIcon,
  ShareIcon,
  SmileIcon,
} from "@/components/icons";
import { fmtCount, timeAgo } from "@/lib/format";
import type { Post } from "@/lib/types";

const REACTION_EMOJIS = ["🔥", "😂", "😮", "💰", "👏", "😢"];

export function PostCard({ post }: { post: Post }) {
  const api = useApi();
  const toast = useToast();
  const [liked, setLiked] = useState(post.liked);
  const [likes, setLikes] = useState(post.like_count);
  const [reactions, setReactions] = useState(post.reactions ?? []);
  const [showComments, setShowComments] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);

  const toggleLike = async () => {
    const next = !liked;
    setLiked(next);
    setLikes((n) => Math.max(0, n + (next ? 1 : -1)));
    try {
      if (next)
        await api.put("/v1/likes", { subject_type: "post", subject_id: post.id });
      else
        await api.del("/v1/likes", { subject_type: "post", subject_id: post.id });
    } catch {
      setLiked(!next);
      setLikes((n) => Math.max(0, n + (next ? -1 : 1)));
    }
  };

  const react = async (emoji: string) => {
    setShowReactions(false);
    const existing = reactions.find((r) => r.emoji === emoji);
    const mine = existing?.reacted;
    setReactions((rs) => {
      const others = rs.filter((r) => r.emoji !== emoji);
      if (mine) {
        const c = (existing?.count ?? 1) - 1;
        return c > 0 ? [...others, { emoji, count: c, reacted: false }] : others;
      }
      return [...others, { emoji, count: (existing?.count ?? 0) + 1, reacted: true }];
    });
    try {
      if (mine)
        await api.del("/v1/reactions", { subject_type: "post", subject_id: post.id, emoji });
      else
        await api.put("/v1/reactions", { subject_type: "post", subject_id: post.id, emoji });
    } catch {
      // silent revert on next refetch
    }
  };

  const share = async () => {
    const url = `${window.location.origin}/markets/${post.market?.id ?? ""}`;
    const postUrl = `${window.location.origin}/?post=${post.id}`;
    try {
      await navigator.clipboard.writeText(post.market ? url : postUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  };

  const caption = post.caption ?? "";
  const longCaption = caption.length > 140;

  return (
    <article className="card mb-4 overflow-hidden shadow-soft">
      {/* header */}
      <header className="flex items-center gap-3 px-4 py-3">
        <Link href={`/u/${post.author.username}`} className="shrink-0">
          <Avatar user={post.author} size="sm" />
        </Link>
        <div className="min-w-0 flex-1 leading-tight">
          <Link
            href={`/u/${post.author.username}`}
            className="text-sm font-bold text-fg hover:underline"
          >
            {post.author.username}
          </Link>
          <p className="text-xs text-muted">{timeAgo(post.created_at)}</p>
        </div>
      </header>

      {/* media */}
      {post.media.length > 0 && (
        <MediaCarousel
          media={post.media}
          alt={caption || `Post by ${post.author.username}`}
        />
      )}

      {/* actions */}
      <div className="flex items-center gap-1 px-2.5 pt-2">
        <button
          onClick={toggleLike}
          aria-label={liked ? "Unlike" : "Like"}
          aria-pressed={liked}
          className="rounded-full p-1.5 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand active:scale-90"
        >
          <HeartIcon size={24} filled={liked} className={liked ? "text-no" : "text-fg"} />
        </button>
        <button
          onClick={() => setShowComments(true)}
          aria-label="Comments"
          className="rounded-full p-1.5 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          <CommentIcon size={24} className="text-fg" />
        </button>
        <div className="relative">
          <button
            onClick={() => setShowReactions((s) => !s)}
            aria-label="React with emoji"
            aria-expanded={showReactions}
            className="rounded-full p-1.5 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <SmileIcon size={24} className="text-fg" />
          </button>
          {showReactions && (
            <div className="absolute bottom-full left-0 z-20 mb-1 flex animate-fade-up gap-0.5 rounded-full border border-edge bg-card px-2 py-1.5 shadow-soft">
              {REACTION_EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => react(e)}
                  aria-label={`React ${e}`}
                  className="rounded-full px-1 text-xl transition hover:scale-125"
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={share}
          aria-label="Share"
          className="rounded-full p-1.5 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          <ShareIcon size={22} className="text-fg" />
        </button>
      </div>

      <div className="space-y-1.5 px-4 pb-4 pt-1">
        {/* likes + reactions */}
        <div className="flex items-center gap-2 text-sm">
          {likes > 0 && <span className="font-bold text-fg">{fmtCount(likes)} likes</span>}
          {reactions.length > 0 && (
            <span className="flex items-center gap-1">
              {reactions
                .slice()
                .sort((a, b) => b.count - a.count)
                .slice(0, 4)
                .map((r) => (
                  <button
                    key={r.emoji}
                    onClick={() => react(r.emoji)}
                    aria-label={`${r.emoji} ${r.count}`}
                    className={`rounded-full border px-1.5 py-0.5 text-xs ${
                      r.reacted ? "border-brand bg-brand-soft" : "border-edge bg-surface"
                    }`}
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
            </span>
          )}
        </div>

        {/* caption */}
        {caption && (
          <p className="text-sm leading-snug text-fg/90">
            <Link
              href={`/u/${post.author.username}`}
              className="mr-1.5 font-bold text-fg hover:underline"
            >
              {post.author.username}
            </Link>
            {longCaption && !captionOpen ? (
              <>
                {renderCaption(caption.slice(0, 140), clipMentions(post.mentions, 140))}…{" "}
                <button onClick={() => setCaptionOpen(true)} className="text-muted">
                  more
                </button>
              </>
            ) : (
              renderCaption(caption, post.mentions)
            )}
          </p>
        )}

        {/* market widget */}
        {post.market && (
          <div className="pt-1.5">
            <MarketCard
              market={post.market}
              poster={post.author}
              affiliateId={post.affiliate_id}
              affiliatePostId={post.id}
            />
          </div>
        )}

        {/* comments preview */}
        {post.comment_count > 0 && (
          <button
            onClick={() => setShowComments(true)}
            className="block text-sm text-muted hover:text-fg"
          >
            View all {fmtCount(post.comment_count)} comments
          </button>
        )}
        {(post.top_comments ?? []).slice(0, 2).map((c) => (
          <p key={c.id} className="truncate text-sm text-fg/90">
            <span className="mr-1.5 font-bold text-fg">{c.author.username}</span>
            {c.body}
          </p>
        ))}
      </div>

      {showComments && (
        <Sheet title="Comments" onClose={() => setShowComments(false)}>
          <Comments subjectType="post" subjectId={post.id} />
        </Sheet>
      )}
    </article>
  );
}
