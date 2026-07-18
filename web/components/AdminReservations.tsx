"use client";

// Settings → Admin (spec §7c): username reservations / whitelist. Shown only to
// real admins who are NOT warped (rendered alongside AdminWarp). Every 1–4 char
// username is reserved by default; here an admin can additionally whitelist a
// specific email for a specific username so only that person can claim it.
// Styling mirrors AdminWarp / DeveloperKeys (card section + result list).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, errorMessage } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { useToast } from "@/providers/ToastProvider";
import { RowSkeleton } from "@/components/Skeleton";
import { SearchIcon, Spinner } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import type { UsernameReservation } from "@/lib/types";

export function AdminReservations() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [queryText, setQueryText] = useState("");
  const debounced = useDebounced(queryText.trim(), 300);

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-reservations", debounced],
    queryFn: () =>
      api.get<{ reservations: UsernameReservation[] }>(
        `/v1/admin/username-reservations?q=${encodeURIComponent(debounced)}`,
      ),
  });
  const reservations = data?.reservations ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-reservations"] });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ reservation: UsernameReservation }>(
        "/v1/admin/username-reservations",
        { username: username.trim().toLowerCase(), email: email.trim().toLowerCase() },
      ),
    onSuccess: (res) => {
      toast.success(
        "Reservation saved",
        `@${res.reservation.username} → ${res.reservation.email}`,
      );
      setEmail("");
      setUsername("");
      invalidate();
    },
    onError: (err) => toast.error("Couldn't save reservation", errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (u: string) =>
      api.del(`/v1/admin/username-reservations/${encodeURIComponent(u)}`),
    onSuccess: () => {
      toast.success("Reservation removed");
      invalidate();
    },
    onError: (err) => toast.error("Couldn't remove reservation", errorMessage(err)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !email.trim()) {
      toast.error("Enter both an email and a username");
      return;
    }
    create.mutate();
  };

  return (
    <section className="card mt-4 p-5" aria-label="Username reservations">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-bold text-fg">Username reservations</h2>
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">
          Whitelist
        </span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        Every 1–4 character username is reserved automatically. Whitelist a{" "}
        <strong>specific email</strong> for a username and only that person can
        claim it — everyone else sees it as taken.
      </p>

      <form onSubmit={submit} className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          className="input"
          type="email"
          placeholder="person@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email to whitelist"
          autoComplete="off"
        />
        <input
          className="input"
          type="text"
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          aria-label="Username to reserve"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={create.isPending}
          className="btn-brand shrink-0 !px-4 disabled:opacity-60"
        >
          {create.isPending ? <Spinner size={16} /> : "Whitelist"}
        </button>
      </form>

      <div className="relative mb-3">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <SearchIcon size={16} />
        </span>
        <input
          className="input !pl-9"
          type="search"
          placeholder="Search reservations by username or email…"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="Search reservations"
          autoComplete="off"
        />
      </div>

      {isLoading ? (
        <RowSkeleton rows={3} />
      ) : isError ? (
        <p className="rounded-xl bg-no/10 p-3 text-sm text-no">
          {errorMessage(error)}
        </p>
      ) : reservations.length === 0 ? (
        <p className="rounded-xl bg-surface/60 p-3 text-sm text-muted">
          {debounced.length > 0
            ? `No reservations match “${debounced}”.`
            : "No username reservations yet."}
        </p>
      ) : (
        <ul className="divide-y divide-edge rounded-xl border border-edge">
          {reservations.map((r) => (
            <li key={r.username} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-fg">
                  @{r.username}
                </p>
                <p className="truncate text-xs text-muted">
                  {r.email}
                  <span className="font-sans"> · added {timeAgo(r.created_at)} ago</span>
                </p>
              </div>
              <button
                onClick={() => remove.mutate(r.username)}
                disabled={remove.isPending}
                className="shrink-0 text-xs font-bold text-no hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
