import { Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "../lib/auth";
import { needsOnboarding, useSession } from "../lib/session";
import { ConnectionError, Loading } from "../components/states";
import { useTheme } from "../lib/theme";

// Staged entry gate: loading → sign-in → onboarding → tabs. Gated carefully so
// a failed backend call never silently dumps a new user into empty tabs.
export default function Index() {
  const { isReady, isSignedIn } = useAuth();
  const { me, status, refresh } = useSession();

  // Privy still resolving.
  if (!isReady) return <Splash />;

  // Not signed in → auth.
  if (!isSignedIn) return <Redirect href="/sign-in" />;

  // Signed in: wait for the backend, surface connection errors explicitly.
  if (status === "loading") return <Splash />;
  if (status === "error") return <ConnectionError onRetry={refresh} />;
  // Ready with no profile yet = a transient state right after sign-in while
  // the first /v1/me is in flight — keep showing the splash, not an error.
  if (!me) return <Splash />;

  // New user must pick a username / finish the profile first.
  if (needsOnboarding(me)) return <Redirect href="/onboarding" />;

  return <Redirect href="/(tabs)" />;
}

function Splash() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Loading />
    </View>
  );
}
