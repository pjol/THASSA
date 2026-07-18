import StateChip, { MarketState } from "./StateChip";

// Stylized product mocks, built as components (no images).

export function MarketCardMock({
  question,
  state = "OPEN",
  direction,
  yes = 62,
  volume = "$4,210",
  compact = false,
}: {
  question: string;
  state?: MarketState;
  direction?: "YES" | "NO";
  yes?: number;
  volume?: string;
  compact?: boolean;
}) {
  const no = 100 - yes;
  return (
    <div className="rounded-2xl border border-brand/25 bg-brand/[0.04] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className={`font-semibold leading-snug ${compact ? "text-[12.5px]" : "text-[13.5px]"}`}>
          {question}
        </p>
        <StateChip state={state} direction={direction} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button className="group rounded-xl border border-yes/30 bg-yes/10 px-3 py-2 text-left transition hover:bg-yes/20">
          <span className="block font-mono text-[9.5px] uppercase tracking-[0.14em] text-yes">
            Yes
          </span>
          <span className="text-[15px] font-bold text-yes">{yes}¢</span>
        </button>
        <button className="group rounded-xl border border-no/30 bg-no/10 px-3 py-2 text-left transition hover:bg-no/20">
          <span className="block font-mono text-[9.5px] uppercase tracking-[0.14em] text-no">
            No
          </span>
          <span className="text-[15px] font-bold text-no">{no}¢</span>
        </button>
      </div>
      <div className="mt-2.5 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">
        <span>{volume} matched</span>
        <span>$1 / share</span>
      </div>
    </div>
  );
}

export function PostCardMock() {
  return (
    <div className="w-full max-w-[360px] overflow-hidden rounded-3xl border hairline bg-bg text-fg shadow-pop">
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand to-brand-soft" />
        <div className="leading-tight">
          <p className="text-[13px] font-semibold">maya.runs</p>
          <p className="text-[11px] text-faint">San Francisco</p>
        </div>
        <div className="ml-auto flex gap-1">
          <span className="h-1 w-1 rounded-full bg-faint" />
          <span className="h-1 w-1 rounded-full bg-faint" />
          <span className="h-1 w-1 rounded-full bg-faint" />
        </div>
      </div>
      {/* media */}
      <div className="relative mx-4 aspect-[4/3] overflow-hidden rounded-2xl bg-gradient-to-br from-brand/80 via-brand-deep to-[#0A2A55]">
        <div className="absolute inset-0 opacity-30 [background:radial-gradient(60%_50%_at_70%_20%,white,transparent_70%)]" />
        <div className="absolute bottom-3 left-3 rounded-full bg-black/35 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white backdrop-blur">
          Race day: Bay to Breakers
        </div>
      </div>
      {/* actions */}
      <div className="flex items-center gap-4 px-4 pt-3 text-muted">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
          <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
        </svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
        </svg>
        <span className="ml-auto text-[11.5px] font-medium text-faint">1,284 likes</span>
      </div>
      {/* caption */}
      <p className="px-4 pt-2 text-[12.5px] leading-snug text-muted">
        <span className="font-semibold text-fg">maya.runs</span> Sub-40 or the
        bet pays out. Take the other side if you dare 🏃
      </p>
      {/* attached market */}
      <div className="p-4">
        <MarketCardMock
          question="Will Maya finish Bay to Breakers under 40 minutes?"
          state="OPEN"
          yes={62}
        />
      </div>
    </div>
  );
}

export function OrderBookMock() {
  const yesLevels = [
    { p: 64, s: 320 },
    { p: 63, s: 780 },
    { p: 62, s: 1250 },
  ];
  const noLevels = [
    { p: 38, s: 1100 },
    { p: 37, s: 640 },
    { p: 36, s: 260 },
  ];
  return (
    <div className="w-full max-w-[380px] rounded-3xl border hairline bg-bg text-fg p-5 shadow-pop">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold">Order book</p>
        <span className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
          <span className="pulse-dot" /> live
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-yes">Buy Yes</p>
          <div className="mt-2 space-y-1.5">
            {yesLevels.map((l) => (
              <div key={l.p} className="relative overflow-hidden rounded-lg">
                <div
                  className="absolute inset-y-0 left-0 bg-yes/15"
                  style={{ width: `${(l.s / 1250) * 100}%` }}
                />
                <div className="relative flex justify-between px-2.5 py-1.5 font-mono text-[11.5px]">
                  <span className="font-semibold text-yes">{l.p}¢</span>
                  <span className="text-muted">{l.s.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-no">Buy No</p>
          <div className="mt-2 space-y-1.5">
            {noLevels.map((l) => (
              <div key={l.p} className="relative overflow-hidden rounded-lg">
                <div
                  className="absolute inset-y-0 left-0 bg-no/15"
                  style={{ width: `${(l.s / 1250) * 100}%` }}
                />
                <div className="relative flex justify-between px-2.5 py-1.5 font-mono text-[11.5px]">
                  <span className="font-semibold text-no">{l.p}¢</span>
                  <span className="text-muted">{l.s.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-4 rounded-xl border border-brand/20 bg-brand/[0.06] px-3 py-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-brand">
        64¢ Yes + 36¢ No ≥ 100: crossed
      </p>
    </div>
  );
}
