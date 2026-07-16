"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Heading = { id: string; text: string; level: number };

// Right-hand "On this page" rail: scans rendered h2/h3 headings (which carry
// ids) and tracks the active one with an IntersectionObserver.
export default function OnThisPage() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(".docs-prose h2[id], .docs-prose h3[id]")
    );
    setHeadings(
      nodes.map((n) => ({
        id: n.id,
        text: n.textContent ?? "",
        level: n.tagName === "H2" ? 2 : 3,
      }))
    );

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [pathname]);

  if (headings.length === 0) return null;

  return (
    <aside className="sticky top-[calc(var(--header-h)+20px)] hidden max-h-[calc(100vh-var(--header-h)-40px)] w-[200px] shrink-0 overflow-y-auto pb-10 xl:block">
      <p className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-faint">
        On this page
      </p>
      <ul className="mt-3 space-y-1 border-l hairline">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={`-ml-px block border-l-2 py-1 text-[12.5px] leading-snug transition ${
                h.level === 3 ? "pl-6" : "pl-3.5"
              } ${
                active === h.id
                  ? "border-brand font-medium text-brand"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
