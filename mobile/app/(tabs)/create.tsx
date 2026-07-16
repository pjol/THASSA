import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { AttachMarket, MarketAttachment, NEW_MARKET_MIN_SPEND } from "../../components/AttachMarket";
import { StateChip } from "../../components/StateChip";
import { useToasts } from "../../components/Toasts";
import { Button, Field, useInputStyle } from "../../components/ui";
import { errorMessage, useApi } from "../../lib/api";
import { useWallet } from "../../lib/auth";
import { success, warn } from "../../lib/haptics";
import {
  candidateSettlementQuery,
  type Post,
} from "../../lib/types";
import { buildOrder, maxCostUnits, sharesForSpend, signReceiveAuthorization } from "../../lib/signing";
import { radius, space, useTheme } from "../../lib/theme";

// Create flow (spec §7): multi media picker → caption → attach market
// (search / generate) → Post signs the EIP-712 order + EIP-3009 funding auth
// via the Privy embedded wallet and submits everything atomically, with a
// clear PENDING → OPEN progression (MATCHED arrives later by push/WS toast).

interface PickedMedia {
  uri: string;
  kind: "image" | "video";
  mime: string;
}

type Stage =
  | { name: "idle" }
  | { name: "uploading"; done: number; total: number }
  | { name: "signing" }
  | { name: "posting" } // PENDING: creation tx in flight
  | { name: "error"; message: string };

export default function Create() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const toasts = useToasts();
  const { ensureWallet } = useWallet();
  const inputStyle = useInputStyle();

  const [media, setMedia] = useState<PickedMedia[]>([]);
  const [caption, setCaption] = useState("");
  const [attachment, setAttachment] = useState<MarketAttachment | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "idle" });

  const busy = stage.name === "uploading" || stage.name === "signing" || stage.name === "posting";

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.85,
      videoMaxDuration: 90,
    });
    if (res.canceled) return;
    setMedia((cur) =>
      [
        ...cur,
        ...res.assets.map<PickedMedia>((a) => ({
          uri: a.uri,
          kind: a.type === "video" ? "video" : "image",
          mime: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
        })),
      ].slice(0, 10)
    );
  };

  const attachmentInvalid =
    attachment?.kind === "new" && (attachment.spend < NEW_MARKET_MIN_SPEND || !attachment.candidate.question);
  const canPost = media.length > 0 && !busy && !attachmentInvalid;

  const reset = () => {
    setMedia([]);
    setCaption("");
    setAttachment(null);
    setStage({ name: "idle" });
  };

  const post = async () => {
    try {
      // 1. Upload media.
      setStage({ name: "uploading", done: 0, total: media.length });
      const mediaIds: string[] = [];
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        const up = await api.uploadMedia(m.uri, m.mime);
        mediaIds.push(up.id);
        setStage({ name: "uploading", done: i + 1, total: media.length });
      }

      // 2. Sign the market order, if attached.
      let marketPayload: Record<string, unknown> | null = null;
      if (attachment) {
        setStage({ name: "signing" });
        const wallet = await ensureWallet();
        // Next EIP-712 maker nonce (web parity: exposed on /v1/wallet).
        const { order_nonce } = await api.get<{ order_nonce: number }>("/v1/wallet");
        const price =
          attachment.kind === "new"
            ? attachment.priceCents
            : (attachment.limitPriceCents ??
              (attachment.side === "yes"
                ? attachment.market.yes_price_cents
                : attachment.market.no_price_cents) ??
              50);
        const shares = sharesForSpend(attachment.spend, price);
        if (shares <= 0) throw new Error("bet amount too small");
        const maxCost = maxCostUnits(shares, price);
        // New-market opening orders use marketId = 0; the relayer/contract
        // bind the real id at creation. Single-signature carriage: the order's
        // EIP-712 digest is the EIP-3009 auth nonce — the user signs only the
        // funding authorization.
        const chainMarketId = attachment.kind === "existing" ? attachment.market.chain_market_id : 0;
        const order = buildOrder(wallet.address, {
          chainMarketId,
          side: attachment.side,
          priceCents: price,
          shares,
          maxCost,
          nonce: order_nonce,
        });
        const auth = await signReceiveAuthorization(wallet, { value: maxCost, nonce: order.digest });
        const orderPayload = {
          side: attachment.side,
          price_cents: price,
          shares,
          max_cost: order.message.maxCost,
          expiry: order.message.expiry,
          nonce: order.message.nonce,
          maker: wallet.address,
          auth,
        };
        marketPayload =
          attachment.kind === "existing"
            ? { market_id: attachment.market.id, order: orderPayload }
            : {
                new_market: {
                  question: attachment.candidate.question,
                  settlement_query: candidateSettlementQuery(attachment.candidate),
                },
                order: orderPayload,
              };
      }

      // 3. Publish atomically (post + market + opening order).
      setStage({ name: "posting" });
      await api.post<{ post: Post }>("/v1/posts", {
        caption: caption.trim() || null,
        media_ids: mediaIds,
        market: marketPayload,
      });

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
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 80, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {/* Media picker */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
          {media.map((m, i) => (
            <View key={`${m.uri}-${i}`}>
              <Image source={{ uri: m.uri }} style={{ width: 110, height: 140, borderRadius: radius.md, backgroundColor: t.surfaceAlt }} contentFit="cover" />
              {m.kind === "video" ? (
                <Ionicons name="play-circle" size={22} color="#fff" style={{ position: "absolute", bottom: 6, left: 6 }} />
              ) : null}
              <Pressable
                onPress={() => setMedia((cur) => cur.filter((_, j) => j !== i))}
                style={{ position: "absolute", top: 4, right: 4, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 11 }}
                hitSlop={8}
              >
                <Ionicons name="close" size={20} color="#fff" />
              </Pressable>
            </View>
          ))}
          <Pressable
            onPress={pick}
            style={{
              width: 110,
              height: 140,
              borderRadius: radius.md,
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: t.borderStrong,
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Ionicons name="images-outline" size={26} color={t.textDim} />
            <Text style={{ color: t.textDim, fontSize: 12, fontWeight: "600" }}>
              {media.length === 0 ? "Add photos\nor videos" : "Add more"}
            </Text>
          </Pressable>
        </ScrollView>

        <Field label="Caption">
          <TextInput
            style={[inputStyle, { minHeight: 80, textAlignVertical: "top" }]}
            placeholder="Write a caption…"
            placeholderTextColor={t.textFaint}
            multiline
            value={caption}
            onChangeText={setCaption}
          />
        </Field>

        <Field label="Market" hint={attachment ? undefined : "Attach a prediction market to let people bet on your post."}>
          <AttachMarket value={attachment} onChange={setAttachment} />
        </Field>

        {/* Progress / error */}
        {stage.name === "uploading" ? (
          <ProgressRow label={`Uploading media ${stage.done}/${stage.total}…`} />
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
      </ScrollView>
    </KeyboardAvoidingView>
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
