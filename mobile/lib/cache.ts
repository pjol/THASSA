import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

// ---------------------------------------------------------------------------
// RotatingCache — a 500 MB, disk-backed, rotating client-side cache.
//
// It caches two kinds of things behind a single byte budget:
//   1. GET API JSON responses (offline fallback + warm reuse), and
//   2. media blobs (images/videos) downloaded for display.
//
// Every entry's payload lives on disk (expo-file-system, under the app's
// document directory) so blobs never touch AsyncStorage (which is for small
// values only). Only lightweight metadata — key, size, last-access, hit count
// and priority tier — is persisted, in a compact JSON manifest.
//
// EVICTION (LFU + LRU hybrid, evict-from-back-on-insert)
// ------------------------------------------------------
// Each entry gets an eviction SCORE combining frequency and recency:
//
//     ageHours = (now - lastAccess) / 3_600_000
//     score    = (hits + 1) / (1 + ageHours)        // base LFU/LRU-decay
//     score   += PINNED_BONUS                         // if tier === "pinned"
//
// A high hit count raises the score (frequency); the (1 + ageHours) divisor
// decays it as the entry goes untouched (recency). `pinned` entries get a huge
// additive bonus so they always sort last and are evicted only when nothing
// else remains and the budget is still exceeded ("over-budget-by-pinned-alone").
//
// On every insert that would push total bytes over the 500 MB budget we sort
// entries by score ascending — lowest-priority / lowest-score at the BACK — and
// evict from the back until the new item fits. A single item larger than the
// whole budget is simply not cached.
//
// DURABILITY / SAFETY
// -------------------
// The manifest is persisted after every mutation. A corrupt manifest resets the
// cache. Every operation is defensive: any failure resolves to a miss (null) or
// the original remote URL so a cache problem can never break a request.
// ---------------------------------------------------------------------------

export type CacheTier = "pinned" | "normal" | "media";

interface CacheMeta {
  key: string;
  file: string; // filename within CACHE_DIR
  bytes: number;
  tier: CacheTier;
  isJson: boolean; // true → parse on read; false → media blob (return uri)
  lastAccess: number; // ms epoch
  hits: number;
  createdAt: number;
}

interface Manifest {
  version: number;
  seq: number; // monotonic counter for unique filenames
  totalBytes: number;
  entries: Record<string, CacheMeta>;
}

const MANIFEST_VERSION = 1;
const BUDGET_BYTES = 500 * 1024 * 1024; // 500 MB total across JSON + media
const PINNED_BONUS = 1e12; // keeps pinned entries at the front of retention
const JSON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week
const MEDIA_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // a month
const FLUSH_DEBOUNCE_MS = 800;

// documentDirectory is null on web/SSR; guard everything on `dir`.
const DIR = FileSystem.documentDirectory
  ? FileSystem.documentDirectory + "thassa-rotcache/"
  : null;
const MANIFEST_FILE = DIR ? DIR + "manifest.json" : null;
// Mirror the manifest in AsyncStorage too, so metadata survives even if the
// on-disk manifest write is interrupted; the file copy is authoritative.
const MANIFEST_ASYNC_KEY = "thassa.rotcache.manifest.v1";

function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, seq: 0, totalBytes: 0, entries: {} };
}

// UTF-8 byte length of a string without allocating a TextEncoder (which isn't
// guaranteed present in the RN runtime). Used to estimate JSON payload size.
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // surrogate pair → one 4-byte code point
      i++;
    } else n += 3;
  }
  return n;
}

function scoreOf(m: CacheMeta, now: number): number {
  const ageHours = Math.max(0, now - m.lastAccess) / 3_600_000;
  let s = (m.hits + 1) / (1 + ageHours);
  if (m.tier === "pinned") s += PINNED_BONUS;
  return s;
}

function isStale(m: CacheMeta, now: number): boolean {
  const maxAge = m.tier === "media" ? MEDIA_MAX_AGE_MS : JSON_MAX_AGE_MS;
  return now - m.createdAt > maxAge;
}

class RotatingCache {
  private manifest: Manifest = emptyManifest();
  private ready?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  // Identity used to classify user-specific data as `pinned` (own profile /
  // own recent posts). Registered from the session once /v1/me loads.
  private pinnedUsername: string | null = null;

  // --- lifecycle ---------------------------------------------------------

  private async ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    if (!DIR || !MANIFEST_FILE) return; // web / unsupported
    try {
      const info = await FileSystem.getInfoAsync(DIR);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
      }
    } catch {
      /* best-effort */
    }
    let raw: string | null = null;
    try {
      const info = await FileSystem.getInfoAsync(MANIFEST_FILE);
      if (info.exists) raw = await FileSystem.readAsStringAsync(MANIFEST_FILE);
    } catch {
      raw = null;
    }
    if (raw == null) {
      try {
        raw = await AsyncStorage.getItem(MANIFEST_ASYNC_KEY);
      } catch {
        raw = null;
      }
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Manifest;
        if (
          parsed &&
          parsed.version === MANIFEST_VERSION &&
          parsed.entries &&
          typeof parsed.totalBytes === "number"
        ) {
          this.manifest = parsed;
          return;
        }
      } catch {
        /* corrupt → reset below */
      }
      // Corrupt or incompatible manifest → wipe and start clean.
      await this.hardReset();
    }
  }

  private async hardReset(): Promise<void> {
    this.manifest = emptyManifest();
    if (!DIR) return;
    try {
      await FileSystem.deleteAsync(DIR, { idempotent: true });
      await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    } catch {
      /* best-effort */
    }
    try {
      await AsyncStorage.removeItem(MANIFEST_ASYNC_KEY);
    } catch {
      /* best-effort */
    }
  }

  // Serialize all mutating operations so concurrent puts/evicts don't corrupt
  // the manifest or double-count bytes.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async persistNow(): Promise<void> {
    this.dirty = false;
    const raw = JSON.stringify(this.manifest);
    if (DIR && MANIFEST_FILE) {
      try {
        await FileSystem.writeAsStringAsync(MANIFEST_FILE, raw);
      } catch {
        /* best-effort */
      }
    }
    try {
      await AsyncStorage.setItem(MANIFEST_ASYNC_KEY, raw);
    } catch {
      /* best-effort */
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.enqueue(() => this.persistNow());
    }, FLUSH_DEBOUNCE_MS);
  }

  private pathOf(file: string): string {
    return (DIR ?? "") + file;
  }

  private async removeEntry(meta: CacheMeta): Promise<void> {
    try {
      await FileSystem.deleteAsync(this.pathOf(meta.file), { idempotent: true });
    } catch {
      /* best-effort */
    }
    this.manifest.totalBytes -= meta.bytes;
    if (this.manifest.totalBytes < 0) this.manifest.totalBytes = 0;
    delete this.manifest.entries[meta.key];
  }

  // Evict lowest-score entries from the back until `incoming` extra bytes fit
  // within the budget. Non-pinned go first; pinned only if nothing else remains.
  private async evictToFit(incoming: number): Promise<boolean> {
    if (incoming > BUDGET_BYTES) return false; // can never fit
    const now = Date.now();
    // Drop any stale entries first (free cheap wins before scoring).
    for (const meta of Object.values(this.manifest.entries)) {
      if (isStale(meta, now)) await this.removeEntry(meta);
    }
    while (this.manifest.totalBytes + incoming > BUDGET_BYTES) {
      const entries = Object.values(this.manifest.entries);
      if (entries.length === 0) break;
      // Sort ascending by score → back of the cache first.
      entries.sort((a, b) => scoreOf(a, now) - scoreOf(b, now));
      const victim = entries[0];
      if (!victim) break;
      await this.removeEntry(victim);
    }
    return this.manifest.totalBytes + incoming <= BUDGET_BYTES;
  }

  // --- public: identity / tier classification ---------------------------

  setPinnedIdentity(username: string | null): void {
    this.pinnedUsername = username ? username.toLowerCase() : null;
  }

  // Tier for a GET api path: /v1/me and the signed-in user's own profile and
  // own posts are pinned (highest retention). Everything else is `normal`.
  tierForPath(path: string): CacheTier {
    const p = path.split("?")[0];
    if (p === "/v1/me") return "pinned";
    const u = this.pinnedUsername;
    if (u) {
      if (p === `/v1/users/${u}`) return "pinned";
      if (p === `/v1/users/${u}/posts`) return "pinned";
    }
    return "normal";
  }

  // --- public: JSON api cache -------------------------------------------

  async getJSON<T>(key: string): Promise<T | null> {
    try {
      await this.ensureReady();
    } catch {
      return null;
    }
    const meta = this.manifest.entries[key];
    if (!meta || !meta.isJson) return null;
    const now = Date.now();
    if (isStale(meta, now)) {
      this.enqueue(async () => {
        const m = this.manifest.entries[key];
        if (m) {
          await this.removeEntry(m);
          this.scheduleFlush();
        }
      });
      return null;
    }
    let raw: string;
    try {
      raw = await FileSystem.readAsStringAsync(this.pathOf(meta.file));
    } catch {
      // File vanished under us — drop the dangling meta.
      this.enqueue(async () => {
        const m = this.manifest.entries[key];
        if (m) {
          await this.removeEntry(m);
          this.scheduleFlush();
        }
      });
      return null;
    }
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      return null;
    }
    // Touch: bump frequency + recency (debounced persist).
    meta.hits += 1;
    meta.lastAccess = now;
    this.scheduleFlush();
    return data;
  }

  async putJSON<T>(key: string, data: T, tier: CacheTier = "normal"): Promise<void> {
    if (!DIR) return;
    let raw: string;
    try {
      raw = JSON.stringify(data);
    } catch {
      return; // non-serializable — nothing to cache
    }
    if (raw === undefined) return;
    const bytes = utf8Bytes(raw);
    await this.enqueue(async () => {
      try {
        await this.ensureReady();
        await this.writeEntry(key, raw, bytes, tier, true);
      } catch {
        /* cache is best-effort */
      }
    });
  }

  // --- public: media blob cache -----------------------------------------

  // Returns a local file:// uri for `remoteUrl`, downloading and caching it on
  // first access (counting its bytes toward the budget, evicting as needed).
  // On any failure it falls through to the original remote URL so display is
  // never blocked by a cache problem.
  async cachedMediaUri(remoteUrl: string): Promise<string> {
    if (!DIR || !remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return remoteUrl;
    const key = "MEDIA:" + remoteUrl;
    try {
      await this.ensureReady();
    } catch {
      return remoteUrl;
    }
    const existing = this.manifest.entries[key];
    if (existing && !existing.isJson) {
      const now = Date.now();
      if (!isStale(existing, now)) {
        try {
          const info = await FileSystem.getInfoAsync(this.pathOf(existing.file));
          if (info.exists) {
            existing.hits += 1;
            existing.lastAccess = now;
            this.scheduleFlush();
            return info.uri;
          }
        } catch {
          /* fall through to re-download */
        }
      }
    }
    // Download to a temp file, measure it, then move it into the managed cache.
    const tmp = DIR + "dl-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".tmp";
    let size = 0;
    try {
      const res = await FileSystem.downloadAsync(remoteUrl, tmp);
      if (!res || res.status < 200 || res.status >= 300) {
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
        return remoteUrl;
      }
      const info = await FileSystem.getInfoAsync(tmp);
      size = info.exists ? info.size : 0;
    } catch {
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      return remoteUrl;
    }
    return this.enqueue(async () => {
      try {
        await this.ensureReady();
        const uri = await this.adoptFile(key, tmp, size, "media");
        return uri ?? remoteUrl;
      } catch {
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
        return remoteUrl;
      }
    });
  }

  // --- internal write paths (run inside the serialized queue) -----------

  private async writeEntry(
    key: string,
    contents: string,
    bytes: number,
    tier: CacheTier,
    isJson: boolean
  ): Promise<void> {
    if (!DIR) return;
    const prev = this.manifest.entries[key];
    if (prev) await this.removeEntry(prev); // free old bytes/file before re-add
    const fit = await this.evictToFit(bytes);
    if (!fit) return; // item alone exceeds budget → skip caching
    const file = ++this.manifest.seq + ".dat";
    try {
      await FileSystem.writeAsStringAsync(this.pathOf(file), contents);
    } catch {
      return;
    }
    const now = Date.now();
    this.manifest.entries[key] = {
      key,
      file,
      bytes,
      tier,
      isJson,
      lastAccess: now,
      hits: 1,
      createdAt: now,
    };
    this.manifest.totalBytes += bytes;
    await this.persistNow();
  }

  // Move an already-downloaded temp file into the managed cache under `key`.
  private async adoptFile(
    key: string,
    tmpUri: string,
    bytes: number,
    tier: CacheTier
  ): Promise<string | null> {
    if (!DIR) return null;
    const prev = this.manifest.entries[key];
    if (prev) await this.removeEntry(prev);
    const fit = await this.evictToFit(bytes);
    if (!fit) {
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      return null;
    }
    const file = ++this.manifest.seq + ".bin";
    const dest = this.pathOf(file);
    try {
      await FileSystem.moveAsync({ from: tmpUri, to: dest });
    } catch {
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      return null;
    }
    const now = Date.now();
    this.manifest.entries[key] = {
      key,
      file,
      bytes,
      tier,
      isJson: false,
      lastAccess: now,
      hits: 1,
      createdAt: now,
    };
    this.manifest.totalBytes += bytes;
    await this.persistNow();
    return dest;
  }

  // --- diagnostics / maintenance ----------------------------------------

  async stats(): Promise<{ totalBytes: number; budget: number; count: number }> {
    try {
      await this.ensureReady();
    } catch {
      /* ignore */
    }
    return {
      totalBytes: this.manifest.totalBytes,
      budget: BUDGET_BYTES,
      count: Object.keys(this.manifest.entries).length,
    };
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.hardReset();
      await this.persistNow();
    });
  }
}

// Single app-wide instance.
export const rotatingCache = new RotatingCache();

// ---------------------------------------------------------------------------
// Drop-in replacements for the previous diskCache helpers, so existing call
// sites in lib/api.ts keep working unchanged. `setCachedJSON` accepts an
// optional tier (pinned/normal) for prioritized retention.
// ---------------------------------------------------------------------------

export function getCachedJSON<T>(key: string): Promise<T | null> {
  return rotatingCache.getJSON<T>(key);
}

export function setCachedJSON<T>(
  key: string,
  data: T,
  tier: CacheTier = "normal"
): Promise<void> {
  return rotatingCache.putJSON<T>(key, data, tier);
}

// Classify a GET path into a cache tier (pinned for user-specific data).
export function tierForPath(path: string): CacheTier {
  return rotatingCache.tierForPath(path);
}

// Register the signed-in user's username so their own profile / posts are
// cached at `pinned` tier. Call with null on sign-out.
export function setCachePinnedIdentity(username: string | null): void {
  rotatingCache.setPinnedIdentity(username);
}

// Download-and-cache a remote media URL; returns a local file:// uri (or the
// original URL on failure). Safe to adopt from components/media prefetch later.
export function cachedMediaUri(remoteUrl: string): Promise<string> {
  return rotatingCache.cachedMediaUri(remoteUrl);
}
