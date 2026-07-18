import React, { useCallback, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  CameraView,
  useCameraPermissions,
  type CameraCapturedPicture,
  type CameraType,
  type FlashMode,
} from "expo-camera";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "../lib/api";
import { BRAND_BLUE, radius, space } from "../lib/theme";
import { success, tap, thud } from "../lib/haptics";
import { LogoSpinner } from "../components/LogoSpinner";

// Full-screen, in-app, live camera for creating a story (Instagram-story style).
// Stories are camera-only: this replaces the old gallery-pick flow. Flow is
//   live preview  ->  capture  ->  review (retake / send)  ->  upload  ->  dismiss.
// Upload reuses the existing media-id contract:
//   api.uploadMedia(uri, "image/jpeg")  ->  api.post("/v1/stories", { media_id }).
// Video capture is intentionally omitted (photo-only) to keep the surface tight
// and avoid the microphone permission; the review/upload flow is identical for
// a future video addition.

const CTRL_BG = "rgba(0,0,0,0.42)";
const FLASH_ORDER: FlashMode[] = ["off", "auto", "on"];

export default function StoryCameraScreen() {
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [captured, setCaptured] = useState<CameraCapturedPicture | null>(null);
  const [busy, setBusy] = useState(false); // true during capture or upload
  const [sending, setSending] = useState(false);

  const close = useCallback(() => {
    tap();
    router.back();
  }, [router]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    thud();
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85, skipProcessing: false });
      if (photo) setCaptured(photo);
    } catch {
      /* swallow: staying on the live preview lets the user simply retry */
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const retake = useCallback(() => {
    tap();
    setCaptured(null);
  }, []);

  const send = useCallback(async () => {
    if (!captured || sending) return;
    setSending(true);
    try {
      const up = await api.uploadMedia(captured.uri, "image/jpeg");
      await api.post("/v1/stories", { media_id: up.id });
      qc.invalidateQueries({ queryKey: ["stories"] });
      success();
      router.back();
    } catch {
      // Keep the review screen up so the user can retry the send.
      setSending(false);
    }
  }, [captured, sending, api, qc, router]);

  const flipFacing = useCallback(() => {
    tap();
    setFacing((f) => (f === "back" ? "front" : "back"));
  }, []);

  const cycleFlash = useCallback(() => {
    tap();
    setFlash((f) => FLASH_ORDER[(FLASH_ORDER.indexOf(f) + 1) % FLASH_ORDER.length]);
  }, []);

  // --- Permission gates -----------------------------------------------------
  if (!permission) {
    // Permission state still resolving.
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <LogoSpinner size={34} color="#fff" />
      </View>
    );
  }

  if (!permission.granted) {
    const denied = !permission.canAskAgain;
    return (
      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <StatusBar style="light" />
        <Pressable
          onPress={close}
          hitSlop={12}
          style={[styles.closeAbsolute, { top: insets.top + 8 }]}
        >
          <View style={styles.ctrlCircle}>
            <Ionicons name="close" size={24} color="#fff" />
          </View>
        </Pressable>

        <View style={styles.permCard}>
          <View style={styles.permIcon}>
            <Ionicons name="camera" size={34} color="#fff" />
          </View>
          <Text style={styles.permTitle}>Camera access</Text>
          <Text style={styles.permBody}>
            {denied
              ? "Thassa needs your camera to capture a story. Turn it on in Settings to continue."
              : "Allow Thassa to use your camera so you can capture a photo for your story."}
          </Text>
          <Pressable
            onPress={() => {
              tap();
              if (denied) Linking.openSettings();
              else requestPermission();
            }}
            style={({ pressed }) => [styles.permBtn, { opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={styles.permBtnText}>{denied ? "Open Settings" : "Allow camera"}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // --- Review captured photo ------------------------------------------------
  if (captured) {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <Image source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />

        {/* Close (discard & exit) */}
        <Pressable
          onPress={close}
          disabled={sending}
          hitSlop={12}
          style={[styles.closeAbsolute, { top: insets.top + 8 }]}
        >
          <View style={styles.ctrlCircle}>
            <Ionicons name="close" size={24} color="#fff" />
          </View>
        </Pressable>

        {/* Review actions */}
        <View style={[styles.reviewBar, { paddingBottom: insets.bottom + 22 }]}>
          <Pressable
            onPress={retake}
            disabled={sending}
            style={({ pressed }) => [styles.retakeBtn, { opacity: pressed ? 0.85 : 1 }]}
          >
            <Ionicons name="camera-reverse-outline" size={20} color="#fff" />
            <Text style={styles.retakeText}>Retake</Text>
          </Pressable>

          <Pressable
            onPress={send}
            disabled={sending}
            style={({ pressed }) => [styles.sendBtn, { opacity: sending ? 0.9 : pressed ? 0.9 : 1 }]}
          >
            {sending ? (
              <LogoSpinner size={18} color="#fff" />
            ) : (
              <>
                <Text style={styles.sendText}>Add to your story</Text>
                <Ionicons name="arrow-forward" size={20} color="#fff" />
              </>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  // --- Live camera ----------------------------------------------------------
  const flashIcon: keyof typeof Ionicons.glyphMap =
    flash === "off" ? "flash-off" : flash === "auto" ? "flash-outline" : "flash";

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
      />

      {/* Top controls */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={close} hitSlop={12}>
          <View style={styles.ctrlCircle}>
            <Ionicons name="close" size={24} color="#fff" />
          </View>
        </Pressable>

        <View style={styles.topRight}>
          <Pressable onPress={cycleFlash} hitSlop={12}>
            <View style={styles.ctrlCircle}>
              <Ionicons name={flashIcon} size={22} color="#fff" />
            </View>
            {flash !== "off" ? (
              <Text style={styles.flashTag}>{flash === "auto" ? "A" : "ON"}</Text>
            ) : null}
          </Pressable>
        </View>
      </View>

      {/* Bottom capture row */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 26 }]}>
        <View style={styles.bottomSide} />

        <Pressable onPress={takePhoto} disabled={busy} hitSlop={12}>
          {/* Brand-blue ring around a white shutter disc */}
          <View style={styles.shutterRing}>
            <View style={styles.shutterInner}>
              {busy ? <LogoSpinner size={26} color={BRAND_BLUE} /> : null}
            </View>
          </View>
        </Pressable>

        <View style={styles.bottomSide}>
          <Pressable onPress={flipFacing} hitSlop={12}>
            <View style={styles.ctrlCircle}>
              <Ionicons name="camera-reverse" size={24} color="#fff" />
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  closeAbsolute: { position: "absolute", left: 16, zIndex: 10 },
  ctrlCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: CTRL_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  // Top bar
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  flashTag: {
    position: "absolute",
    bottom: -3,
    right: -3,
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
    backgroundColor: BRAND_BLUE,
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: "hidden",
  },
  // Bottom capture
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bottomSide: { width: 60, alignItems: "center", justifyContent: "center" },
  shutterRing: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 5,
    borderColor: BRAND_BLUE,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  // Review
  reviewBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  retakeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: CTRL_BG,
  },
  retakeText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  sendBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: radius.full,
    backgroundColor: BRAND_BLUE,
  },
  sendText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  // Permission card
  permCard: { alignItems: "center", gap: 12, maxWidth: 340 },
  permIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: BRAND_BLUE,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  permTitle: { color: "#fff", fontWeight: "800", fontSize: 20, textAlign: "center" },
  permBody: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 8,
  },
  permBtn: {
    backgroundColor: BRAND_BLUE,
    borderRadius: radius.full,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  permBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
});
