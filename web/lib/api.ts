"use client";

import { useCallback, useMemo } from "react";
import { API_URL } from "@/lib/config";
import { useAuthToken } from "@/providers/AuthProvider";
import type { MediaItem } from "@/lib/types";

type TokenGetter = () => Promise<string | null>;

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error || `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

// Friendly copy for error toasts.
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Please sign in again.";
    if (err.status === 429) return "Slow down a little — try again in a moment.";
    if (err.status >= 500) return "Something went wrong on our end. Try again.";
    return err.message;
  }
  if (err instanceof Error && /fetch|network/i.test(err.message))
    return "Can't reach Thassa. Check your connection.";
  return err instanceof Error ? err.message : "Something went wrong.";
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RequestOpts {
  // Stable key for a logical operation: pass the same key when retrying so
  // the backend can dedupe (spec §6.7 requires it on all mutations). When
  // omitted, a fresh UUID is generated per call — and reused automatically
  // for the built-in network-error retry below.
  idempotencyKey?: string;
}

// Api wraps fetch, attaching the Privy access token as a Bearer token so
// every backend request is authenticated (ASSEMBLY convention §10.9), and an
// Idempotency-Key UUID on every mutating request.
export class Api {
  constructor(private getToken: TokenGetter) {}

  private async req<T>(
    method: string,
    path: string,
    body?: any,
    opts?: RequestOpts,
  ): Promise<T> {
    const token = await this.getToken();
    const mutating = MUTATING.has(method);
    const idempotencyKey = mutating
      ? opts?.idempotencyKey ?? newIdempotencyKey()
      : undefined;

    const doFetch = () =>
      fetch(`${API_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    let res: Response;
    try {
      res = await doFetch();
    } catch (err) {
      if (!mutating) throw err;
      // One transparent retry on network failure, REUSING the same
      // Idempotency-Key so the operation can't double-apply.
      await new Promise((r) => setTimeout(r, 600));
      res = await doFetch();
    }

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  get<T>(path: string) {
    return this.req<T>("GET", path);
  }
  post<T>(path: string, body?: any, opts?: RequestOpts) {
    return this.req<T>("POST", path, body, opts);
  }
  patch<T>(path: string, body?: any, opts?: RequestOpts) {
    return this.req<T>("PATCH", path, body, opts);
  }
  put<T>(path: string, body?: any, opts?: RequestOpts) {
    return this.req<T>("PUT", path, body, opts);
  }
  del<T>(path: string, body?: any, opts?: RequestOpts) {
    return this.req<T>("DELETE", path, body, opts);
  }

  token(): Promise<string | null> {
    return this.getToken();
  }

  // Media pipeline (spec §6.3): presign → PUT (with progress) → complete.
  // Videos are transcoded to HLS server-side; poll until ready if needed.
  async uploadMedia(
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<MediaItem> {
    const { media, upload_url } = await this.post<{
      media: MediaItem;
      upload_url: string;
    }>("/v1/media", {
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
    });

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", upload_url);
      xhr.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream",
      );
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error("upload failed"));
      xhr.onerror = () => reject(new Error("upload failed"));
      xhr.send(file);
    });

    const done = await this.post<{ media: MediaItem }>(
      `/v1/media/${media.id}/complete`,
    );
    return done.media;
  }
}

// useApi returns an Api bound to the current Privy session.
export function useApi(): Api {
  const getToken = useAuthToken();
  const tokenGetter = useCallback(() => getToken(), [getToken]);
  return useMemo(() => new Api(tokenGetter), [tokenGetter]);
}
