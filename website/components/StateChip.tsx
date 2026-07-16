// One-word state chips — verbatim platform vocabulary with the mandated
// color mapping: PENDING/QUEUED/SIGNING gray · OPEN blue · MATCHED/FILLED
// green · SETTLING amber · SETTLED black(light)/white(dark) with direction
// badge · VOID/CANCELED muted red.

export type MarketState =
  | "PENDING"
  | "OPEN"
  | "MATCHED"
  | "SETTLING"
  | "SETTLED"
  | "VOID";
export type OrderState =
  | "SIGNING"
  | "QUEUED"
  | "RESTING"
  | "PARTIAL"
  | "FILLED"
  | "CANCELED";

const STYLES: Record<MarketState | OrderState, string> = {
  PENDING: "bg-faint/15 text-muted border-faint/25",
  SIGNING: "bg-faint/15 text-muted border-faint/25",
  QUEUED: "bg-faint/15 text-muted border-faint/25",
  RESTING: "bg-brand/10 text-brand border-brand/25",
  OPEN: "bg-brand/10 text-brand border-brand/25",
  PARTIAL: "bg-brand/10 text-brand border-brand/25",
  MATCHED: "bg-yes/10 text-yes border-yes/25",
  FILLED: "bg-yes/10 text-yes border-yes/25",
  SETTLING: "bg-settling/10 text-settling border-settling/30",
  SETTLED: "bg-fg text-bg border-transparent",
  VOID: "bg-no/10 text-no/80 border-no/20",
  CANCELED: "bg-no/10 text-no/80 border-no/20",
};

export default function StateChip({
  state,
  direction,
  className = "",
}: {
  state: MarketState | OrderState;
  direction?: "YES" | "NO";
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${STYLES[state]} ${className}`}
    >
      {state}
      {state === "SETTLED" && direction && (
        <span
          className={`rounded-full px-1.5 py-px text-[9px] ${
            direction === "YES" ? "bg-yes text-white" : "bg-no text-white"
          }`}
        >
          {direction}
        </span>
      )}
    </span>
  );
}
