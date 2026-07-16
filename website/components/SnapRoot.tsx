"use client";

import { useEffect } from "react";

// Scopes ASSEMBLY-style scroll snapping to the landing page: while mounted,
// stamps data-snap on <html>, which activates `scroll-snap-type: y mandatory`
// on the root scroller plus per-section snap alignment (see globals.css).
export default function SnapRoot() {
  useEffect(() => {
    document.documentElement.setAttribute("data-snap", "");
    return () => document.documentElement.removeAttribute("data-snap");
  }, []);
  return null;
}
