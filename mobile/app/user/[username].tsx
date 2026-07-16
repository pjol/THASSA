import { useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProfileView } from "../../components/ProfileView";
import { ErrorState, Loading } from "../../components/states";
import { useApi } from "../../lib/api";
import { useSession } from "../../lib/session";
import type { UserProfile } from "../../lib/types";

// Public profile (spec §7): header always visible; content tabs (Posts, Reels,
// Trades) gated by privacy — the backend enforces, we render the states.
export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const api = useApi();
  const { me } = useSession();
  const navigation = useNavigation();

  const q = useQuery({
    queryKey: ["profile", username],
    enabled: !!username,
    queryFn: () => api.get<UserProfile>(`/v1/users/${username}`),
  });

  useEffect(() => {
    navigation.setOptions({ title: username ? `@${username}` : "Profile" });
  }, [navigation, username]);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;

  const isOwn = !!me && q.data.id === me.id;
  return <ProfileView profile={q.data} isOwn={isOwn} onRefetch={() => q.refetch()} />;
}
