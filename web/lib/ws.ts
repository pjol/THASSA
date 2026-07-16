"use client";

// Single shared WebSocket (spec §6.4): one connection per client, JSON frames
// {type, channel, payload}, channel subscribe/unsubscribe, auto-reconnect
// with backoff and automatic resubscription.

import { useEffect } from "react";
import { WS_URL } from "@/lib/config";
import type { WsFrame } from "@/lib/types";

type Handler = (frame: WsFrame) => void;
type TokenGetter = () => Promise<string | null>;

class ThassaSocket {
  private ws: WebSocket | null = null;
  private tokenGetter: TokenGetter | null = null;
  private subs = new Map<string, Set<Handler>>();
  private backoff = 1000;
  private closedByUs = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Called once by the session provider when auth is ready.
  start(tokenGetter: TokenGetter) {
    this.tokenGetter = tokenGetter;
    this.closedByUs = false;
    void this.connect();
  }

  stop() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private async connect() {
    if (this.connecting || !this.tokenGetter || typeof window === "undefined")
      return;
    this.connecting = true;
    try {
      const token = await this.tokenGetter();
      if (!token) return;
      const ws = new WebSocket(
        `${WS_URL}?token=${encodeURIComponent(token)}`,
      );
      this.ws = ws;
      ws.onopen = () => {
        this.backoff = 1000;
        // Resubscribe to every live channel.
        for (const channel of Array.from(this.subs.keys())) {
          ws.send(JSON.stringify({ type: "subscribe", channel }));
        }
      };
      ws.onmessage = (ev) => {
        let frame: WsFrame;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        const handlers = this.subs.get(frame.channel);
        if (handlers) for (const h of Array.from(handlers)) h(frame);
      };
      ws.onclose = () => {
        this.ws = null;
        if (!this.closedByUs) this.scheduleReconnect();
      };
      ws.onerror = () => ws.close();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, 15000);
      void this.connect();
    }, this.backoff);
  }

  subscribe(channel: string, handler: Handler): () => void {
    let set = this.subs.get(channel);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(handler);
    if (isNew && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "subscribe", channel }));
    }
    return () => {
      const s = this.subs.get(channel);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.subs.delete(channel);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "unsubscribe", channel }));
        }
      }
    };
  }

  // Fire-and-forget client frames (typing indicators, read receipts).
  send(frame: { type: string; channel: string; payload?: any }) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(frame));
  }
}

export const socket = new ThassaSocket();

// Subscribe to a channel for the lifetime of the component. Pass null to
// disable (e.g. while an id is still loading). handlerRef pattern is not
// needed as long as callers memoize or accept resubscribes.
export function useChannel(channel: string | null, handler: Handler) {
  useEffect(() => {
    if (!channel) return;
    return socket.subscribe(channel, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);
}
