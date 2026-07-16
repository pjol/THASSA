"use client";

// Class-based dark mode with a three-way preference (light / dark / system,
// default system). Dark mode inverts black↔white per spec §7; brand blue is
// untouched. The current class is applied to <html> so Tailwind `dark:`
// variants and the CSS variables in globals.css both flip together.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type ThemePref = "light" | "dark" | "system";

interface ThemeCtx {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx>({
  pref: "system",
  resolved: "light",
  setPref: () => {},
});

const KEY = "thassa.theme";

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  const apply = useCallback((p: ThemePref) => {
    const dark = p === "dark" || (p === "system" && systemDark());
    document.documentElement.classList.toggle("dark", dark);
    setResolved(dark ? "dark" : "light");
  }, []);

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as ThemePref) || "system";
    setPrefState(stored);
    apply(stored);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = (localStorage.getItem(KEY) as ThemePref) || "system";
      if (current === "system") apply("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [apply]);

  const setPref = useCallback(
    (p: ThemePref) => {
      localStorage.setItem(KEY, p);
      setPrefState(p);
      apply(p);
    },
    [apply],
  );

  return (
    <Ctx.Provider value={{ pref, resolved, setPref }}>{children}</Ctx.Provider>
  );
}

export function useTheme() {
  return useContext(Ctx);
}

// Inline script that applies the stored theme before first paint (no flash).
export const themeInitScript = `(function(){try{var p=localStorage.getItem("${KEY}")||"system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark");}catch(e){}})();`;
