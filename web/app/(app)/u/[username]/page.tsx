"use client";

// Profile (spec §7 + additions): header (avatar, counts, bio, links, follow/
// edit), THREE content tabs — Posts (grid), Reels, Trades (trade history with
// StateChips + PnL) — plus a Wallet tab on your own profile only. Private
// accounts show only the header to non-followers; trades visibility hides the
// Trades tab for everyone but the owner when private.

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useApi, ApiError } from "@/lib/api";
import { useSession } from "@/providers/SessionProvider";
import { useLoadMoreRef } from "@/lib/hooks";
import { Avatar } from "@/components/Avatar";
import { FollowButton } from "@/components/FollowButton";
import { StateChip } from "@/components/StateChip";
import { WalletTab } from "@/components/WalletTab";
import { GridSkeleton, RowSkeleton, Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import {
  CameraIcon,
  GridIcon,
  LinkIcon,
  LockIcon,
  PlayIcon,
  ReelsIcon,
  SettingsIcon,
  Spinner,
  TradesIcon,
  WalletIcon,
} from "@/components/icons";
import { fmtCents, fmtCount, fmtSignedUnits, timeAgo, displayName } from "@/lib/format";
import type { Post, PostsPage, TradesPage, User } from "@/lib/types";

type Tab = "posts" | "reels" | "trades" | "wallet";

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const api = useApi();
  const router = useRouter();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>("posts");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["user", username],
    queryFn: () => api.get<{ user: User }>(`/v1/users/${username}`),
    enabled: !!username,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-4 pt-8">
        <div className="flex items-center gap-6">
          <Skeleton className="h-24 w-24 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <div className="mt-8">
          <GridSkeleton cells={9} />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <EmptyState
        title={notFound ? "User not found" : "Couldn't load profile"}
        body={notFound ? "This account may have been removed." : "Try again in a moment."}
        action={
          !notFound && (
            <button onClick={() => refetch()} className="btn-brand">
              Retry
            </button>
          )
        }
      />
    );
  }

  const user = data.user;
  const isSelf = user.is_self || user.id === me?.id;
  // Private account: non-followers see only the header (spec addition).
  const locked = user.private && !isSelf && !user.is_following;
  // Trades visibility: private hides the tab for everyone but the owner.
  const tradesVisible = isSelf || user.trades_public;

  const tabs: { key: Tab; label: string; icon: any }[] = [
    { key: "posts", label: "Posts", icon: GridIcon },
    { key: "reels", label: "Reels", icon: ReelsIcon },
    ...(tradesVisible ? [{ key: "trades" as Tab, label: "Trades", icon: TradesIcon }] : []),
    ...(isSelf ? [{ key: "wallet" as Tab, label: "Wallet", icon: WalletIcon }] : []),
  ];

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-10 pt-5 md:pt-9">
      {/* header */}
      <header className="flex items-start gap-5 sm:gap-8">
        <Avatar user={user} size="xl" className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="flex items-center gap-1.5 text-lg font-extrabold text-fg">
              @{user.username}
              {user.private && <LockIcon size={14} className="text-muted" />}
            </h1>
            {isSelf ? (
              <>
                <button onClick={() => router.push("/settings")} className="btn-ghost !py-1.5 text-xs">
                  Edit profile
                </button>
                <button
                  onClick={() => router.push("/settings")}
                  aria-label="Settings"
                  className="rounded-full p-1.5 text-fg transition hover:bg-surface"
                >
                  <SettingsIcon size={18} />
                </button>
              </>
            ) : (
              <FollowButton user={user} onChange={() => refetch()} className="!py-1.5 text-xs" />
            )}
          </div>

          <dl className="mt-3 flex gap-6 text-sm">
            <div>
              <dt className="sr-only">Posts</dt>
              <dd>
                <strong className="text-fg">{fmtCount(user.post_count)}</strong>{" "}
                <span className="text-muted">posts</span>
              </dd>
            </div>
            <div>
              <dt className="sr-only">Followers</dt>
              <dd>
                <Link
                  href={`/u/${user.username}/followers`}
                  className="transition hover:opacity-70"
                >
                  <strong className="text-fg">{fmtCount(user.follower_count)}</strong>{" "}
                  <span className="text-muted">followers</span>
                </Link>
              </dd>
            </div>
            <div>
              <dt className="sr-only">Following</dt>
              <dd>
                <Link
                  href={`/u/${user.username}/following`}
                  className="transition hover:opacity-70"
                >
                  <strong className="text-fg">{fmtCount(user.following_count)}</strong>{" "}
                  <span className="text-muted">following</span>
                </Link>
              </dd>
            </div>
          </dl>

          <div className="mt-2.5 text-sm">
            {user.display_name && <p className="font-bold text-fg">{displayName(user)}</p>}
            {user.bio && <p className="mt-0.5 whitespace-pre-wrap text-fg/90">{user.bio}</p>}
            {(user.links ?? []).map((l) => (
              <a
                key={l}
                href={l.startsWith("http") ? l : `https://${l}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 flex items-center gap-1 truncate text-brand hover:underline"
              >
                <LinkIcon size={12} />
                {l.replace(/^https?:\/\//, "")}
              </a>
            ))}
          </div>
        </div>
      </header>

      {/* private lock */}
      {locked ? (
        <div className="mt-10 border-t border-edge">
          <EmptyState
            icon={<LockIcon size={36} />}
            title="This account is private"
            body="Follow to see their photos, reels and trades. Your request needs their approval."
          />
        </div>
      ) : (
        <>
          {/* tabs */}
          <div
            className="mt-8 flex border-t border-edge"
            role="tablist"
            aria-label="Profile content"
          >
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex flex-1 items-center justify-center gap-1.5 border-t-2 py-3 text-xs font-bold uppercase tracking-wide transition focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                  tab === key ? "-mt-px border-accent text-fg" : "border-transparent text-muted hover:text-fg"
                }`}
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          <div className="mt-3">
            {tab === "posts" && <ProfilePosts username={user.username} kind="posts" />}
            {tab === "reels" && <ProfilePosts username={user.username} kind="reels" />}
            {tab === "trades" && tradesVisible && <ProfileTrades username={user.username} />}
            {tab === "wallet" && isSelf && <WalletTab />}
          </div>
        </>
      )}
    </div>
  );
}

function ProfilePosts({ username, kind }: { username: string; kind: "posts" | "reels" }) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ["user-posts", username, kind],
    queryFn: ({ pageParam }) =>
      api.get<PostsPage>(
        `/v1/users/${username}/posts?limit=18${kind === "reels" ? "&kind=reel" : ""}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const posts = (query.data?.pages.flatMap((p) => p.posts) ?? []).filter((p) =>
    kind === "reels" ? p.kind === "reel" : true,
  );
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  if (query.isLoading) return <GridSkeleton cells={9} />;
  if (posts.length === 0)
    return (
      <EmptyState
        icon={kind === "reels" ? <ReelsIcon size={36} /> : <CameraIcon size={36} />}
        title={kind === "reels" ? "No reels yet" : "No posts yet"}
      />
    );

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        {posts.map((p: Post, i: number) => (
          <Link
            key={p.id}
            href={p.market ? `/markets/${p.market.id}` : kind === "reels" ? "/reels" : "#"}
            ref={(i === Math.max(0, posts.length - 6) ? (loadMoreRef as any) : undefined) as any}
            aria-label={p.caption || "Post"}
            className="group relative block aspect-square overflow-hidden bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            {p.media[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.media[0].url}
                alt={p.caption || "Post"}
                loading="lazy"
                className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
              />
            ) : (
              <span className="flex h-full items-center justify-center p-2 text-center text-[11px] text-muted">
                {p.caption?.slice(0, 60)}
              </span>
            )}
            {(p.kind === "video" || p.kind === "reel") && (
              <span className="absolute right-1.5 top-1.5 text-white drop-shadow">
                <PlayIcon size={14} />
              </span>
            )}
            {p.market && (
              <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">
                {fmtCents(p.market.yes_price_cents)} YES
              </span>
            )}
          </Link>
        ))}
      </div>
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Spinner className="text-muted" />
        </div>
      )}
    </>
  );
}

function ProfileTrades({ username }: { username: string }) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ["user-trades", username],
    queryFn: ({ pageParam }) =>
      api.get<TradesPage>(
        `/v1/users/${username}/trades?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const trades = query.data?.pages.flatMap((p) => p.trades) ?? [];
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  if (query.isLoading) return <RowSkeleton rows={6} />;
  if (trades.length === 0)
    return (
      <EmptyState
        icon={<TradesIcon size={36} />}
        title="No trades yet"
        body="Positions taken on markets show up here."
      />
    );

  return (
    <ul className="card divide-y divide-edge">
      {trades.map((t, i) => (
        <li
          key={t.id}
          ref={i === Math.max(0, trades.length - 4) ? loadMoreRef : undefined}
        >
          <Link
            href={`/markets/${t.market_id}`}
            className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-fg">{t.market_question}</p>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                <strong className={t.side === "yes" ? "text-yes" : "text-no"}>
                  {t.side.toUpperCase()}
                </strong>
                {t.shares} @ {fmtCents(t.price_cents)}
                <span>· {timeAgo(t.created_at)}</span>
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <StateChip
                state={t.market_status === "SETTLED" ? "SETTLED" : t.status}
                direction={t.market_status === "SETTLED" ? t.direction : undefined}
                size="xs"
              />
              {t.pnl != null && (
                <span
                  className={`font-mono text-xs font-bold tabular-nums ${
                    t.pnl.startsWith("-") ? "text-no" : "text-yes"
                  }`}
                >
                  {fmtSignedUnits(t.pnl)}
                </span>
              )}
            </div>
          </Link>
        </li>
      ))}
      {query.isFetchingNextPage && (
        <li className="flex justify-center py-3">
          <Spinner className="text-muted" />
        </li>
      )}
    </ul>
  );
}
