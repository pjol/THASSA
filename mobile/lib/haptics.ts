import * as Haptics from "expo-haptics";

// Best-effort haptics on key actions (like, order submitted, tab press...).
export const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
export const thud = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
export const success = () =>
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
export const warn = () =>
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
export const failure = () =>
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
