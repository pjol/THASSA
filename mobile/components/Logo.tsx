import { Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { THASSA_LOGO_XML } from "../lib/logoXml";
import { BRAND_BLUE, useTheme } from "../lib/theme";

// Tint the monochrome Thassa mark to any color (defaults to the header text
// color, like ASSEMBLY's header logo treatment).
function tint(color: string) {
  return THASSA_LOGO_XML.replace(/__C__/g, color);
}

export function Logo({ size = 28, color }: { size?: number; color?: string }) {
  const t = useTheme();
  return <SvgXml xml={tint(color ?? t.text)} width={size} height={size} />;
}

export function LogoWordmark({ size = 28, color }: { size?: number; color?: string }) {
  const t = useTheme();
  const c = color ?? t.text;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Logo size={size} color={c} />
      <Text style={{ color: c, fontWeight: "800", fontSize: size * 0.82, letterSpacing: -0.5 }}>
        Thassa
      </Text>
    </View>
  );
}

export { BRAND_BLUE };
