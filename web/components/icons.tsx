// Inline stroke icon set (24px grid, IG-ish weight). Every icon accepts
// size/className and is aria-hidden by default — buttons supply aria-labels.

interface IconProps {
  size?: number;
  className?: string;
  filled?: boolean;
  strokeWidth?: number;
}

function base(p: IconProps) {
  return {
    width: p.size ?? 24,
    height: p.size ?? 24,
    viewBox: "0 0 24 24",
    fill: p.filled ? "currentColor" : "none",
    stroke: "currentColor",
    strokeWidth: p.strokeWidth ?? (p.filled ? 0 : 1.8),
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: p.className,
    "aria-hidden": true,
  };
}

export const HomeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1v-9.5Z" />
  </svg>
);

export const ExploreIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" fill={p.filled ? "currentColor" : "none"} />
  </svg>
);

export const ReelsIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M3 8h18M8.5 3 11 8M14.5 3 17 8" />
    <path d="m10.5 11.5 4.5 2.7-4.5 2.7v-5.4Z" fill="currentColor" stroke="none" />
  </svg>
);

export const MessageIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.1-1L3 20l1.05-5A8.5 8.5 0 1 1 21 11.5Z" />
  </svg>
);

export const BellIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9Z" />
    <path d="M10 20a2.2 2.2 0 0 0 4 0" fill="none" strokeWidth={1.8} />
  </svg>
);

export const PlusIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </svg>
);

export const HeartIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 20.5s-8.5-5.1-8.5-11A4.6 4.6 0 0 1 8.1 4.9c1.6 0 3.1.8 3.9 2.2a4.6 4.6 0 0 1 3.9-2.2 4.6 4.6 0 0 1 4.6 4.6c0 5.9-8.5 11-8.5 11Z" />
  </svg>
);

export const CommentIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.1-1L3 20l1.05-5A8.5 8.5 0 1 1 21 11.5Z" />
  </svg>
);

export const ShareIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M21 3 9.5 14.5M21 3l-7 18-3.5-6.5L4 11l17-8Z" />
  </svg>
);

export const SmileIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
    <circle cx="9" cy="9.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="9.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const UserIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20.5c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" fill="none" />
  </svg>
);

export const SearchIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M15 18 9 12l6-6" />
  </svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const CloseIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false, strokeWidth: 2.2 })}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const EllipsisIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: true })}>
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </svg>
);

export const SettingsIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.65 15 1.7 1.7 0 0 0 3.09 14H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.65 1.7 1.7 0 0 0 10.03 3.09V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51 1.03Z" />
  </svg>
);

export const GridIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" />
  </svg>
);

export const TradesIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M3 17.5 9 11l4 4 7.5-8" />
    <path d="M15.5 7H21v5.5" />
  </svg>
);

export const WalletIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="3" y="6" width="18" height="13" rx="3" />
    <path d="M3 10h18" opacity="0" />
    <path d="M16 12.5h3" strokeWidth="2.4" />
    <path d="M7 6V5a2 2 0 0 1 2-2h8" />
  </svg>
);

export const CameraIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M4 8h2.5L8.5 5h7L17.5 8H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </svg>
);

export const SparkleIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: true })}>
    <path d="M12 2.5 14.2 9 21 11.5 14.2 14 12 20.5 9.8 14 3 11.5 9.8 9 12 2.5Z" />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);

export const CheckIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false, strokeWidth: 2.4 })}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

export const PlayIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: true })}>
    <path d="M8 5.5v13l11-6.5-11-6.5Z" />
  </svg>
);

export const MuteIcon = (p: IconProps & { muted?: boolean }) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" fill="currentColor" stroke="none" />
    {p.muted ? (
      <path d="m15.5 9.5 5 5m0-5-5 5" strokeWidth="2" />
    ) : (
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" strokeWidth="2" />
    )}
  </svg>
);

export const SendIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M21 3 9.5 14.5M21 3l-7 18-3.5-6.5L4 11l17-8Z" />
  </svg>
);

export const LockIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);

export const LinkIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <path d="M10 14a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 5.4" />
    <path d="M14 10a5 5 0 0 0-7.07 0L4.1 12.83a5 5 0 0 0 7.07 7.07l1.32-1.3" />
  </svg>
);

export const ImageIcon = (p: IconProps) => (
  <svg {...base({ ...p, filled: false })}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m4 18 5.2-5.2a1.5 1.5 0 0 1 2.1 0L21 18.5" />
  </svg>
);

export const Spinner = ({ size = 20, className = "" }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={`animate-spin ${className}`}
    aria-hidden
  >
    <circle
      cx="12"
      cy="12"
      r="9.5"
      fill="none"
      stroke="currentColor"
      strokeOpacity="0.2"
      strokeWidth="3"
    />
    <path
      d="M21.5 12A9.5 9.5 0 0 0 12 2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);
