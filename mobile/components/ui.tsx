import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { radius, space, useTheme } from "../lib/theme";
import { tap } from "../lib/haptics";
import { LogoSpinner } from "./LogoSpinner";

export { radius, space };

type ButtonVariant = "primary" | "accent" | "subtle" | "outline" | "danger" | "yes" | "no";

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  small,
  style,
  textStyle,
  haptic = true,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  haptic?: boolean;
}) {
  const t = useTheme();
  const bg =
    variant === "primary"
      ? t.blue
      : variant === "accent"
        ? t.accent
        : variant === "subtle"
          ? t.grayTint
          : variant === "danger"
            ? t.danger
            : variant === "yes"
              ? t.yes
              : variant === "no"
                ? t.no
                : "transparent";
  const fg =
    variant === "subtle"
      ? t.text
      : variant === "outline"
        ? t.text
        : variant === "accent"
          ? t.onAccent
          : "#FFFFFF";
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={() => {
        if (haptic) tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderRadius: radius.full,
          paddingVertical: small ? 8 : 13,
          paddingHorizontal: small ? 14 : 20,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
          borderWidth: variant === "outline" ? 1.5 : 0,
          borderColor: t.borderStrong,
        },
        style,
      ]}
    >
      {loading ? <LogoSpinner size={16} color={fg} /> : null}
      <Text style={[{ color: fg, fontWeight: "700", fontSize: small ? 13 : 16 }, textStyle]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Avatar({
  url,
  size = 40,
  ring,
  seen,
}: {
  url?: string | null;
  size?: number;
  // Story ring: brand-blue gradient-ish ring; dims once seen.
  ring?: boolean;
  seen?: boolean;
}) {
  const t = useTheme();
  const inner = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: t.surfaceAlt,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: size, height: size }} contentFit="cover" transition={120} />
      ) : (
        <Text style={{ color: t.textFaint, fontSize: size * 0.42, fontWeight: "700" }}>?</Text>
      )}
    </View>
  );
  if (!ring) return inner;
  return (
    <View
      style={{
        padding: 2.5,
        borderRadius: (size + 11) / 2,
        borderWidth: 2.5,
        borderColor: seen ? t.border : t.blue,
      }}
    >
      {inner}
    </View>
  );
}

// Shimmering skeleton block for loading states.
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[{ backgroundColor: t.skeleton, borderRadius: radius.md, opacity }, style]}
    />
  );
}

// Bottom sheet built on Modal — slides up, dims behind, swallows taps outside.
export function Sheet({
  visible,
  onClose,
  children,
  title,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const t = useTheme();
  // Custom animation (animationType="none"): the dark backdrop FADES in via
  // opacity while the content slides up — rather than sliding the whole modal
  // (backdrop included) up from the bottom, which looked off.
  const [mounted, setMounted] = useState(visible);
  const [sheetH, setSheetH] = useState(420);
  const backdrop = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(1)).current; // 1 = below screen, 0 = in place

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(backdrop, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.spring(slide, { toValue: 0, friction: 11, tension: 80, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdrop, { toValue: 0, duration: 170, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(slide, { toValue: 1, duration: 190, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]).start(({ finished }) => finished && setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [0, sheetH] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }} />
          </Pressable>
        </Animated.View>
        <Animated.View
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height + 40)}
          style={{
            transform: [{ translateY }],
            backgroundColor: t.bg,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingBottom: 34,
            paddingTop: 10,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 42,
              height: 5,
              borderRadius: 3,
              backgroundColor: t.borderStrong,
              marginBottom: 8,
            }}
          />
          {title ? (
            <Text
              style={{
                color: t.text,
                fontWeight: "800",
                fontSize: 17,
                textAlign: "center",
                marginBottom: 6,
              }}
            >
              {title}
            </Text>
          ) : null}
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// IG-style segmented top tabs (Explore: Posts | Markets, profile tabs, ...).
export function Segmented({
  options,
  value,
  onChange,
  icons,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  icons?: React.ReactNode[];
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: t.border }}>
      {options.map((o, i) => {
        const active = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => {
              tap();
              onChange(o);
            }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 12,
              borderBottomWidth: 2,
              borderBottomColor: active ? t.accent : "transparent",
              flexDirection: "row",
              justifyContent: "center",
              gap: 6,
            }}
          >
            {icons?.[i]}
            <Text
              style={{
                color: active ? t.text : t.textDim,
                fontWeight: active ? "800" : "600",
                fontSize: 14,
              }}
            >
              {o}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Simple labeled text input row used across forms.
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 6, marginBottom: space.lg }}>
      <Text style={{ color: t.textDim, fontWeight: "700", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </Text>
      {children}
      {hint ? <Text style={{ color: t.textFaint, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export function useInputStyle(): StyleProp<TextStyle> {
  const t = useTheme();
  return {
    backgroundColor: t.surfaceAlt,
    color: t.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  };
}

// Double-tap wrapper (feed like gesture) with a heart burst overlay.
export function DoubleTap({
  onDoubleTap,
  onSingleTap,
  children,
}: {
  onDoubleTap: () => void;
  onSingleTap?: () => void;
  children: React.ReactNode;
}) {
  const lastTap = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [burst, setBurst] = useState(false);
  const scale = useRef(new Animated.Value(0)).current;

  const fire = () => {
    setBurst(true);
    scale.setValue(0);
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 4 }).start(() => {
      Animated.timing(scale, { toValue: 0, duration: 220, delay: 180, useNativeDriver: true }).start(() =>
        setBurst(false)
      );
    });
    onDoubleTap();
  };

  return (
    <Pressable
      onPress={() => {
        const now = Date.now();
        if (now - lastTap.current < 280) {
          if (timer.current) clearTimeout(timer.current);
          lastTap.current = 0;
          fire();
        } else {
          lastTap.current = now;
          if (onSingleTap) {
            timer.current = setTimeout(() => onSingleTap(), 290);
          }
        }
      }}
    >
      {children}
      {burst ? (
        <Animated.View
          style={{
            position: "absolute",
            alignSelf: "center",
            top: "38%",
            transform: [{ scale }],
            shadowColor: "#000",
            shadowOpacity: 0.35,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 2 },
          }}
        >
          <Ionicons name="heart" size={88} color="#FFFFFF" />
        </Animated.View>
      ) : null}
    </Pressable>
  );
}
