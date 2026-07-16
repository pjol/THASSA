"use client";

import { useState } from "react";

export default function CodeBlock({
  title,
  code,
}: {
  title?: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <div className="code-block not-prose">
      <div className="code-title">
        <span>{title ?? "code"}</span>
        <button
          onClick={copy}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white/50 transition hover:text-white"
          aria-label="Copy code"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
