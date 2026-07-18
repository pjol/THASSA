"use client";

// Create post flow (spec §7): media upload (presign→PUT with progress),
// caption, attach/generate market, then Post — signs the EIP-712 order
// (+EIP-3009 funding auth) with the Privy wallet and submits post+market
// atomically, showing the PENDING → OPEN progression per the vocabulary.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useApi, errorMessage, newIdempotencyKey } from "@/lib/api";
import { useTrading } from "@/lib/trading";
import { useToast } from "@/providers/ToastProvider";
import { useWarp } from "@/providers/WarpProvider";
import { AttachMarket, type MarketAttachment } from "@/components/AttachMarket";
import { MentionTextarea } from "@/components/MentionTextarea";
import { StateChip, creatorMicrocopy } from "@/components/StateChip";
import { VideoPlayer } from "@/components/VideoPlayer";
import { CloseIcon, ImageIcon, Spinner } from "@/components/icons";
import { escrowUnits, unitsToDollars } from "@/lib/signing";
import type {
  Market,
  MarketStatus,
  MediaItem,
  MentionInput,
  Post,
} from "@/lib/types";

interface Upload {
  key: string;
  file: File;
  previewUrl: string;
  progress: number;
  media: MediaItem | null;
  failed: boolean;
}

export default function CreatePage() {
  const api = useApi();
  const trading = useTrading();
  const toast = useToast();
  const router = useRouter();
  const { active: warped } = useWarp();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [caption, setCaption] = useState("");
  // @-mentions recorded in the caption, re-derived on every edit so offsets
  // stay correct (spec §7d.2); sent alongside the caption on submit.
  const [mentions, setMentions] = useState<MentionInput[]>([]);
  const [attachment, setAttachment] = useState<MarketAttachment | null>(null);
  const [posting, setPosting] = useState(false);
  // Stable key per logical publish: retrying after an error can't double-post.
  const idemKeyRef = useRef(newIdempotencyKey());
  // post-submit progression
  const [progress, setProgress] = useState<{
    label: string;
    state: MarketStatus | "SIGNING" | null;
  } | null>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 10 - uploads.length)) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      const previewUrl = URL.createObjectURL(file);
      setUploads((u) => [
        ...u,
        { key, file, previewUrl, progress: 0, media: null, failed: false },
      ]);
      api
        .uploadMedia(file, (pct) =>
          setUploads((u) =>
            u.map((x) => (x.key === key ? { ...x, progress: pct } : x)),
          ),
        )
        .then((media) =>
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, media } : x))),
        )
        .catch(() => {
          setUploads((u) =>
            u.map((x) => (x.key === key ? { ...x, failed: true } : x)),
          );
          toast.error("Upload failed", `${file.name} couldn't be uploaded.`);
        });
    }
  };

  const removeUpload = (key: string) =>
    setUploads((u) => u.filter((x) => x.key !== key));

  const uploadsPending = uploads.some((u) => !u.media && !u.failed);
  const mediaIds = uploads.filter((u) => u.media).map((u) => u.media!.id);

  const attachmentValid =
    !attachment ||
    (attachment.shares > 0n &&
      (attachment.kind !== "new" ||
        // $1 minimum opening capital for new markets (spec §4.2)
        unitsToDollars(escrowUnits(attachment.shares, attachment.priceCents)) >= 1));

  const canPost =
    !posting &&
    !uploadsPending &&
    !warped && // read-only while warped (spec §7c.2)
    attachmentValid &&
    (mediaIds.length > 0 || caption.trim().length > 0);

  const submit = async () => {
    if (!canPost) return;
    setPosting(true);
    try {
      let marketAttach: any = null;
      let marketCreate: any = null;

      if (attachment) {
        setProgress({ label: "Confirm in your wallet", state: "SIGNING" });
        if (attachment.kind === "existing") {
          marketAttach = await trading.signAttachOrder({
            market: attachment.market,
            side: attachment.side,
            priceCents: attachment.priceCents,
            shares: attachment.shares,
          });
        } else {
          marketCreate = {
            ...(await trading.signCreateMarket({
              candidate: attachment.candidate,
              side: attachment.side,
              priceCents: attachment.priceCents,
              shares: attachment.shares,
            })),
          };
        }
      }

      setProgress({ label: "Publishing your post", state: "PENDING" });
      // Mention offsets index the raw caption; the wire caption is trimmed, so
      // shift by the leading-whitespace amount and drop any now out of bounds.
      const finalCaption = caption.trim();
      const leadTrim = caption.length - caption.trimStart().length;
      const finalMentions = mentions
        .map((m) => ({ ...m, start: m.start - leadTrim }))
        .filter((m) => m.start >= 0 && m.start + m.len <= finalCaption.length);
      const res = await api.post<{ post: Post }>(
        "/v1/posts",
        {
          caption: finalCaption || null,
          mentions: finalMentions,
          media_ids: mediaIds,
          market_attach: marketAttach,
          market_create: marketCreate,
        },
        { idempotencyKey: idemKeyRef.current },
      );

      // PENDING → OPEN progression for new markets.
      const market = res.post.market;
      if (market && marketCreate) {
        let status: MarketStatus = market.status;
        const startedAt = Date.now();
        while (status === "PENDING" && Date.now() - startedAt < 20_000) {
          setProgress({ label: "Placing your market onchain", state: "PENDING" });
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const m = await api.get<{ market: Market }>(`/v1/markets/${market.id}`);
            status = m.market.status;
          } catch {
            break;
          }
        }
        setProgress({ label: creatorMicrocopy(status) ?? "Posted", state: status });
        await new Promise((r) => setTimeout(r, 1400));
      }

      queryClient.invalidateQueries({ queryKey: ["feed"] });
      toast.success(
        "Posted",
        attachment?.kind === "new"
          ? "You're committed. Waiting for someone to take your bet."
          : undefined,
      );
      router.push("/");
    } catch (err) {
      setProgress(null);
      toast.error("Couldn't post", errorMessage(err));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[560px] px-4 pb-10 pt-4 md:pt-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-tight text-fg">New post</h1>
        <button
          onClick={submit}
          disabled={!canPost}
          title={warped ? "read-only (warp)" : undefined}
          className="btn-brand !px-6"
        >
          {posting ? <Spinner size={16} /> : warped ? "Read-only (warp)" : "Post"}
        </button>
      </div>

      {/* media picker */}
      <div className="card p-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          aria-hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {uploads.length === 0 ? (
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-edge py-12 text-muted transition hover:border-brand hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <ImageIcon size={36} />
            <span className="text-sm font-semibold">Add photos or videos</span>
            <span className="text-xs">Up to 10 · videos become HLS reels-ready</span>
          </button>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {uploads.map((u) => (
              <div key={u.key} className="relative aspect-square overflow-hidden rounded-xl bg-surface">
                {u.file.type.startsWith("video") ? (
                  u.media?.hls_url || u.media?.url ? (
                    <VideoPlayer
                      src={u.media.hls_url || u.media.url}
                      active={false}
                      className="h-full w-full"
                      ariaLabel="Uploaded video preview"
                    />
                  ) : (
                    <video src={u.previewUrl} muted className="h-full w-full object-cover" />
                  )
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={u.previewUrl} alt="Upload preview" className="h-full w-full object-cover" />
                )}
                {!u.media && !u.failed && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/45 text-white">
                    <span className="font-mono text-xs font-bold">{u.progress}%</span>
                    <span className="mt-1.5 h-1 w-3/5 overflow-hidden rounded-full bg-white/30">
                      <span className="block h-full bg-white transition-all" style={{ width: `${u.progress}%` }} />
                    </span>
                  </div>
                )}
                {u.failed && (
                  <div className="absolute inset-0 flex items-center justify-center bg-no/60 text-xs font-bold text-white">
                    Failed
                  </div>
                )}
                <button
                  onClick={() => removeUpload(u.key)}
                  aria-label="Remove media"
                  className="absolute right-1.5 top-1.5 rounded-full bg-black/55 p-1 text-white hover:bg-black/75"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
            {uploads.length < 10 && (
              <button
                onClick={() => fileRef.current?.click()}
                aria-label="Add more media"
                className="flex aspect-square items-center justify-center rounded-xl border-2 border-dashed border-edge text-muted transition hover:border-brand hover:text-brand"
              >
                <ImageIcon size={22} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* caption */}
      <div className="card mt-4 p-4">
        <label htmlFor="caption" className="mb-1.5 block text-sm font-bold text-fg">
          Caption
        </label>
        <MentionTextarea
          id="caption"
          className="input resize-none"
          rows={3}
          maxLength={2200}
          placeholder="Write a caption… use @ to mention people"
          value={caption}
          onChange={(text, m) => {
            setCaption(text);
            setMentions(m);
          }}
        />
      </div>

      {/* attach market */}
      <div className="mt-4">
        <AttachMarket value={attachment} onChange={setAttachment} />
      </div>

      {/* progression overlay */}
      {progress && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="alert"
          aria-live="assertive"
        >
          <div className="card mx-6 flex w-full max-w-xs flex-col items-center gap-3 p-8 text-center shadow-soft">
            {progress.state === "SIGNING" || progress.state === "PENDING" ? (
              <Spinner size={24} className="text-brand" />
            ) : null}
            {progress.state && progress.state !== "SIGNING" && (
              <StateChip state={progress.state} />
            )}
            {progress.state === "SIGNING" && <StateChip state="SIGNING" />}
            <p className="text-sm font-semibold text-fg">{progress.label}</p>
          </div>
        </div>
      )}
    </div>
  );
}
