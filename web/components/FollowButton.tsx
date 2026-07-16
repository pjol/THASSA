"use client";

// Optimistic follow/unfollow. Private accounts (spec §7 additions): following
// a private account creates a follow request → button shows "Requested"
// until approved.

import { useState } from "react";
import { useApi, errorMessage } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { User } from "@/lib/types";

export function FollowButton({
  user,
  onChange,
  className = "",
}: {
  user: Pick<User, "id" | "is_following" | "follow_requested" | "private">;
  onChange?: () => void;
  className?: string;
}) {
  const api = useApi();
  const toast = useToast();
  const [state, setState] = useState<"none" | "requested" | "following">(
    user.is_following ? "following" : user.follow_requested ? "requested" : "none",
  );
  const [busy, setBusy] = useState(false);

  const act = async () => {
    if (busy) return;
    setBusy(true);
    const prev = state;
    try {
      if (state === "none") {
        setState(user.private ? "requested" : "following");
        await api.post(`/v1/users/${user.id}/follow`);
      } else {
        setState("none");
        await api.del(`/v1/users/${user.id}/follow`);
      }
      onChange?.();
    } catch (err) {
      setState(prev);
      toast.error("Couldn't update follow", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const label =
    state === "following"
      ? "Following"
      : state === "requested"
        ? "Requested"
        : "Follow";

  return (
    <button
      onClick={act}
      disabled={busy}
      aria-pressed={state !== "none"}
      className={`${
        state === "none" ? "btn-brand" : "btn-ghost"
      } !px-5 ${className}`}
    >
      {label}
    </button>
  );
}
