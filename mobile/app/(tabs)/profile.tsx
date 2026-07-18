import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ProfileView } from "../../components/ProfileView";
import { ProfileSkeleton } from "../../components/skeletons";
import { ErrorState } from "../../components/states";
import { useApi } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useTheme } from "../../lib/theme";
import type { UserProfile } from "../../lib/types";

// Own profile tab: full profile surface with Posts / Reels / Trades / Wallet.
export default function MyProfile() {
  const api = useApi();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { me } = useSession();

  const q = useQuery({
    queryKey: ["profile", me?.username],
    enabled: !!me?.username,
    queryFn: () => api.get<{ user: UserProfile }>(`/v1/users/${me!.username}`).then((r) => r.user),
  });

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      {q.isLoading || !me ? (
        <ProfileSkeleton />
      ) : q.isError || !q.data ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : (
        <ProfileView profile={{ ...q.data, is_me: true }} isOwn onRefetch={() => q.refetch()} />
      )}
    </View>
  );
}
