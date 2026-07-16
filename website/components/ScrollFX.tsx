"use client";

import { useEffect } from "react";

// IntersectionObserver-driven reveals (per ASSEMBLY's webpage fallback path):
// elements tagged .fx / .fx-scale transition in the first time they enter
// the viewport. No animation libraries.
export default function ScrollFX() {
  useEffect(() => {
    const els = document.querySelectorAll(".fx, .fx-scale");
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.1 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
