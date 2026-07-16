import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Thassa design system (spec §7). Instagram-inspired, Thassa-branded.
// Brand blue is constant across themes; dark mode inverts black <-> white.
export const BRAND_BLUE = "#307CDE";
export const YES_GREEN = "#12B76A";
export const NO_RED = "#F04438";
export const SETTLING_AMBER = "#F59E0B";

export interface Theme {
  mode: "light" | "dark";
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  // Black in light mode, white in dark mode — the "ink" accent.
  accent: string;
  onAccent: string;
  blue: string;
  blueTint: string;
  onBlue: string;
  yes: string;
  yesTint: string;
  no: string;
  noTint: string;
  amber: string;
  amberTint: string;
  danger: string;
  mutedRed: string;
  gray: string;
  grayTint: string;
  skeleton: string;
  shadowColor: string;
}

function alpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function buildTheme(mode: "light" | "dark"): Theme {
  if (mode === "dark") {
    return {
      mode,
      bg: "#0A0A0A",
      surface: "#141414",
      surfaceAlt: "#1E1E1E",
      border: "rgba(255,255,255,0.12)",
      borderStrong: "rgba(255,255,255,0.22)",
      text: "#FFFFFF",
      textDim: "rgba(255,255,255,0.60)",
      textFaint: "rgba(255,255,255,0.38)",
      accent: "#FFFFFF",
      onAccent: "#0A0A0A",
      blue: BRAND_BLUE,
      blueTint: alpha(BRAND_BLUE, 0.22),
      onBlue: "#FFFFFF",
      yes: YES_GREEN,
      yesTint: alpha(YES_GREEN, 0.18),
      no: NO_RED,
      noTint: alpha(NO_RED, 0.18),
      amber: SETTLING_AMBER,
      amberTint: alpha(SETTLING_AMBER, 0.18),
      danger: "#F26161",
      mutedRed: alpha(NO_RED, 0.65),
      gray: "rgba(255,255,255,0.45)",
      grayTint: "rgba(255,255,255,0.10)",
      skeleton: "rgba(255,255,255,0.08)",
      shadowColor: "#000000",
    };
  }
  return {
    mode,
    bg: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceAlt: "#F5F6F8",
    border: "rgba(10,10,10,0.10)",
    borderStrong: "rgba(10,10,10,0.18)",
    text: "#0A0A0A",
    textDim: "rgba(10,10,10,0.55)",
    textFaint: "rgba(10,10,10,0.36)",
    accent: "#0A0A0A",
    onAccent: "#FFFFFF",
    blue: BRAND_BLUE,
    blueTint: alpha(BRAND_BLUE, 0.10),
    onBlue: "#FFFFFF",
    yes: YES_GREEN,
    yesTint: alpha(YES_GREEN, 0.12),
    no: NO_RED,
    noTint: alpha(NO_RED, 0.12),
    amber: SETTLING_AMBER,
    amberTint: alpha(SETTLING_AMBER, 0.14),
    danger: "#DC2626",
    mutedRed: alpha(NO_RED, 0.7),
    gray: "rgba(10,10,10,0.45)",
    grayTint: "rgba(10,10,10,0.07)",
    skeleton: "rgba(10,10,10,0.06)",
    shadowColor: "#0A0A0A",
  };
}

export type ThemePref = "system" | "light" | "dark";
const PREF_KEY = "thassa.themePref.v1";

interface ThemeCtxValue {
  theme: Theme;
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

const ThemeCtx = createContext<ThemeCtxValue>({
  theme: buildTheme("light"),
  pref: "system",
  setPref: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    AsyncStorage.getItem(PREF_KEY)
      .then((v) => {
        if (v === "light" || v === "dark" || v === "system") setPrefState(v);
      })
      .catch(() => {});
  }, []);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    AsyncStorage.setItem(PREF_KEY, p).catch(() => {});
  };

  const mode: "light" | "dark" =
    pref === "system" ? (scheme === "dark" ? "dark" : "light") : pref;

  const value = useMemo(() => ({ theme: buildTheme(mode), pref, setPref }), [mode, pref]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeCtx).theme;
}

export function useThemePref() {
  const { pref, setPref, theme } = useContext(ThemeCtx);
  return { pref, setPref, mode: theme.mode };
}

// Builds memoized styles from the current theme.
export function useThemedStyles<T>(factory: (t: Theme) => T): T {
  const t = useTheme();
  return useMemo(() => factory(t), [t]);
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, full: 999 } as const;
