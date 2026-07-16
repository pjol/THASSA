"use client";

import { useState } from "react";
import CodeBlock from "./CodeBlock";

export type TabSpec = { label: string; title?: string; code: string };

// Language tabs for API examples (curl / TypeScript / Python).
export default function ClientTabs({ tabs }: { tabs: TabSpec[] }) {
  const [i, setI] = useState(0);
  return (
    <div>
      <div role="tablist" aria-label="Client examples" className="mb-2 flex gap-1.5">
        {tabs.map((t, idx) => (
          <button
            key={t.label}
            role="tab"
            aria-selected={i === idx}
            onClick={() => setI(idx)}
            className={`rounded-lg px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] transition ${
              i === idx
                ? "bg-brand text-white"
                : "bg-fg/[0.06] text-muted hover:bg-fg/10 hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock title={tabs[i].title ?? tabs[i].label} code={tabs[i].code} />
    </div>
  );
}
