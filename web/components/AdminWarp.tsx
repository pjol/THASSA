"use client";

// Settings → Admin (spec §7c.3): shown only to real admins who are NOT already
// warped. Search users by email/username (GET /v1/admin/users?q=) and "Warp"
// into any result to view the app entirely as that user. Styling mirrors
// DeveloperKeys (card section + result list).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { useWarpControls } from "@/providers/WarpProvider";
import { Avatar } from "@/components/Avatar";
import { RowSkeleton } from "@/components/Skeleton";
import { SearchIcon } from "@/components/icons";
import type { AdminUser } from "@/lib/types";

export function AdminWarp() {
  const api = useApi();
  const { enter } = useWarpControls();

  const [queryText, setQueryText] = useState("");
  const debounced = useDebounced(queryText.trim(), 300);
  const [warping, setWarping] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-users", debounced],
    queryFn: () =>
      api.get<{ users: AdminUser[] }>(
        `/v1/admin/users?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length >= 2,
  });
  const users = data?.users ?? [];

  const warpInto = async (u: AdminUser) => {
    setWarping(u.id);
    try {
      // Validate + resolve the target server-side (UX convenience); the header
      // is the real mechanism. enter() sets it, clears caches and refetches.
      const res = await api.post<{ user: AdminUser }>("/v1/admin/warp", {
        user_id: u.id,
      });
      await enter({
        id: res.user.id,
        username: res.user.username,
        email: res.user.email,
        avatar_url: res.user.avatar_url,
      });
    } catch {
      // Fall back to the search result if the validation call is unavailable.
      await enter({
        id: u.id,
        username: u.username,
        email: u.email,
        avatar_url: u.avatar_url,
      });
    } finally {
      setWarping(null);
    }
  };

  return (
    <section className="card mt-4 p-5" aria-label="Admin">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-bold text-fg">Admin</h2>
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">
          Warp
        </span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        Search a user by email or username and <strong>warp</strong> into their
        account to view the app as them. Warp is read-only — you can see
        everything they see, but can&apos;t act on their behalf.
      </p>

      <div className="relative mb-3">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <SearchIcon size={16} />
        </span>
        <input
          className="input !pl-9"
          type="search"
          placeholder="Search by email or username…"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="Search users to warp into"
          autoComplete="off"
        />
      </div>

      {debounced.length < 2 ? (
        <p className="rounded-xl bg-surface/60 p-3 text-sm text-muted">
          Type at least 2 characters to search.
        </p>
      ) : isLoading ? (
        <RowSkeleton rows={3} />
      ) : isError ? (
        <p className="rounded-xl bg-no/10 p-3 text-sm text-no">
          {errorMessage(error)}
        </p>
      ) : users.length === 0 ? (
        <p className="rounded-xl bg-surface/60 p-3 text-sm text-muted">
          No users match “{debounced}”.
        </p>
      ) : (
        <ul className="divide-y divide-edge rounded-xl border border-edge">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-3.5 py-3">
              <Avatar
                user={{
                  username: u.username,
                  display_name: null,
                  avatar_url: u.avatar_url,
                }}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-fg">
                  @{u.username}
                </p>
                <p className="truncate text-xs text-muted">{u.email}</p>
              </div>
              <button
                onClick={() => warpInto(u)}
                disabled={warping !== null}
                className="btn-brand shrink-0 !px-4 !py-1.5 text-xs disabled:opacity-60"
              >
                {warping === u.id ? "Warping…" : "Warp"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
