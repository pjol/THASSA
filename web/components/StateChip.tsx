// The single state chip used everywhere (spec §5): one-word market and order
// states, verbatim, with consistent colors.
//   PENDING / QUEUED / SIGNING → gray
//   OPEN → blue · MATCHED / FILLED → green · SETTLING → amber
//   SETTLED → black (light) / white (dark), i.e. accent, + direction badge
//   VOID / CANCELED → muted red · RESTING / PARTIAL → blue-tinted gray

import type { ChipState } from "@/lib/types";

const STYLES: Record<ChipState, string> = {
  PENDING: "bg-surface text-muted",
  SIGNING: "bg-surface text-muted",
  QUEUED: "bg-surface text-muted",
  OPEN: "bg-brand-soft text-brand",
  MATCHED: "bg-yes/15 text-yes",
  FILLED: "bg-yes/15 text-yes",
  SETTLING: "bg-settling/15 text-settling",
  SETTLED: "bg-accent text-accent-fg",
  VOID: "bg-no/10 text-no/70",
  CANCELED: "bg-no/10 text-no/70",
  RESTING: "bg-brand-soft/60 text-brand/80",
  PARTIAL: "bg-brand-soft/60 text-brand/80",
};

export function StateChip({
  state,
  direction,
  className = "",
  size = "sm",
}: {
  state: ChipState;
  // For SETTLED markets: outcome direction (true = YES) shown as a badge.
  direction?: boolean | null;
  className?: string;
  size?: "xs" | "sm";
}) {
  const pad = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        className={`inline-flex items-center rounded-full font-bold uppercase tracking-wide ${pad} ${STYLES[state]}`}
      >
        {state}
      </span>
      {state === "SETTLED" && direction !== null && direction !== undefined && (
        <span
          className={`inline-flex items-center rounded-full font-bold uppercase tracking-wide ${pad} ${
            direction ? "bg-yes text-white" : "bg-no text-white"
          }`}
        >
          {direction ? "YES" : "NO"}
        </span>
      )}
    </span>
  );
}

// Terse creator microcopy (spec §5).
export function creatorMicrocopy(state: ChipState): string | null {
  switch (state) {
    case "PENDING":
      return "Placing your market…";
    case "OPEN":
      return "You're committed. Waiting for someone to take your bet.";
    case "MATCHED":
      return "Your bet was taken.";
    case "SETTLING":
      return "Settlement query is running.";
    case "SETTLED":
      return "Outcome is final.";
    case "VOID":
      return "Market voided — deposits refundable.";
    default:
      return null;
  }
}
