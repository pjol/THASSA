"use client";

// Notifications: follow-requests approval UI (private accounts) + the
// notification list. Live items arrive via the user:{me} WS channel (toasted
// globally in AppShell; the list invalidates through react-query).

import Link from "next/link";
import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { useLoadMoreRef } from "@/lib/hooks";
import { Avatar } from "@/components/Avatar";
import { RowSkeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { BellIcon, Spinner } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import type {
  FollowRequest,
  Notification,
  NotificationsPage,
} from "@/lib/types";

function describe(n: Notification): { text: string; href: string } {
  const actor = n.payload.actor?.username ?? "Someone";
  switch (n.kind) {
    case "market.matched":
      return {
        text: `Your bet was taken — "${n.payload.market_question ?? "your market"}"`,
        href: `/markets/${n.payload.market_id ?? ""}`,
      };
    case "market.settled":
      return {
        text: `Market settled: "${n.payload.market_question ?? ""}"`,
        href: `/markets/${n.payload.market_id ?? ""}`,
      };
    case "order.filled":
      return {
        text: `Your order filled on "${n.payload.market_question ?? "a market"}"`,
        href: `/markets/${n.payload.market_id ?? ""}`,
      };
    case "dm.message":
      return {
        text: `${actor} sent you a message`,
        href: `/messages/${n.payload.conversation_id ?? ""}`,
      };
    case "post.liked":
      return { text: `${actor} liked your post`, href: `/u/${n.payload.actor?.username ?? ""}` };
    case "post.commented":
      return { text: `${actor} commented: ${n.payload.text ?? ""}`, href: `/u/${n.payload.actor?.username ?? ""}` };
    case "post.mention":
      return {
        text: `${actor} mentioned you in a post`,
        // Deep-link to the post (same convention as post sharing).
        href: n.payload.post_id ? `/?post=${n.payload.post_id}` : `/u/${n.payload.actor?.username ?? ""}`,
      };
    case "position.swing":
      return {
        text: `Your position in "${n.payload.market_question ?? "a market"}" moved more than 50%`,
        href: `/markets/${n.payload.market_id ?? ""}`,
      };
    case "following.large_entry":
      return {
        text: `${actor} placed a large entry in "${n.payload.market_question ?? "a market"}"`,
        href: `/markets/${n.payload.market_id ?? ""}`,
      };
    case "follow":
    case "follow.new":
      return { text: `${actor} started following you`, href: `/u/${n.payload.actor?.username ?? ""}` };
    case "follow.request":
      return { text: `${actor} requested to follow you`, href: `/notifications` };
    default:
      return { text: n.payload.text ?? "Notification", href: "/notifications" };
  }
}

export default function NotificationsPage() {
  const api = useApi();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ["notifications"],
    queryFn: ({ pageParam }) =>
      api.get<NotificationsPage>(
        `/v1/notifications?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });

  const notifications = query.data?.pages.flatMap((p) => p.notifications) ?? [];
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  // Mark all read when the page is viewed.
  useEffect(() => {
    api.post("/v1/notifications/read").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-4 md:pt-8">
      <h1 className="mb-4 text-xl font-extrabold tracking-tight text-fg">
        Notifications
      </h1>

      <FollowRequests />

      {query.isLoading && <RowSkeleton rows={8} />}

      {!query.isLoading && notifications.length === 0 && (
        <EmptyState
          icon={<BellIcon size={40} />}
          title="Nothing yet"
          body="Likes, fills, matched bets and follows land here."
        />
      )}

      <ul className="divide-y divide-edge">
        {notifications.map((n, i) => {
          const { text, href } = describe(n);
          return (
            <li key={n.id} ref={i === Math.max(0, notifications.length - 4) ? loadMoreRef : undefined}>
              <Link
                href={href}
                className={`flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
                  n.read_at ? "" : "bg-brand-soft/30"
                }`}
              >
                {n.payload.actor ? (
                  <Avatar user={n.payload.actor} size="sm" />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-muted">
                    <BellIcon size={16} />
                  </span>
                )}
                <p className="min-w-0 flex-1 text-sm leading-snug text-fg">
                  {text}
                  <span className="ml-1.5 text-xs text-muted">{timeAgo(n.created_at)}</span>
                </p>
                {!n.read_at && <span className="h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
              </Link>
            </li>
          );
        })}
      </ul>

      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Spinner className="text-muted" />
        </div>
      )}
    </div>
  );
}

function FollowRequests() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["follow-requests"],
    queryFn: () =>
      api.get<{ follow_requests: FollowRequest[] }>("/v1/me/follow-requests"),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "deny" }) =>
      api.post(`/v1/follow-requests/${id}/${action}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["follow-requests"] });
    },
    onError: (err) => toast.error("Couldn't update request", errorMessage(err)),
  });

  const requests = data?.follow_requests ?? [];
  if (isLoading || requests.length === 0) return null;

  return (
    <section className="card mb-5 p-4" aria-label="Follow requests">
      <h2 className="mb-3 text-sm font-bold text-fg">
        Follow requests <span className="text-muted">({requests.length})</span>
      </h2>
      <ul className="space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="flex items-center gap-3">
            <Link href={`/u/${r.requester.username}`}>
              <Avatar user={r.requester} size="sm" />
            </Link>
            <Link
              href={`/u/${r.requester.username}`}
              className="min-w-0 flex-1 truncate text-sm font-semibold text-fg hover:underline"
            >
              {r.requester.username}
              <span className="ml-1.5 font-normal text-muted">{timeAgo(r.created_at)}</span>
            </Link>
            <button
              onClick={() => act.mutate({ id: r.id, action: "approve" })}
              disabled={act.isPending}
              className="btn-brand !px-4 !py-1.5 text-xs"
            >
              Confirm
            </button>
            <button
              onClick={() => act.mutate({ id: r.id, action: "deny" })}
              disabled={act.isPending}
              className="btn-ghost !px-4 !py-1.5 text-xs"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
