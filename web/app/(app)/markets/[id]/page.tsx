"use client";

// Market detail (spec §7): prices + trade ticket (via MarketCard), live order
// book, my positions and open orders, the public settlement query + settle
// button, and Top Posts / Comments tabs (likes+reactions+replies work on
// markets exactly like posts).

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useChannel } from "@/lib/ws";
import { useTrading } from "@/lib/trading";
import { useToast } from "@/providers/ToastProvider";
import { Avatar } from "@/components/Avatar";
import { MarketCard } from "@/components/MarketCard";
import { OrderBook } from "@/components/OrderBook";
import { Comments } from "@/components/Comments";
import { StateChip } from "@/components/StateChip";
import { EmptyState } from "@/components/EmptyState";
import { GridSkeleton, RowSkeleton, Skeleton } from "@/components/Skeleton";
import { PlayIcon } from "@/components/icons";
import { fmtCents, fmtSignedUnits, fmtVolume, timeAgo } from "@/lib/format";
import type { Market, Order, Position, Post } from "@/lib/types";

type Tab = "posts" | "comments" | "activity";

export default function MarketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("posts");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["market", id],
    queryFn: () => api.get<{ market: Market }>(`/v1/markets/${id}`),
    enabled: !!id,
  });

  // Live status flips (SETTLING → SETTLED etc.) come over the book channel.
  useChannel(id ? `book:${id}` : null, (frame) => {
    if (frame.type === "market.update") {
      queryClient.invalidateQueries({ queryKey: ["market", id] });
    }
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 pt-6">
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState
        title="Market not found"
        body="It may have been removed, or the link is wrong."
        action={
          <button onClick={() => refetch()} className="btn-brand">
            Retry
          </button>
        }
      />
    );
  }

  const market = data.market;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-12 pt-4 md:pt-8">
      {/* header */}
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">
        <Link href={`/u/${market.creator.username}`} className="flex items-center gap-1.5 hover:text-fg">
          <Avatar user={market.creator} size="xs" />
          {market.creator.username}
        </Link>
        <span>· opened {timeAgo(market.created_at)} ago</span>
        <span>· Vol {fmtVolume(market.volume)}</span>
      </div>
      <h1 className="text-xl font-extrabold leading-snug tracking-tight text-fg">
        {market.question}
      </h1>
      <div className="mt-2">
        <StateChip state={market.status} direction={market.direction} />
      </div>

      {/* ticket + advanced (order book, settlement query, settle) */}
      <div className="mt-4">
        <MarketCard market={market} linkToDetail={false} />
      </div>

      {/* full order book */}
      <div className="card mt-4 p-4">
        <h2 className="mb-3 text-sm font-bold text-fg">Order book</h2>
        <OrderBook marketId={market.id} />
      </div>

      <MyMarketPositions market={market} />

      {/* tabs */}
      <div className="mt-6 flex gap-2" role="tablist" aria-label="Market content">
        {(["posts", "comments", "activity"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold capitalize transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
              tab === t ? "bg-accent text-accent-fg" : "bg-surface text-muted hover:text-fg"
            }`}
          >
            {t === "posts" ? "Top posts" : t}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "posts" && <MarketPosts marketId={market.id} />}
        {tab === "comments" && (
          <div className="card p-4">
            <Comments subjectType="market" subjectId={market.id} />
          </div>
        )}
        {tab === "activity" && <MyMarketOrders marketId={market.id} />}
      </div>
    </div>
  );
}

function MarketPosts({ marketId }: { marketId: string }) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ["market-posts", marketId],
    queryFn: () =>
      api.get<{ posts: Post[]; next_cursor: string | null }>(
        `/v1/markets/${marketId}/posts?limit=12`,
      ),
  });

  if (isLoading) return <GridSkeleton cells={6} />;
  const posts = data?.posts ?? [];
  if (posts.length === 0)
    return (
      <EmptyState
        title="No posts yet"
        body="Attach this market to a post and earn 10% of taker fees it routes."
      />
    );

  return (
    <div className="grid grid-cols-3 gap-1">
      {posts.map((p) => (
        <Link
          key={p.id}
          href={`/u/${p.author.username}`}
          aria-label={p.caption || `Post by ${p.author.username}`}
          className="relative block aspect-square overflow-hidden rounded-lg bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {p.media[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.media[0].url} alt="" loading="lazy" className="h-full w-full object-cover" />
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
        </Link>
      ))}
    </div>
  );
}

function MyMarketPositions({ market }: { market: Market }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["positions", market.id],
    queryFn: () =>
      api.get<{ positions: Position[] }>(`/v1/positions?market=${market.id}`),
  });
  const positions = data?.positions ?? [];
  if (positions.length === 0) return null;

  const redeemable = market.status === "SETTLED";

  return (
    <div className="card mt-4 p-4">
      <h2 className="mb-2 text-sm font-bold text-fg">Your position</h2>
      <ul className="space-y-2">
        {positions.map((p) => (
          <li key={`${p.market_id}-${p.side}`} className="flex items-center justify-between text-sm">
            <span>
              <strong className={p.side === "yes" ? "text-yes" : "text-no"}>
                {p.shares} {p.side.toUpperCase()}
              </strong>{" "}
              <span className="text-muted">@ {fmtCents(p.avg_price_cents)} avg</span>
            </span>
            <span
              className={`font-mono font-bold tabular-nums ${
                (p.unrealized_pnl ?? p.realized_pnl ?? "0").startsWith("-") ? "text-no" : "text-yes"
              }`}
            >
              {fmtSignedUnits(p.unrealized_pnl ?? p.realized_pnl ?? "0")}
            </span>
          </li>
        ))}
      </ul>
      {redeemable && (
        <button
          onClick={async () => {
            try {
              await api.post(`/v1/markets/${market.id}/redeem`);
              toast.success("Redeemed", "Winnings on the way to your balance.");
              queryClient.invalidateQueries({ queryKey: ["positions"] });
              queryClient.invalidateQueries({ queryKey: ["wallet"] });
            } catch (err) {
              toast.error("Couldn't redeem", errorMessage(err));
            }
          }}
          className="btn-accent mt-3 w-full text-xs"
        >
          Redeem winnings
        </button>
      )}
    </div>
  );
}

function MyMarketOrders({ marketId }: { marketId: string }) {
  const api = useApi();
  const toast = useToast();
  const trading = useTrading();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["orders", marketId],
    queryFn: () =>
      api.get<{ orders: Order[] }>(`/v1/orders?market=${marketId}`),
  });

  if (isLoading) return <RowSkeleton rows={3} />;
  const orders = data?.orders ?? [];
  if (orders.length === 0)
    return <EmptyState title="No orders" body="Your orders on this market appear here." />;

  const cancellable = (o: Order) =>
    o.status === "RESTING" || o.status === "PARTIAL" || o.status === "QUEUED";

  return (
    <ul className="card divide-y divide-edge">
      {orders.map((o) => (
        <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0">
            <strong className={o.side === "yes" ? "text-yes" : "text-no"}>
              {o.side.toUpperCase()}
            </strong>{" "}
            {o.filled_shares}/{o.shares} @ {fmtCents(o.price_cents)}
            <span className="ml-2 text-xs text-muted">{timeAgo(o.created_at)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <StateChip state={o.status} size="xs" />
            {cancellable(o) && (
              <button
                onClick={async () => {
                  try {
                    await trading.cancelOrder(o.id);
                    toast.success("Order canceled");
                    queryClient.invalidateQueries({ queryKey: ["orders", marketId] });
                  } catch (err) {
                    toast.error("Couldn't cancel", errorMessage(err));
                  }
                }}
                className="text-xs font-bold text-no hover:underline"
              >
                Cancel
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
