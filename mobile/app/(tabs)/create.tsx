import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import Svg, { Circle } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { AttachMarket, MarketAttachment, NEW_MARKET_MIN_SPEND } from "../../components/AttachMarket";
import { MentionInput } from "../../components/MentionInput";
import { PhotoEditor } from "../../components/PhotoEditor";
import { StateChip } from "../../components/StateChip";
import { useToasts } from "../../components/Toasts";
import { Button, Field, useInputStyle } from "../../components/ui";
import { errorMessage, useApi } from "../../lib/api";
import { useWallet } from "../../lib/auth";
import { success, tap, warn } from "../../lib/haptics";
import { computeMentions, type DraftMention } from "../../lib/mentions";
import {
  candidateSettlementQuery,
  type Post,
} from "../../lib/types";
import { buildOrder, maxCostUnits, sharesForSpend, signReceiveAuthorization } from "../../lib/signing";
import { radius, space, useTheme } from "../../lib/theme";
import { LogoSpinner } from "../../components/LogoSpinner";

// Upload flow (spec §7): retro-Instagram media picker — the selected photo
// fills the screen width as a paged preview carousel; hold-and-drag a page to
// reorder; the last carousel page is a "+" tile that adds more (max 10 per
// post) — then caption → attach market (search / generate) → Post signs the
// EIP-712 order + EIP-3009 funding auth via the Privy embedded wallet and
// submits everything atomically, with a clear PENDING → OPEN progression
// (MATCHED arrives later by push/WS toast).
//
// Uploads run in the BACKGROUND: the moment a photo/video is attached (picked
// or after editing) its upload starts via api.uploadMedia, up to a small
// concurrency cap, and each tray item tracks its own state (queued → uploading
// → ready | failed). "Post" then reuses the already-uploaded media ids — it
// only ever waits for uploads still in flight, and never re-uploads a `ready`
// item. Editing an item cancels its in-flight upload and re-uploads the result.

// Max concurrent in-flight uploads (batch/stream — don't serialize).
const UPLOAD_CONCURRENCY = 3;

// Hard cap on media items per post.
const MAX_MEDIA = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type UploadStatus =
  | { state: "queued" }
  | { state: "uploading"; progress: number } // 0..1
  | { state: "ready"; mediaId: string }
  | { state: "failed"; message: string };

interface MediaItem {
  key: string; // stable identity for React keys + upload tracking
  attempt: number; // bumped on edit/retry so stale upload results are ignored
  uri: string;
  kind: "image" | "video";
  mime: string;
  status: UploadStatus;
}

type Stage =
  | { name: "idle" }
  | { name: "finishing" } // Post pressed while uploads still in flight
  | { name: "signing" }
  | { name: "posting" } // PENDING: creation tx in flight
  | { name: "error"; message: string };

let itemSeq = 0;
const nextKey = () => `m${Date.now().toString(36)}-${itemSeq++}`;

const tokenOf = (m: { key: string; attempt: number }) => `${m.key}:${m.attempt}`;

export default function Create() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const toasts = useToasts();
  const { ensureWallet } = useWallet();
  const inputStyle = useInputStyle();

  const { width } = useWindowDimensions();
  // Full-width, IG-classic square-ish preview; capped for large (web) windows.
  const previewH = Math.min(width, 560);

  const [media, setMedia] = useState<MediaItem[]>([]);
  const [caption, setCaption] = useState("");
  const [mentionDrafts, setMentionDrafts] = useState<DraftMention[]>([]);
  const [attachment, setAttachment] = useState<MarketAttachment | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  // Index of the photo currently open in the full-screen editor (null = closed).
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Carousel page + hold-to-reorder drag state.
  const [page, setPage] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Latest media snapshot for async waiters (post() polls this).
  const mediaRef = useRef<MediaItem[]>(media);
  mediaRef.current = media;
  // AbortControllers keyed by upload token, so edits/removals can cancel.
  const controllers = useRef<Map<string, AbortController>>(new Map());
  // Tokens with an in-flight runUpload, to guard against double starts.
  const inFlight = useRef<Set<string>>(new Set());

  // --- hold-to-reorder drag (carousel pages) ------------------------------
  // Long-press lifts a page; horizontal drag past ~28% of the width swaps it
  // one slot and snap-follows, so each held drag step moves it one position.
  const carouselRef = useRef<ScrollView>(null);
  const dragX = useRef(new Animated.Value(0)).current;
  const dragIndexRef = useRef<number | null>(null);
  const dragAnchor = useRef(0); // dx re-anchor point after each swap
  const widthRef = useRef(width);
  widthRef.current = width;

  const endDrag = useCallback(() => {
    dragIndexRef.current = null;
    dragAnchor.current = 0;
    setDragIndex(null);
    Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
  }, [dragX]);

  const startDrag = (index: number) => {
    tap();
    dragIndexRef.current = index;
    dragAnchor.current = 0;
    dragX.setValue(0);
    setDragIndex(index);
  };

  const moveItem = (from: number, to: number) => {
    setMedia((cur) => {
      const next = [...cur];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  };

  // Container-level responder: once a page is lifted (long-press), it captures
  // all moves so the paging ScrollView can't scroll underneath the drag.
  const dragResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: () => dragIndexRef.current !== null,
      onPanResponderMove: (_evt, g) => {
        const i = dragIndexRef.current;
        if (i == null) return;
        const w = widthRef.current;
        const total = g.dx - dragAnchor.current;
        dragX.setValue(total);
        const count = mediaRef.current.length;
        if (total < -w * 0.28 && i > 0) {
          moveItem(i, i - 1);
          dragIndexRef.current = i - 1;
          setDragIndex(i - 1);
          dragAnchor.current = g.dx; // re-anchor: the page settles under the finger
          dragX.setValue(0);
          carouselRef.current?.scrollTo({ x: (i - 1) * w, animated: false });
          setPage(i - 1);
        } else if (total > w * 0.28 && i < count - 1) {
          moveItem(i, i + 1);
          dragIndexRef.current = i + 1;
          setDragIndex(i + 1);
          dragAnchor.current = g.dx;
          dragX.setValue(0);
          carouselRef.current?.scrollTo({ x: (i + 1) * w, animated: false });
          setPage(i + 1);
        }
      },
      onPanResponderRelease: () => endDrag(),
      onPanResponderTerminate: () => endDrag(),
    })
  ).current;

  const busy = stage.name === "finishing" || stage.name === "signing" || stage.name === "posting";

  // --- background upload engine ------------------------------------------

  const runUpload = useCallback(
    async (item: MediaItem) => {
      const token = tokenOf(item);
      if (inFlight.current.has(token)) return; // already running this attempt
      inFlight.current.add(token);
      const controller = new AbortController();
      controllers.current.set(token, controller);
      // Only apply a state update if this exact attempt is still the live one.
      const patch = (status: UploadStatus) =>
        setMedia((cur) =>
          cur.map((m) => (m.key === item.key && m.attempt === item.attempt ? { ...m, status } : m))
        );
      try {
        const up = await api.uploadMedia(item.uri, item.mime, {
          signal: controller.signal,
          onProgress: (f) =>
            setMedia((cur) =>
              cur.map((m) =>
                m.key === item.key && m.attempt === item.attempt && m.status.state === "uploading"
                  ? { ...m, status: { state: "uploading", progress: f } }
                  : m
              )
            ),
        });
        if (controller.signal.aborted) return; // superseded by an edit/removal
        patch({ state: "ready", mediaId: up.id });
      } catch (e) {
        if (controller.signal.aborted) return; // cancelled — item is gone/replaced
        patch({ state: "failed", message: errorMessage(e) });
      } finally {
        inFlight.current.delete(token);
        controllers.current.delete(token);
      }
    },
    [api]
  );

  // Scheduler: keep up to UPLOAD_CONCURRENCY uploads in flight. Transition the
  // next queued items to `uploading` and kick them off. Runs whenever media
  // changes (including when an upload completes and frees a slot). The
  // queued→uploading transition + inFlight guard make each start exactly-once.
  useEffect(() => {
    const active = media.filter((m) => m.status.state === "uploading").length;
    const slots = UPLOAD_CONCURRENCY - active;
    if (slots <= 0) return;
    const toStart = media.filter((m) => m.status.state === "queued").slice(0, slots);
    if (toStart.length === 0) return;
    const starting = new Set(toStart.map(tokenOf));
    setMedia((cur) =>
      cur.map((m) =>
        starting.has(tokenOf(m)) ? { ...m, status: { state: "uploading", progress: 0 } } : m
      )
    );
    for (const item of toStart) runUpload({ ...item, status: { state: "uploading", progress: 0 } });
  }, [media, runUpload]);

  // Cancel any in-flight uploads on unmount.
  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
    };
  }, []);

  const pick = async () => {
    const remaining = MAX_MEDIA - mediaRef.current.length;
    if (remaining <= 0) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.85,
      videoMaxDuration: 90,
    });
    if (res.canceled) return;
    setMedia((cur) => {
      const next = [
        ...cur,
        ...res.assets.map<MediaItem>((a) => ({
          key: nextKey(),
          attempt: 0,
          uri: a.uri,
          kind: a.type === "video" ? "video" : "image",
          mime: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
          status: { state: "queued" },
        })),
      ].slice(0, MAX_MEDIA);
      // Land the carousel on the first newly added page.
      const target = Math.min(cur.length, next.length - 1);
      requestAnimationFrame(() => {
        carouselRef.current?.scrollTo({ x: target * widthRef.current, animated: true });
        setPage(target);
      });
      return next;
    });
  };

  const attachmentInvalid =
    attachment?.kind === "new" && (attachment.spend < NEW_MARKET_MIN_SPEND || !attachment.candidate.question);
  const canPost = media.length > 0 && !busy && !attachmentInvalid;

  const reset = () => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    inFlight.current.clear();
    setMedia([]);
    setCaption("");
    setMentionDrafts([]);
    setAttachment(null);
    setStage({ name: "idle" });
    setEditingIndex(null);
  };

  const removeAt = (index: number) => {
    const item = media[index];
    if (item) controllers.current.get(tokenOf(item))?.abort();
    setMedia((cur) => cur.filter((_, j) => j !== index));
    setPage((p) => Math.max(0, Math.min(p, media.length - 1)));
  };

  const retry = (key: string) => {
    // Bump the attempt to mint a fresh token, then re-queue for the scheduler.
    setMedia((cur) =>
      cur.map((m) =>
        m.key === key && m.status.state === "failed"
          ? { ...m, attempt: m.attempt + 1, status: { state: "queued" } }
          : m
      )
    );
  };

  // Apply the editor's output in place (photos only). The edited file replaces
  // the original; its in-flight upload (if any) is cancelled and the manipulated
  // image is re-uploaded under a fresh attempt token.
  const applyEdit = (index: number, result: { uri: string }) => {
    const item = media[index];
    if (item) controllers.current.get(tokenOf(item))?.abort();
    setMedia((cur) =>
      cur.map((m, j) =>
        j === index
          ? {
              ...m,
              uri: result.uri,
              kind: "image",
              mime: "image/jpeg",
              attempt: m.attempt + 1,
              status: { state: "queued" },
            }
          : m
      )
    );
    setEditingIndex(null);
  };

  // Wait until every item has settled (ready or failed). The scheduler keeps
  // uploads flowing; we just poll the latest snapshot.
  const waitForUploads = useCallback(async (): Promise<MediaItem[]> => {
    for (;;) {
      const items = mediaRef.current;
      if (items.every((m) => m.status.state === "ready" || m.status.state === "failed")) return items;
      await sleep(120);
    }
  }, []);

  const post = async () => {
    try {
      // 1. Media is already uploading in the background. If anything is still in
      // flight, show "finishing uploads…" and await it; otherwise proceed at once.
      const settled = mediaRef.current.every(
        (m) => m.status.state === "ready" || m.status.state === "failed"
      );
      if (!settled) setStage({ name: "finishing" });
      const items = settled ? mediaRef.current : await waitForUploads();

      const failed = items.filter((m) => m.status.state === "failed");
      if (failed.length > 0) {
        throw new Error(
          failed.length === items.length
            ? "Media upload failed. Tap retry on the attachment, then post again."
            : `${failed.length} upload${failed.length > 1 ? "s" : ""} failed. Retry them, then post again.`
        );
      }
      const mediaIds = items.map((m) =>
        m.status.state === "ready" ? m.status.mediaId : ""
      );
      if (mediaIds.some((id) => !id)) throw new Error("Media isn't ready yet. Try again.");

      // Helper: sign one order (single-signature carriage — the order's
      // EIP-712 digest rides as the EIP-3009 auth nonce) and return the flat
      // backend wire payload (numeric max_cost/nonce, no maker field).
      const signOrderPayload = async (chainMarketId: number, affiliateId: number) => {
        const wallet = await ensureWallet();
        // Access tokens don't always carry a wallet claim — make sure the
        // backend has this wallet linked before it validates the order.
        await api.post("/v1/me/wallet", { address: wallet.address }).catch(() => {});
        // Next EIP-712 maker nonce (web parity: exposed on /v1/wallet).
        const { wallet: { order_nonce } } = await api.get<{ wallet: { order_nonce: number } }>("/v1/wallet");
        const price =
          attachment!.kind === "new"
            ? attachment!.priceCents
            : (attachment!.limitPriceCents ??
              (attachment!.side === "yes"
                ? attachment!.market.yes_price_cents
                : attachment!.market.no_price_cents) ??
              50);
        const shares = sharesForSpend(attachment!.spend, price);
        if (shares <= 0) throw new Error("bet amount too small");
        const maxCost = maxCostUnits(shares, price);
        const order = buildOrder(wallet.address, {
          chainMarketId,
          side: attachment!.side,
          priceCents: price,
          shares,
          maxCost,
          affiliatePostId: BigInt(affiliateId),
          nonce: order_nonce,
        });
        const auth = await signReceiveAuthorization(wallet, { value: maxCost, nonce: order.digest });
        return {
          side: attachment!.side,
          price_cents: price,
          shares,
          max_cost: Number(maxCost),
          expiry: order.message.expiry,
          nonce: order_nonce,
          auth,
        };
      };

      // 2. New-market attachments: sign the creator's opening order (marketId
      // 0 — the contract binds the real id at creation) and create the market
      // first; the post then references it by id.
      let marketId: string | null = null;
      if (attachment?.kind === "new") {
        setStage({ name: "signing" });
        const initialOrder = await signOrderPayload(0, 0);
        const created = await api.post<{ market: { id: string } }>("/v1/markets", {
          title: attachment.candidate.title ?? "",
          question: attachment.candidate.question,
          settlement_query: candidateSettlementQuery(attachment.candidate),
          initial_order: initialOrder,
        });
        marketId = created.market.id;
      } else if (attachment?.kind === "existing") {
        marketId = attachment.market.id;
      }

      // 3. Publish the post. Mentions are sent as char offsets into the FINAL
      // caption (spec §7d.2), recomputed here so edits can't desync them.
      setStage({ name: "posting" });
      const finalCaption = caption.trim();
      const mentions = computeMentions(finalCaption, mentionDrafts);
      const kind = mediaRef.current[0]?.kind === "video" ? "video" : "photo";
      const res = await api.post<{ post: Post }>("/v1/posts", {
        caption: finalCaption || null,
        kind,
        media_ids: mediaIds,
        market_id: marketId,
        mentions,
      });

      // 4. Existing-market bets are placed AFTER the post lands so the order
      // can carry the new post as its affiliate attribution.
      if (attachment?.kind === "existing") {
        setStage({ name: "signing" });
        const orderPayload = await signOrderPayload(
          attachment.market.chain_market_id,
          res.post.affiliate_id ?? 0
        );
        setStage({ name: "posting" });
        await api.post("/v1/orders", {
          market_id: attachment.market.id,
          ...orderPayload,
          affiliate_post_id: res.post.id,
          affiliate_id: res.post.affiliate_id != null ? String(res.post.affiliate_id) : null,
        });
      }

      success();
      if (attachment?.kind === "new") {
        // Creator microcopy for OPEN (spec §5) — MATCHED arrives later via WS.
        toasts.show({
          title: "Posted — market is OPEN",
          body: "You're committed. Waiting for someone to take your bet.",
          icon: "flash",
        });
      } else {
        toasts.show({ title: "Posted", icon: "checkmark-circle" });
      }
      qc.invalidateQueries({ queryKey: ["feed"] });
      reset();
      router.replace("/(tabs)");
    } catch (e) {
      warn();
      setStage({ name: "error", message: errorMessage(e) });
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
        {/* ── Full-width preview carousel: one media item per page, hold-drag a
            page to reorder, and a trailing "+" page to add more (max 10). ── */}
        <View {...dragResponder.panHandlers}>
          <ScrollView
            ref={carouselRef}
            horizontal
            pagingEnabled
            scrollEnabled={dragIndex === null}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
          >
            {media.map((m, i) => (
              <Animated.View
                key={m.key}
                style={{
                  width,
                  height: previewH,
                  backgroundColor: "#000",
                  zIndex: dragIndex === i ? 2 : 0,
                  transform: [
                    { translateX: dragIndex === i ? dragX : 0 },
                    { scale: dragIndex === i ? 0.94 : 1 },
                  ],
                }}
              >
                {/* Tap opens the editor (photos); hold lifts the page to reorder. */}
                <Pressable
                  style={{ flex: 1 }}
                  onPress={m.kind === "image" ? () => setEditingIndex(i) : undefined}
                  onLongPress={() => startDrag(i)}
                  delayLongPress={220}
                >
                  <Image
                    source={{ uri: m.uri }}
                    style={{ width: "100%", height: "100%", opacity: dragIndex === i ? 0.85 : 1 }}
                    contentFit="cover"
                  />
                </Pressable>

                {/* Upload state overlay (progress ring / ready check / retry). */}
                <UploadOverlay status={m.status} onRetry={() => retry(m.key)} />

                {m.kind === "video" ? (
                  <Ionicons name="play-circle" size={30} color="#fff" style={{ position: "absolute", bottom: 12, left: 12 }} />
                ) : (
                  <Pressable
                    onPress={() => setEditingIndex(i)}
                    style={{ position: "absolute", bottom: 12, left: 12, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 6 }}
                    hitSlop={6}
                  >
                    <Ionicons name="crop" size={14} color="#fff" />
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Edit</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => removeAt(i)}
                  style={{ position: "absolute", top: 12, right: 12, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 13 }}
                  hitSlop={8}
                >
                  <Ionicons name="close" size={24} color="#fff" />
                </Pressable>
              </Animated.View>
            ))}

            {/* Trailing "+" page (hidden at the 10-item cap). */}
            {media.length < MAX_MEDIA ? (
              <Pressable onPress={pick} style={{ width, height: previewH, padding: space.lg }}>
                <View
                  style={{
                    flex: 1,
                    borderRadius: radius.lg,
                    borderWidth: 1.5,
                    borderStyle: "dashed",
                    borderColor: t.borderStrong,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                  }}
                >
                  <Ionicons name="add" size={44} color={t.textDim} />
                  <Text style={{ color: t.textDim, fontSize: 14, fontWeight: "600", textAlign: "center" }}>
                    {media.length === 0 ? "Add photos or videos" : "Add more"}
                  </Text>
                  <Text style={{ color: t.textFaint, fontSize: 12 }}>
                    {media.length}/{MAX_MEDIA}
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </ScrollView>

          {/* Paging dots ("+" page included while it exists). */}
          {media.length > 0 ? (
            <View style={{ position: "absolute", bottom: 8, alignSelf: "center", flexDirection: "row", gap: 5 }}>
              {[...Array(media.length + (media.length < MAX_MEDIA ? 1 : 0))].map((_, i) => (
                <View
                  key={i}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: i === page ? t.blue : "rgba(255,255,255,0.6)",
                  }}
                />
              ))}
            </View>
          ) : null}
        </View>

        {media.length > 1 ? (
          <Text style={{ color: t.textFaint, fontSize: 12, textAlign: "center", paddingTop: 8 }}>
            Hold a photo, then drag to reorder
          </Text>
        ) : null}

        <View style={{ padding: space.lg, gap: space.lg }}>
        <Field label="Caption">
          <MentionInput
            value={caption}
            onChangeText={setCaption}
            drafts={mentionDrafts}
            onDraftsChange={setMentionDrafts}
            inputStyle={[inputStyle, { minHeight: 80, textAlignVertical: "top" }]}
            placeholder="Write a caption… @mention people"
            placeholderTextColor={t.textFaint}
            multiline
          />
        </Field>

        <Field label="Market" hint={attachment ? undefined : "Attach a prediction market to let people bet on your post."}>
          <AttachMarket value={attachment} onChange={setAttachment} />
        </Field>

        {/* Progress / error */}
        {stage.name === "finishing" ? (
          <ProgressRow label="Finishing uploads…" />
        ) : stage.name === "signing" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <StateChip state="SIGNING" />
            <Text style={{ color: t.textDim, fontSize: 13 }}>Confirm the order in your wallet…</Text>
          </View>
        ) : stage.name === "posting" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <StateChip state="PENDING" />
            <Text style={{ color: t.textDim, fontSize: 13 }}>
              {attachment ? "Publishing post + market…" : "Publishing…"}
            </Text>
          </View>
        ) : stage.name === "error" ? (
          <Text style={{ color: t.danger, fontSize: 13.5 }}>{stage.message}</Text>
        ) : null}

        <Button
          title={attachment ? "Post with market" : "Post"}
          onPress={post}
          disabled={!canPost}
          loading={busy}
        />
        </View>
      </ScrollView>

      <PhotoEditor
        visible={editingIndex !== null}
        uri={editingIndex !== null ? media[editingIndex]?.uri ?? null : null}
        onCancel={() => setEditingIndex(null)}
        onDone={(result) => {
          if (editingIndex !== null) applyEdit(editingIndex, result);
        }}
      />
    </KeyboardAvoidingView>
  );
}

// Per-tray-item upload indicator: a subtle progress ring while uploading, a
// check badge when ready, and a tappable retry affordance on failure.
function UploadOverlay({ status, onRetry }: { status: UploadStatus; onRetry: () => void }) {
  const t = useTheme();
  if (status.state === "ready") {
    return (
      <View style={{ position: "absolute", bottom: 6, right: 6, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 11 }}>
        <Ionicons name="checkmark-circle" size={22} color={t.blue} />
      </View>
    );
  }
  if (status.state === "failed") {
    return (
      <Pressable
        onPress={onRetry}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: radius.md,
          backgroundColor: "rgba(0,0,0,0.5)",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
        }}
      >
        <Ionicons name="refresh" size={26} color="#fff" />
        <Text style={{ color: "#fff", fontSize: 11.5, fontWeight: "700" }}>Retry</Text>
      </Pressable>
    );
  }
  // queued or uploading → progress ring over a dimming scrim.
  const progress = status.state === "uploading" ? status.progress : 0;
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: radius.md,
        backgroundColor: "rgba(0,0,0,0.28)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ProgressRing progress={progress} />
    </View>
  );
}

// Determinate circular progress ring (SVG). An indeterminate spinner shows
// until the first byte-progress tick arrives.
function ProgressRing({ progress }: { progress: number }) {
  const size = 38;
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  if (progress <= 0) return <LogoSpinner size={30} color="#fff" />;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.3)" strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#fff"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - clamped)}
        />
      </Svg>
      <Text style={{ position: "absolute", color: "#fff", fontSize: 10, fontWeight: "800" }}>
        {Math.round(clamped * 100)}
      </Text>
    </View>
  );
}

function ProgressRow({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Ionicons name="cloud-upload-outline" size={18} color={t.blue} />
      <Text style={{ color: t.textDim, fontSize: 13 }}>{label}</Text>
    </View>
  );
}
