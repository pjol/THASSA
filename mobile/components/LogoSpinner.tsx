import { useEffect, useRef } from "react";
import { Animated, Easing, View, type StyleProp, type ViewStyle } from "react-native";
import { Logo } from "./Logo";
import { BRAND_BLUE } from "../lib/theme";

// The Thassa mark spinning — used as the loading indicator wherever a large,
// centered spinner fits (screen/section loaders). The ensō is circular, so
// rotating the logo itself reads naturally as a spinner. Inline spinners inside
// colored buttons keep ActivityIndicator (contrast) — see components/ui.tsx.
export function LogoSpinner({
  size = 44,
  color = BRAND_BLUE,
  style,
}: {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 950,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View style={style}>
      <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
        <Logo size={size} color={color} />
      </Animated.View>
    </View>
  );
}
