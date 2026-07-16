import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#307CDE",
          soft: "#5D9AE8",
          deep: "#1F5FB8",
        },
        yes: "#12B76A",
        no: "#F04438",
        settling: "#F59E0B",
        // Theme surfaces via CSS variables (light/dark inversion)
        bg: "rgb(var(--bg) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        card: "rgb(var(--card) / <alpha-value>)",
        edge: "rgb(var(--edge) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      maxWidth: {
        page: "1180px",
      },
      boxShadow: {
        card: "0 24px 60px -30px rgb(var(--shadow) / 0.35)",
        pop: "0 40px 90px -40px rgb(var(--shadow) / 0.5)",
      },
    },
  },
  plugins: [],
};

export default config;
