import React, { forwardRef, useEffect, useRef } from "react";
import {
  Animated,
  FlatList,
  FlatListProps,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  View,
} from "react-native";
import { Logo } from "./Logo";
import { LogoSpinner } from "./LogoSpinner";
import { useTheme } from "../lib/theme";

// Custom, fully whitelabeled pull-to-refresh: our own scroll-driven header
// with the Thassa mark instead of the OS spinner. Works identically on iOS,
// Android, and web (mouse/touch drag):
//   • With the list scrolled to the top, dragging down is captured by a
//     PanResponder; the list translates down (with resistance) and the ensō
//     fades in, scaling up and ROTATING with the pull distance.
//   • Past the trigger threshold, release starts the refresh: the list holds
//     open and the mark spins (LogoSpinner) until `refreshing` flips false,
//     then everything springs shut.
// Drop-in for FlatList + RefreshControl: same props, plus refreshing /
// onRefresh / topOffset (extra space below floating chrome).

// Animated.FlatList loses the FlatList generic in its types; recover it so
// item types flow through renderItem at call sites.
const AnimatedFlatList = Animated.FlatList as unknown as typeof FlatList;

const PULL_MAX = 130; // hard cap on pull distance
const TRIGGER = 70; // release past this → refresh
const HOLD = 58; // held-open height while refreshing

type Props<T> = Omit<FlatListProps<T>, "refreshControl"> & {
  refreshing: boolean;
  onRefresh: () => void;
  topOffset?: number;
};

function LogoRefreshListInner<T>(
  { refreshing, onRefresh, topOffset = 0, onScroll, style, ...listProps }: Props<T>,
  ref: React.Ref<FlatList<T>>
) {
  const t = useTheme();
  const pull = useRef(new Animated.Value(0)).current;
  const pullVal = useRef(0);
  const atTop = useRef(true);
  const holding = useRef(false);

  useEffect(() => {
    const id = pull.addListener(({ value }) => {
      pullVal.current = value;
    });
    return () => pull.removeListener(id);
  }, [pull]);

  // Track the refreshing prop: close when it completes; if a refresh starts
  // without a pull (programmatic refetch), show the held-open header anyway.
  const prevRefreshing = useRef(refreshing);
  useEffect(() => {
    if (prevRefreshing.current && !refreshing) {
      holding.current = false;
      Animated.spring(pull, { toValue: 0, friction: 8, useNativeDriver: true }).start();
    } else if (!prevRefreshing.current && refreshing && !holding.current) {
      holding.current = true;
      Animated.spring(pull, { toValue: HOLD, friction: 8, useNativeDriver: true }).start();
    }
    prevRefreshing.current = refreshing;
  }, [refreshing, pull]);

  const responder = useRef(
    PanResponder.create({
      // Claim the gesture only for a clearly-vertical downward drag while the
      // list is at the top and no refresh is holding it open.
      onMoveShouldSetPanResponderCapture: (_evt, g) =>
        !holding.current && atTop.current && g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_evt, g) => {
        pull.setValue(Math.max(0, Math.min(PULL_MAX, g.dy * 0.55))); // resistance
      },
      onPanResponderRelease: () => {
        if (pullVal.current >= TRIGGER) {
          holding.current = true;
          Animated.spring(pull, { toValue: HOLD, friction: 8, useNativeDriver: true }).start();
          onRefresh();
        } else {
          Animated.timing(pull, { toValue: 0, duration: 160, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        if (!holding.current) {
          Animated.timing(pull, { toValue: 0, duration: 160, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  const rotate = pull.interpolate({ inputRange: [0, PULL_MAX], outputRange: ["0deg", "300deg"] });
  const opacity = pull.interpolate({
    inputRange: [0, 20, HOLD],
    outputRange: [0, 0.2, 1],
    extrapolate: "clamp",
  });
  const scale = pull.interpolate({ inputRange: [0, HOLD], outputRange: [0.55, 1], extrapolate: "clamp" });

  return (
    <View style={{ flex: 1 }} {...responder.panHandlers}>
      {/* The mark, behind the list, revealed as the content translates down. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: topOffset + 10,
          left: 0,
          right: 0,
          alignItems: "center",
          opacity,
          transform: [{ scale }],
          zIndex: 5,
        }}
      >
        {refreshing ? (
          <LogoSpinner size={32} />
        ) : (
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Logo size={32} color={t.blue} />
          </Animated.View>
        )}
      </Animated.View>

      <AnimatedFlatList
        ref={ref}
        {...(listProps as FlatListProps<T>)}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          atTop.current = e.nativeEvent.contentOffset.y <= 1;
          onScroll?.(e);
        }}
        scrollEventThrottle={16}
        style={[style, { transform: [{ translateY: pull }] }]}
      />
    </View>
  );
}

// forwardRef with generics: cast keeps the item-type inference at call sites.
export const LogoRefreshList = forwardRef(LogoRefreshListInner) as <T>(
  props: Props<T> & { ref?: React.Ref<FlatList<T>> }
) => React.ReactElement;
