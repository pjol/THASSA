import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, space, useTheme } from "../lib/theme";
import { Button } from "./ui";

// Thassa-branded confirmation dialog — replaces every native Alert.alert
// confirm in the app (whitelabel rule: no OS-default UI). Centered card with a
// spring/fade entrance, dimmed backdrop (tap = cancel), themed buttons; the
// confirm button turns danger-red when `destructive`.

export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button in the danger variant. */
  destructive?: boolean;
  /** Shows a spinner on the confirm button and locks dismissal. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  // Keep the Modal mounted while the exit animation plays.
  const [mounted, setMounted] = useState(visible);
  const backdrop = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdrop.setValue(0);
      scale.setValue(0.92);
      Animated.parallel([
        Animated.timing(backdrop, {
          toValue: 1,
          duration: 160,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.spring(scale, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdrop, {
          toValue: 0,
          duration: 130,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scale, { toValue: 0.94, duration: 130, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;

  const dismiss = () => {
    if (!loading) onCancel();
  };

  return (
    <Modal visible transparent statusBarTranslucent onRequestClose={dismiss}>
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: space.xl,
          paddingTop: insets.top + space.xl,
          paddingBottom: insets.bottom + space.xl,
        }}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityLabel="Dismiss dialog">
          <Animated.View
            style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", opacity: backdrop }}
          />
        </Pressable>
        <Animated.View
          style={{
            width: "100%",
            maxWidth: 340,
            backgroundColor: t.surface,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: t.border,
            padding: space.xl,
            gap: space.sm,
            opacity: backdrop,
            transform: [{ scale }],
            shadowColor: t.shadowColor,
            shadowOpacity: 0.25,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: 10 },
            elevation: 12,
          }}
        >
          <Text style={{ color: t.text, fontWeight: "800", fontSize: 18, textAlign: "center" }}>
            {title}
          </Text>
          {message ? (
            <Text style={{ color: t.textDim, fontSize: 14.5, lineHeight: 20, textAlign: "center" }}>
              {message}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 10, marginTop: space.md }}>
            <Button
              title={cancelLabel}
              variant="subtle"
              onPress={dismiss}
              disabled={loading}
              style={{ flex: 1 }}
            />
            <Button
              title={confirmLabel}
              variant={destructive ? "danger" : "primary"}
              onPress={onConfirm}
              loading={loading}
              style={{ flex: 1 }}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
