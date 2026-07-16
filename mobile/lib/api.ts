import { useMemo, useRef } from "react";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import { useAuth } from "./auth";
import { getCachedJSON, setCachedJSON } from "./diskCache";

export const API_BASE = process.env.EXPO_PUBLIC_API_URL || "http://localhost:8080";

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error || `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

// Thrown only after all reconnection attempts fail — i.e. the backend is
// genuinely unreachable. Callers use this to show a "can't reach server" state.
export class NetworkError extends Error {
  constructor() {
    super("Can't reach the server");
    this.name = "NetworkError";
  }
}

// errorMessage maps any thrown error to short, plain-language text suitable for
// user-facing display. Use this for all error copy.
export function errorMessage(e: unknown): string {
  if (e instanceof NetworkError) return "Can't reach the server. Check your internet and try again.";
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403) return "You don't have access to do that.";
    if (e.status === 404) return "We couldn't find that.";
    if (e.status >= 500) return "Something went wrong on our end. Please try again.";
    return e.body?.error || "That didn't work. Please try again.";
  }
  if (e instanceof Error && /user rejected|denied|cancell?ed/i.test(e.message)) {
    return "Signature request was canceled.";
  }
  return "That didn't work. Please try again.";
}

const MAX_RETRIES = 4; // total attempts before giving up
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with a little jitter: ~0.4s, 0.8s, 1.6s, 3.2s.
const backoffMs = (attempt: number) =>
  Math.min(400 * 2 ** attempt, 5000) + Math.floor(Math.random() * 150);

function safeParse(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Api attaches the Privy access token to every backend request and transparently
// retries connection failures (and transient 5xx on GETs) before surfacing an
// error, so a flaky/slow backend doesn't immediately bounce the user. GETs fall
// back to the on-device cache when offline.
export class Api {
  constructor(private getToken: () => Promise<string | null>) {}

  // idemKey: one Idempotency-Key per logical mutation (spec §6.7) — generated
  // once in the public method and REUSED across every retry attempt, so a
  // double-tap or flaky-network retry can't double-place an order/send.
  private async req<T>(
    method: string,
    path: string,
    body?: any,
    attempt = 0,
    idemKey?: string
  ): Promise<T> {
    const token = await this.getToken();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Connection failure (server down/unreachable). Mutations are safe to
      // retry because the Idempotency-Key dedupes them server-side.
      if (attempt < MAX_RETRIES - 1) {
        await sleep(backoffMs(attempt));
        return this.req<T>(method, path, body, attempt + 1, idemKey);
      }
      throw new NetworkError();
    }

    const json = safeParse(await res.text());
    if (!res.ok) {
      // Retry transient upstream errors: idempotent GETs, plus keyed mutations
      // (deduped server-side by the Idempotency-Key).
      if (
        RETRYABLE_STATUS.has(res.status) &&
        (method === "GET" || !!idemKey) &&
        attempt < MAX_RETRIES - 1
      ) {
        await sleep(backoffMs(attempt));
        return this.req<T>(method, path, body, attempt + 1, idemKey);
      }
      throw new ApiError(res.status, json);
    }
    return json as T;
  }

  async get<T>(path: string): Promise<T> {
    try {
      const data = await this.req<T>("GET", path);
      // Warm the device cache for offline reuse (fire-and-forget).
      setCachedJSON("GET:" + path, data);
      return data;
    } catch (e) {
      if (e instanceof NetworkError) {
        const cached = await getCachedJSON<T>("GET:" + path);
        if (cached !== null) return cached;
      }
      throw e;
    }
  }
  post<T>(path: string, body?: any) {
    return this.req<T>("POST", path, body, 0, Crypto.randomUUID());
  }
  put<T>(path: string, body?: any) {
    return this.req<T>("PUT", path, body, 0, Crypto.randomUUID());
  }
  patch<T>(path: string, body?: any) {
    return this.req<T>("PATCH", path, body, 0, Crypto.randomUUID());
  }
  del<T>(path: string) {
    return this.req<T>("DELETE", path, undefined, 0, Crypto.randomUUID());
  }

  // Upload a local file (from expo-image-picker) via the media presign flow
  // (spec §6.3): POST /v1/media → presigned PUT → POST /v1/media/{id}/complete.
  // Returns the media id (attach it to posts/stories/messages) and public URL.
  async uploadMedia(
    localUri: string,
    contentType: string,
    opts?: { onProgress?: (fraction: number) => void }
  ): Promise<{ id: string; url: string }> {
    const presign = await this.post<{ id: string; upload_url: string; public_url: string }>(
      "/v1/media",
      { content_type: contentType }
    );
    // React Native's fetch can't reliably turn a file:// URI into a blob body,
    // so use expo-file-system's binary uploadAsync instead.
    const task = FileSystem.createUploadTask(
      presign.upload_url,
      localUri,
      {
        httpMethod: "PUT",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { "Content-Type": contentType },
      },
      (data) => {
        if (opts?.onProgress && data.totalBytesExpectedToSend > 0) {
          opts.onProgress(Math.min(1, data.totalBytesSent / data.totalBytesExpectedToSend));
        }
      }
    );
    const res = await task.uploadAsync();
    if (!res || res.status < 200 || res.status >= 300) {
      throw new Error(`upload failed (${res?.status ?? "network"})`);
    }
    // Kicks off server-side processing (HLS transcode for videos).
    await this.post(`/v1/media/${presign.id}/complete`);
    opts?.onProgress?.(1);
    return { id: presign.id, url: presign.public_url };
  }
}

// Returns a STABLE Api instance for the component's lifetime. The token getter
// identity changes between renders; calling it through a ref keeps `api` stable
// so effects/useCallbacks that depend on it don't re-run every render.
export function useApi(): Api {
  const { getAccessToken } = useAuth();
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;
  return useMemo(() => new Api(() => tokenRef.current()), []);
}
