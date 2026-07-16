import { useEffect, useRef } from "react";
import type {
  AppNotification,
  BookLevel,
  Market,
  MarketState,
  Message,
  Order,
  Trade,
  UserProfile,
} from "./types";
import { API_BASE } from "./api";

// Single shared, app-lifetime WebSocket (spec §6.4): one connection, JSON
// frames {type, channel, payload}; the client subscribes/unsubscribes to
// dm:{conversationId}, book:{marketId}, and user:{me} channels. Subscriptions
// are refcounted and re-sent automatically on reconnect.

const WS_BASE =
  process.env.EXPO_PUBLIC_WS_URL || API_BASE.replace(/^http/, "ws");

// Typed event union for everything the backend pushes.
export type WsEvent =
  // dm:{conversationId}
  | { type: "message.new"; channel: string; payload: Message }
  | { type: "typing.start"; channel: string; payload: { user: UserProfile } }
  | { type: "typing.stop"; channel: string; payload: { user: UserProfile } }
  | { type: "read"; channel: string; payload: { user_id: string; at: string } }
  | { type: "message.reaction"; channel: string; payload: { message_id: string; reactions: Record<string, number> } }
  // book:{marketId}
  | {
      type: "book.delta";
      channel: string;
      payload: { market_id: string; yes: BookLevel[]; no: BookLevel[]; yes_price_cents?: number | null; no_price_cents?: number | null };
    }
  | { type: "book.trade"; channel: string; payload: Trade & { market_id: string } }
  | { type: "market.update"; channel: string; payload: { market_id: string; status: MarketState; direction?: boolean | null; market?: Market } }
  // user:{me}
  | { type: "notification"; channel: string; payload: AppNotification }
  | { type: "order.update"; channel: string; payload: Order }
  | { type: "wallet.update"; channel: string; payload: { balance: number } };

export type WsEventType = WsEvent["type"];

type Listener = (e: WsEvent) => void;

let ws: WebSocket | null = null;
let isOpen = false;
let shouldRun = false;
let tokenGetter: (() => Promise<string | null>) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
const listeners = new Set<Listener>();
// channel → refcount; re-subscribed in bulk whenever the socket (re)opens.
const subscriptions = new Map<string, number>();

function rawSend(m: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

async function connect() {
  if (!shouldRun || ws) return;
  const token = tokenGetter ? await tokenGetter() : null;
  if (!shouldRun || !token) return;
  const socket = new WebSocket(`${WS_BASE}/v1/ws?token=${encodeURIComponent(token)}`);
  ws = socket;
  socket.onopen = () => {
    isOpen = true;
    backoff = 1000;
    // Resubscribe every active channel on (re)connect.
    for (const channel of subscriptions.keys()) {
      rawSend({ type: "subscribe", channel });
    }
  };
  socket.onmessage = (ev: WebSocketMessageEvent) => {
    try {
      const e = JSON.parse(ev.data) as WsEvent;
      listeners.forEach((l) => l(e));
    } catch {
      /* ignore malformed frames */
    }
  };
  socket.onclose = () => {
    isOpen = false;
    ws = null;
    if (shouldRun) {
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* noop */
    }
  };
}

// Keep one connection alive while signed in (called by the session provider).
export function startSocket(getToken: () => Promise<string | null>) {
  tokenGetter = getToken;
  shouldRun = true;
  connect();
}
export function stopSocket() {
  shouldRun = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    ws?.close();
  } catch {
    /* noop */
  }
  ws = null;
  isOpen = false;
  subscriptions.clear();
}

export function wsSend(m: { type: string; channel?: string; payload?: unknown }) {
  rawSend(m);
}

function addSubscription(channel: string) {
  const n = subscriptions.get(channel) ?? 0;
  subscriptions.set(channel, n + 1);
  if (n === 0 && isOpen) rawSend({ type: "subscribe", channel });
}
function removeSubscription(channel: string) {
  const n = subscriptions.get(channel) ?? 0;
  if (n <= 1) {
    subscriptions.delete(channel);
    if (isOpen) rawSend({ type: "unsubscribe", channel });
  } else {
    subscriptions.set(channel, n - 1);
  }
}

// Attach a listener to the shared socket for the lifetime of the mounting
// component, optionally holding a channel subscription.
function useSocket(onEvent: Listener, channel?: string) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const listener: Listener = (e) => onEventRef.current(e);
    listeners.add(listener);
    if (channel) addSubscription(channel);
    connect(); // no-op if not signed in yet or already connected
    return () => {
      listeners.delete(listener);
      if (channel) removeSubscription(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);
}

// App-wide realtime listener for the user's own channel (notifications, order
// and wallet updates). The session provider keeps this subscribed globally.
export function useUserChannel(userId: string | null | undefined, onEvent: Listener) {
  useSocket(
    (e) => {
      if (e.type === "notification" || e.type === "order.update" || e.type === "wallet.update") onEvent(e);
    },
    userId ? `user:${userId}` : undefined
  );
}

// Live order-book channel for a market detail / advanced widget.
export function useBookChannel(marketId: string | null | undefined, onEvent: Listener) {
  useSocket(
    (e) => {
      if (
        (e.type === "book.delta" || e.type === "book.trade" || e.type === "market.update") &&
        marketId &&
        e.channel === `book:${marketId}`
      ) {
        onEvent(e);
      }
    },
    marketId ? `book:${marketId}` : undefined
  );
}

// Live conversation channel: new messages, typing bubbles, read receipts.
export function useDmChannel(
  conversationId: string | null | undefined,
  onEvent: Listener
): { sendTyping: (typing: boolean) => void } {
  useSocket(
    (e) => {
      if (conversationId && e.channel === `dm:${conversationId}`) onEvent(e);
    },
    conversationId ? `dm:${conversationId}` : undefined
  );
  return {
    sendTyping: (typing: boolean) => {
      if (conversationId) {
        rawSend({ type: typing ? "typing.start" : "typing.stop", channel: `dm:${conversationId}` });
      }
    },
  };
}

// Listen to every event without holding any subscription (e.g. the messages
// list screen reacting to already-subscribed dm channels).
export function useGlobalWs(onEvent: Listener) {
  useSocket(onEvent);
}
