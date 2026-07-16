import { useState } from "react";
import { useApi } from "../lib/api";
import { tap } from "../lib/haptics";
import type { UserProfile } from "../lib/types";
import { Button } from "./ui";

// Optimistic follow button. Private accounts get an IG-style "Requested"
// pending state until the owner approves (spec §7 privacy settings).

export function FollowButton({ user, onChange }: { user: UserProfile; onChange?: () => void }) {
  const api = useApi();
  const [following, setFollowing] = useState(!!user.is_following);
  const [requested, setRequested] = useState(!!user.follow_requested);
  const [busy, setBusy] = useState(false);

  const label = following ? "Following" : requested ? "Requested" : "Follow";
  const variant = following || requested ? ("subtle" as const) : ("primary" as const);

  const toggle = async () => {
    if (busy) return;
    tap();
    setBusy(true);
    const wasFollowing = following;
    const wasRequested = requested;
    try {
      if (wasFollowing || wasRequested) {
        setFollowing(false);
        setRequested(false);
        await api.del(`/v1/users/${user.id}/follow`);
      } else if (user.is_private) {
        setRequested(true);
        await api.post(`/v1/users/${user.id}/follow`);
      } else {
        setFollowing(true);
        await api.post(`/v1/users/${user.id}/follow`);
      }
      onChange?.();
    } catch {
      setFollowing(wasFollowing);
      setRequested(wasRequested);
    } finally {
      setBusy(false);
    }
  };

  return <Button title={label} variant={variant} small onPress={toggle} style={{ paddingHorizontal: 22 }} />;
}
