import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Api } from "./api";
import { BRAND_BLUE } from "./theme";

// Expo push registration + deep linking (spec §7d.4). Everything here is
// defensive: a denied permission, a simulator, or a missing EAS projectId must
// never throw into the app — push is best-effort. On login we register the
// device token; on logout we delete it (see runBeforeLogout).

const TOKEN_KEY = "thassa.pushToken.v1";

// Foreground presentation: show the banner + play sound even when the app is
// open. Registered once at module load (imported by lib/session or PushSync).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// The EAS projectId is required by getExpoPushTokenAsync. It lives in the Expo
// config (extra.eas.projectId) and is injected at build time; on a bare/dev
// setup without EAS it's absent, so we skip registration gracefully.
function getProjectId(): string | null {
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
    ?.projectId;
  const fromEas = (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  return fromExtra ?? fromEas ?? null;
}

// Registers this device for push and stores the token server-side
// (POST /v1/me/push-token). Returns the token, or null when unavailable
// (simulator, permission denied, or no projectId). Never throws.
export async function registerForPush(api: Api): Promise<string | null> {
  try {
    if (!Device.isDevice) return null; // push tokens aren't issued on simulators

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
        lightColor: BRAND_BLUE,
      }).catch(() => {});
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== "granted") return null;

    const projectId = getProjectId();
    if (!projectId) return null; // no EAS project configured — skip quietly

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return null;

    await api.post("/v1/me/push-token", { token, platform: "expo" });
    await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => {});
    return token;
  } catch {
    return null;
  }
}

// Removes this device's token server-side (DELETE /v1/me/push-token {token}) on
// logout, then clears the stored token.
export async function unregisterForPush(api: Api): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await api.delWithBody("/v1/me/push-token", { token }).catch(() => {});
    await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
  } catch {
    /* best-effort */
  }
}

// Maps a tapped notification's data payload to an in-app route (spec §7d.4:
// dm → conversation, mention/large_entry → post/market, follow → profile,
// position.swing → market). Mirrors the in-app notification row hrefs and is
// tolerant of whichever ids the backend attaches.
export function notificationHref(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const kind = typeof data.kind === "string" ? data.kind : "";
  const marketId = str(data.market_id);
  const postId = str(data.post_id);
  const conversationId = str(data.conversation_id);
  const username = str((data.user as { username?: string } | undefined)?.username) ?? str(data.username);

  switch (kind) {
    case "dm.message":
      return conversationId ? `/conversation/${conversationId}` : "/messages";
    case "post.mention":
      return postId ? `/post/${postId}` : marketId ? `/market/${marketId}` : null;
    case "following.large_entry":
      return marketId ? `/market/${marketId}` : postId ? `/post/${postId}` : null;
    case "position.swing":
    case "market.matched":
    case "order.filled":
      return marketId ? `/market/${marketId}` : null;
    case "follow.new":
    case "follow":
    case "follow.request":
    case "follow.accepted":
      return username ? `/user/${username}` : "/notifications";
    default:
      break;
  }
  // Generic fallback by whatever id is present.
  if (marketId) return `/market/${marketId}`;
  if (postId) return `/post/${postId}`;
  if (conversationId) return `/conversation/${conversationId}`;
  if (username) return `/user/${username}`;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// A pre-logout hook so the DELETE /v1/me/push-token call runs while the auth
// token is still valid (auth.logout awaits this before clearing the session).
let beforeLogout: (() => Promise<void>) | null = null;
export function setBeforeLogout(fn: (() => Promise<void>) | null) {
  beforeLogout = fn;
}
export async function runBeforeLogout(): Promise<void> {
  try {
    await beforeLogout?.();
  } catch {
    /* best-effort */
  }
}
