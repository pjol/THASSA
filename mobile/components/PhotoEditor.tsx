import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  LayoutChangeEvent,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  FlipType,
  SaveFormat,
  manipulateAsync,
} from "expo-image-manipulator";
import { radius, useTheme } from "../lib/theme";
import { tap } from "../lib/haptics";
import { LogoSpinner } from "./LogoSpinner";

// Fully custom, whitelabeled full-screen photo editor (no OS pickers/sheets).
// Crop with aspect presets + pan/pinch behind a fixed frame, plus 90° rotate
// and horizontal flip. The actual pixel ops run through expo-image-manipulator
// (crop / rotate / flip / resize); the gestures are pure built-in PanResponder
// + Animated (no gesture-handler / reanimated deps).

const MAX_ZOOM = 5;
// Cap the longest edge of the exported image so uploads stay reasonable.
const MAX_OUTPUT = 2048;

type AspectKey = "Original" | "1:1" | "4:5" | "4:3" | "16:9";
// ratio = width / height; `null` means "match the current image".
const ASPECTS: { key: AspectKey; ratio: number | null }[] = [
  { key: "Original", ratio: null },
  { key: "1:1", ratio: 1 },
  { key: "4:5", ratio: 4 / 5 },
  { key: "4:3", ratio: 4 / 3 },
  { key: "16:9", ratio: 16 / 9 },
];

interface Work {
  uri: string;
  w: number;
  h: number;
}

function dist(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }) {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function PhotoEditor({
  visible,
  uri,
  onCancel,
  onDone,
}: {
  visible: boolean;
  uri: string | null;
  onCancel: () => void;
  onDone: (result: { uri: string; width: number; height: number }) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const [work, setWork] = useState<Work | null>(null);
  const [aspect, setAspect] = useState<AspectKey>("Original");
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);

  // Animated transform of the image behind the crop frame.
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const scale = useRef(new Animated.Value(1)).current;
  // Plain-number mirrors so the PanResponder + crop math can read/commit values
  // synchronously (Animated.Value has no public getter).
  const curPan = useRef({ x: 0, y: 0 });
  const curScale = useRef(1);
  const panSaved = useRef({ x: 0, y: 0 });
  const scaleSaved = useRef(1);
  const pinch = useRef({ startDist: 0, startScale: 1, active: false });
  // Latest geometry, read inside the gesture responder.
  const geom = useRef({ frameW: 0, frameH: 0, baseScale: 1 });

  const resetTransform = () => {
    pan.setValue({ x: 0, y: 0 });
    scale.setValue(1);
    curPan.current = { x: 0, y: 0 };
    curScale.current = 1;
    panSaved.current = { x: 0, y: 0 };
    scaleSaved.current = 1;
    pinch.current = { startDist: 0, startScale: 1, active: false };
  };

  // (Re)load the source whenever the editor opens on a new image. A no-op
  // manipulate normalizes the uri and yields reliable pixel dimensions.
  useEffect(() => {
    let cancelled = false;
    if (!visible || !uri) {
      setWork(null);
      return;
    }
    setAspect("Original");
    resetTransform();
    (async () => {
      try {
        const r = await manipulateAsync(uri, [], {});
        if (!cancelled) setWork({ uri: r.uri, w: r.width, h: r.height });
      } catch {
        if (!cancelled) setWork({ uri, w: 1, h: 1 });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, uri]);

  // Frame + base cover-scale for the current aspect and layout.
  const layout = useMemo(() => {
    if (!work || area.w === 0 || area.h === 0) {
      return { frameW: 0, frameH: 0, baseScale: 1, dispW: 0, dispH: 0 };
    }
    const ar = aspect === "Original" || ASPECTS.find((a) => a.key === aspect)?.ratio == null
      ? work.w / work.h
      : (ASPECTS.find((a) => a.key === aspect)!.ratio as number);
    // Fit the frame inside the available area.
    let frameW = area.w;
    let frameH = frameW / ar;
    if (frameH > area.h) {
      frameH = area.h;
      frameW = frameH * ar;
    }
    // Cover: the image must fully fill the frame at zoom 1.
    const baseScale = Math.max(frameW / work.w, frameH / work.h);
    return {
      frameW,
      frameH,
      baseScale,
      dispW: work.w * baseScale,
      dispH: work.h * baseScale,
    };
  }, [work, area, aspect]);

  // Publish geometry for the responder each render.
  geom.current = { frameW: layout.frameW, frameH: layout.frameH, baseScale: layout.baseScale };

  // Clamp a pan offset so the (scaled) image always covers the frame.
  const clampPan = (x: number, y: number, s: number) => {
    const { frameW, frameH, baseScale } = geom.current;
    const dispW = (work?.w ?? 0) * baseScale * s;
    const dispH = (work?.h ?? 0) * baseScale * s;
    const maxX = Math.max(0, (dispW - frameW) / 2);
    const maxY = Math.max(0, (dispH - frameH) / 2);
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        panSaved.current = { ...curPan.current };
        scaleSaved.current = curScale.current;
        pinch.current = { startDist: 0, startScale: curScale.current, active: false };
      },
      onPanResponderMove: (evt, gesture) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length >= 2) {
          // Pinch-to-zoom around the frame center.
          const d = dist(touches[0], touches[1]);
          if (!pinch.current.active) {
            pinch.current = { startDist: d, startScale: curScale.current, active: true };
          }
          const next = clamp(
            (pinch.current.startScale * d) / (pinch.current.startDist || d),
            1,
            MAX_ZOOM
          );
          curScale.current = next;
          scale.setValue(next);
          // Re-clamp pan to the new scale so no gap opens at the frame edges.
          const c = clampPan(curPan.current.x, curPan.current.y, next);
          curPan.current = c;
          pan.setValue(c);
        } else if (!pinch.current.active) {
          // Single-finger pan (ignored once a pinch has begun this gesture).
          const c = clampPan(
            panSaved.current.x + gesture.dx,
            panSaved.current.y + gesture.dy,
            curScale.current
          );
          curPan.current = c;
          pan.setValue(c);
        }
      },
      onPanResponderRelease: () => {
        panSaved.current = { ...curPan.current };
        scaleSaved.current = curScale.current;
        pinch.current = { startDist: 0, startScale: curScale.current, active: false };
      },
    })
  ).current;

  const onArea = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setArea({ w: width, h: height });
  };

  const changeAspect = (key: AspectKey) => {
    tap();
    setAspect(key);
    resetTransform();
  };

  // Rotate/flip are applied immediately to the working image (via
  // ImageManipulator) so the live crop always operates on the displayed pixels.
  const applyOp = async (action: { rotate: number } | { flip: FlipType }) => {
    if (!work || busy) return;
    tap();
    setBusy(true);
    try {
      const r = await manipulateAsync(work.uri, [action], {
        compress: 1,
        format: SaveFormat.PNG,
      });
      setWork({ uri: r.uri, w: r.width, h: r.height });
      resetTransform();
    } catch {
      // keep current work on failure
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    if (!work || busy) return;
    tap();
    setBusy(true);
    try {
      const { frameW, frameH, baseScale } = geom.current;
      const s = baseScale * curScale.current; // screen px per image px
      // Map the fixed frame back into image-pixel space.
      let cropW = frameW / s;
      let cropH = frameH / s;
      let originX = work.w / 2 - (frameW / 2 + curPan.current.x) / s;
      let originY = work.h / 2 - (frameH / 2 + curPan.current.y) / s;
      // Clamp to the image bounds and round to whole pixels.
      cropW = Math.min(cropW, work.w);
      cropH = Math.min(cropH, work.h);
      originX = clamp(originX, 0, work.w - cropW);
      originY = clamp(originY, 0, work.h - cropH);
      const crop = {
        originX: Math.round(originX),
        originY: Math.round(originY),
        width: Math.round(cropW),
        height: Math.round(cropH),
      };
      const actions: Parameters<typeof manipulateAsync>[1] = [{ crop }];
      // Optionally downscale very large crops.
      const longest = Math.max(crop.width, crop.height);
      if (longest > MAX_OUTPUT) {
        const factor = MAX_OUTPUT / longest;
        actions.push({
          resize: { width: Math.round(crop.width * factor), height: Math.round(crop.height * factor) },
        });
      }
      const r = await manipulateAsync(work.uri, actions, {
        compress: 0.9,
        format: SaveFormat.JPEG,
      });
      onDone({ uri: r.uri, width: r.width, height: r.height });
    } catch {
      // On failure, fall back to the working image unchanged.
      onDone({ uri: work.uri, width: work.w, height: work.h });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onCancel}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        {/* Top bar: Cancel / title / Done */}
        <View style={styles.topBar}>
          <Pressable onPress={onCancel} hitSlop={10} style={styles.topBtn}>
            <Text style={styles.topBtnText}>Cancel</Text>
          </Pressable>
          <Text style={styles.topTitle}>Edit photo</Text>
          <Pressable onPress={done} hitSlop={10} disabled={busy || !work} style={styles.topBtn}>
            <Text style={[styles.topBtnText, { color: t.blue, opacity: busy || !work ? 0.5 : 1 }]}>Done</Text>
          </Pressable>
        </View>

        {/* Crop stage */}
        <View style={styles.stage} onLayout={onArea}>
          {work && layout.frameW > 0 ? (
            <View
              style={{
                width: layout.frameW,
                height: layout.frameH,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#000",
              }}
              {...responder.panHandlers}
            >
              <Animated.View
                style={{
                  width: layout.dispW,
                  height: layout.dispH,
                  transform: [
                    { translateX: pan.x },
                    { translateY: pan.y },
                    { scale },
                  ],
                }}
              >
                <Image
                  source={{ uri: work.uri }}
                  style={{ width: layout.dispW, height: layout.dispH }}
                  contentFit="cover"
                />
              </Animated.View>

              {/* Rule-of-thirds grid + frame border (non-interactive). */}
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                <View style={[styles.gridLine, { left: "33.33%", top: 0, bottom: 0, width: 1 }]} />
                <View style={[styles.gridLine, { left: "66.66%", top: 0, bottom: 0, width: 1 }]} />
                <View style={[styles.gridLine, { top: "33.33%", left: 0, right: 0, height: 1 }]} />
                <View style={[styles.gridLine, { top: "66.66%", left: 0, right: 0, height: 1 }]} />
                <View style={styles.frameBorder} />
              </View>
            </View>
          ) : (
            <LogoSpinner size={30} color="#fff" />
          )}

          {busy ? (
            <View style={styles.busy} pointerEvents="none">
              <LogoSpinner size={30} color="#fff" />
            </View>
          ) : null}
        </View>

        <Text style={styles.hint}>Drag to reposition · pinch to zoom</Text>

        {/* Rotate / flip row */}
        <View style={styles.opsRow}>
          <OpButton icon="refresh-outline" label="Left" onPress={() => applyOp({ rotate: -90 })} mirror />
          <OpButton icon="refresh-outline" label="Right" onPress={() => applyOp({ rotate: 90 })} />
          <OpButton icon="swap-horizontal-outline" label="Flip" onPress={() => applyOp({ flip: FlipType.Horizontal })} />
        </View>

        {/* Aspect-ratio chips */}
        <View style={[styles.chipsRow, { paddingBottom: insets.bottom + 12 }]}>
          {ASPECTS.map((a) => {
            const active = a.key === aspect;
            return (
              <Pressable
                key={a.key}
                onPress={() => changeAspect(a.key)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? t.blue : "rgba(255,255,255,0.10)",
                    borderColor: active ? t.blue : "rgba(255,255,255,0.20)",
                  },
                ]}
              >
                <Text style={[styles.chipText, { color: active ? "#fff" : "rgba(255,255,255,0.85)" }]}>
                  {a.key}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

function OpButton({
  icon,
  label,
  onPress,
  mirror,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  mirror?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={styles.opBtn} hitSlop={8}>
      <Ionicons
        name={icon}
        size={24}
        color="#fff"
        style={mirror ? { transform: [{ scaleX: -1 }] } : undefined}
      />
      <Text style={styles.opLabel}>{label}</Text>
    </Pressable>
  );
}

// The editor deliberately uses a dark, app-neutral stage (like every photo
// editor) with Thassa-blue accents on the interactive controls.
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    height: 52,
  },
  topBtn: { minWidth: 64 },
  topBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  topTitle: { color: "#fff", fontSize: 16, fontWeight: "800" },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  frameBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.9)",
  },
  gridLine: { position: "absolute", backgroundColor: "rgba(255,255,255,0.35)" },
  busy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  hint: { color: "rgba(255,255,255,0.6)", fontSize: 12.5, textAlign: "center", paddingVertical: 10 },
  opsRow: { flexDirection: "row", justifyContent: "center", gap: 28, paddingBottom: 6 },
  opBtn: { alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  opLabel: { color: "#fff", fontSize: 12, fontWeight: "600" },
  chipsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingTop: 12,
    paddingHorizontal: 12,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: "700" },
});
