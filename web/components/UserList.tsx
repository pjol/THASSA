"use client";

// Browsable followers / following list (spec §7d.3): rows of UserBrief
// (avatar, @username, display name) each linking to the profile, with an inline
// follow/unfollow button where the row carries viewer-relative state (self and
// stateless rows omit it). Fetches GET /v1/users/{username}/followers|following.

import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApi, ApiError } from "@/lib/api";
import { useSession } from "@/providers/SessionProvider";
import { useLoadMoreRef } from "@/lib/hooks";
import { Avatar } from "@/components/Avatar";
import { FollowButton } from "@/components/FollowButton";
import { RowSkeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ChevronLeftIcon, LockIcon, Spinner } from "@/components/icons";

import type { UserBrief } from "@/lib/types";

type Kind = "followers" | "following";

// The list endpoints return either { followers: [...] } or { following: [...] };
// normalise to a single items array.
type ListPage = {
  followers?: UserBrief[];
  following?: UserBrief[];
  next_cursor: string | null;
};

export function UserList({ username, kind }: { username: string; kind: Kind }) {
  const api = useApi();
  const { me } = useSession();

  const query = useInfiniteQuery({
    queryKey: ["user-connections", username, kind],
    queryFn: ({ pageParam }) =>
      api.get<ListPage>(
        `/v1/users/${username}/${kind}?limit=30${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });

  const users =
    query.data?.pages.flatMap((p) => p.followers ?? p.following ?? []) ?? [];
  const loadMoreRef = useLoadMoreRef(
    () => query.fetchNextPage(),
    !!query.hasNextPage && !query.isFetchingNextPage,
  );

  const title = kind === "followers" ? "Followers" : "Following";

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-4 md:pt-8">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/u/${username}`}
          aria-label="Back to profile"
          className="-ml-1.5 rounded-full p-1.5 text-fg transition hover:bg-surface"
        >
          <ChevronLeftIcon size={22} />
        </Link>
        <h1 className="text-lg font-extrabold tracking-tight text-fg">
          {title}
          <Link
            href={`/u/${username}`}
            className="ml-2 text-sm font-semibold text-muted hover:text-fg"
          >
            @{username}
          </Link>
        </h1>
      </div>

      {query.isLoading && <RowSkeleton rows={8} />}

      {query.isError &&
        (query.error instanceof ApiError && query.error.status === 403 ? (
          <EmptyState
            icon={<LockIcon size={36} />}
            title="This list is private"
            body="Only approved followers can see who they follow."
          />
        ) : (
          <EmptyState
            title="Couldn't load"
            body="Try again in a moment."
            action={
              <button onClick={() => query.refetch()} className="btn-brand">
                Retry
              </button>
            }
          />
        ))}

      {!query.isLoading && !query.isError && users.length === 0 && (
        <EmptyState
          title={kind === "followers" ? "No followers yet" : "Not following anyone yet"}
        />
      )}

      <ul className="divide-y divide-edge">
        {users.map((u, i) => (
          <li
            key={u.id}
            ref={i === Math.max(0, users.length - 4) ? loadMoreRef : undefined}
            className="flex items-center gap-3 py-2.5"
          >
            <Link href={`/u/${u.username}`} className="shrink-0">
              <Avatar user={u} size="sm" />
            </Link>
            <Link href={`/u/${u.username}`} className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-bold text-fg hover:underline">
                @{u.username}
              </span>
            </Link>
            {/* Follow button only for other users when viewer state is known. */}
            {me &&
              u.id !== me.id &&
              typeof u.is_following !== "undefined" && (
                <FollowButton
                  user={{
                    id: u.id,
                    is_following: !!u.is_following,
                    follow_requested: !!u.follow_requested,
                    private: !!u.private,
                  }}
                  className="!py-1.5 text-xs"
                />
              )}
          </li>
        ))}
      </ul>

      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Spinner className="text-muted" />
        </div>
      )}
    </div>
  );
}
