import AsyncStorage from "@react-native-async-storage/async-storage";

// Tiny persisted JSON cache used by the Api class so recently-viewed content
// still renders when the device is offline / the backend is unreachable.
const PREFIX = "thassa.cache.v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week

interface Entry<T> {
  at: number;
  data: T;
}

export async function setCachedJSON<T>(key: string, data: T): Promise<void> {
  try {
    const entry: Entry<T> = { at: Date.now(), data };
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    /* cache is best-effort */
  }
}

export async function getCachedJSON<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    if (!entry || Date.now() - entry.at > MAX_AGE_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}
