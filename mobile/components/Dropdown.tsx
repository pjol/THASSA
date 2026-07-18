import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tap } from "../lib/haptics";
import { radius, space, useTheme } from "../lib/theme";

// Whitelabeled select (no native pickers, whitelabel rule): an input-styled
// trigger showing the current value + chevron; pressing it measures the
// trigger on screen and opens an anchored overlay list that:
//   - scrolls internally, capped at ~40% of the screen height so long lists
//     stay compact;
//   - opens downward when there's room, upward otherwise, and clamps within
//     the safe area so options can never end up off-screen;
//   - dismisses on backdrop tap, checks the selected option, supports
//     disabled options.

export interface DropdownOption<T extends string | number = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

const ROW_H = 46;
const LIST_VPAD = 6;
const GAP = 6; // between trigger and list
const EDGE = 8; // min clearance from safe-area edges

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function Dropdown<T extends string | number>({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled = false,
  style,
}: {
  options: DropdownOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const triggerRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anim = useRef(new Animated.Value(0)).current;

  const selected = options.find((o) => o.value === value) ?? null;

  const open = () => {
    if (disabled) return;
    tap();
    // Measure where the trigger sits on screen so the list can anchor to it.
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  };
  const close = () => setAnchor(null);

  useEffect(() => {
    if (anchor) {
      anim.setValue(0);
      Animated.timing(anim, {
        toValue: 1,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }
  }, [anchor, anim]);

  // ---- placement ---------------------------------------------------------
  let overlay: React.ReactNode = null;
  if (anchor) {
    const contentH = options.length * ROW_H + LIST_VPAD * 2;
    // Internal-scroll cap: ~40% of the screen keeps long lists compact.
    const maxH = Math.min(win.height * 0.4, contentH);

    const spaceBelow = win.height - insets.bottom - EDGE - (anchor.y + anchor.height + GAP);
    const spaceAbove = anchor.y - GAP - (insets.top + EDGE);

    // Open downward when the capped list fits (or there's simply more room
    // below); otherwise upward. Then clamp the height to whatever room the
    // chosen direction actually has, so nothing renders off-screen.
    const openDown = spaceBelow >= maxH || spaceBelow >= spaceAbove;
    const listH = Math.max(ROW_H + LIST_VPAD * 2, Math.min(maxH, openDown ? spaceBelow : spaceAbove));
    const top = openDown ? anchor.y + anchor.height + GAP : anchor.y - GAP - listH;

    // Horizontal clamp within the safe area.
    const width = Math.min(anchor.width, win.width - EDGE * 2);
    const left = Math.min(Math.max(anchor.x, EDGE), win.width - EDGE - width);

    const selectedIdx = options.findIndex((o) => o.value === value);

    overlay = (
      <Modal visible transparent statusBarTranslucent onRequestClose={close}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close options" />
        <Animated.View
          style={{
            position: "absolute",
            top,
            left,
            width,
            height: listH,
            backgroundColor: t.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: t.border,
            overflow: "hidden",
            opacity: anim,
            transform: [
              {
                translateY: anim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [openDown ? -6 : 6, 0],
                }),
              },
            ],
            shadowColor: t.shadowColor,
            shadowOpacity: 0.18,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: 10,
          }}
        >
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={{ paddingVertical: LIST_VPAD }}
            showsVerticalScrollIndicator
            onContentSizeChange={() => {
              // Bring the selected option into view on open.
              if (selectedIdx > 0 && contentH > listH) {
                scrollRef.current?.scrollTo({
                  y: Math.max(0, selectedIdx * ROW_H - listH / 2 + ROW_H / 2),
                  animated: false,
                });
              }
            }}
          >
            {options.map((o) => {
              const isSelected = o.value === value;
              return (
                <Pressable
                  key={String(o.value)}
                  disabled={o.disabled}
                  onPress={() => {
                    tap();
                    close();
                    if (!isSelected) onChange(o.value);
                  }}
                  style={({ pressed }) => ({
                    height: ROW_H,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 14,
                    backgroundColor: isSelected ? t.blueTint : pressed ? t.grayTint : "transparent",
                    opacity: o.disabled ? 0.4 : 1,
                  })}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: isSelected, disabled: !!o.disabled }}
                >
                  <Text
                    style={{
                      flex: 1,
                      color: isSelected ? t.blue : t.text,
                      fontWeight: isSelected ? "700" : "500",
                      fontSize: 15,
                    }}
                    numberOfLines={1}
                  >
                    {o.label}
                  </Text>
                  {isSelected ? <Ionicons name="checkmark" size={18} color={t.blue} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </Modal>
    );
  }

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={open}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={selected ? `${selected.label}. Change selection` : placeholder}
        style={({ pressed }) => [
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: t.surfaceAlt,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: anchor ? t.blue : t.border,
            paddingHorizontal: 14,
            paddingVertical: 12,
            opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          },
          style,
        ]}
      >
        <Text
          style={{ flex: 1, color: selected ? t.text : t.textFaint, fontSize: 16 }}
          numberOfLines={1}
        >
          {selected ? selected.label : placeholder}
        </Text>
        <Ionicons name={anchor ? "chevron-up" : "chevron-down"} size={17} color={t.textDim} />
      </Pressable>
      {overlay}
    </>
  );
}
