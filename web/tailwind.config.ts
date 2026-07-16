import type { Config } from "tailwindcss";

// Thassa design system (spec §7): Instagram-inspired density, brand blue
// constant across themes, and a light/dark pair that INVERTS black↔white.
// All neutrals flow through CSS variables (globals.css) so dark mode is a
// single `.dark` class flip; YES/NO/SETTLING are fixed signal colors.
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./providers/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#307CDE", // Thassa blue — identical in light and dark
          soft: "rgb(48 124 222 / 0.12)",
        },
        yes: "#12B76A",
        no: "#F04438",
        settling: "#F59E0B",
        // Inverting neutrals (light ↔ dark via CSS vars):
        bg: "rgb(var(--bg) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        card: "rgb(var(--card) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        edge: "rgb(var(--edge) / <alpha-value>)",
        // "accent" is the highlight neutral: black in light mode, white in dark.
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-fg": "rgb(var(--accent-fg) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      borderRadius: { "2xl": "1rem", "3xl": "1.5rem" },
      boxShadow: {
        soft: "0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(0 0 0 / 0.12)",
        sheet: "0 -8px 40px -12px rgb(0 0 0 / 0.25)",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "sheet-up": {
          "0%": { transform: "translateY(100%)" },
          "100%": { transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.4s infinite",
        "fade-up": "fade-up .18s ease-out",
        "sheet-up": "sheet-up .22s cubic-bezier(.32,.72,0,1)",
      },
    },
  },
  plugins: [],
};
export default config;
