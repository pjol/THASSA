const STYLES = {
  info: "border-brand/30 bg-brand/[0.06]",
  warn: "border-settling/40 bg-settling/[0.07]",
  danger: "border-no/35 bg-no/[0.06]",
} as const;

const LABELS = { info: "Note", warn: "Careful", danger: "Important" } as const;
const LABEL_COLOR = {
  info: "text-brand",
  warn: "text-settling",
  danger: "text-no",
} as const;

export default function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: keyof typeof STYLES;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`not-prose my-5 rounded-xl border px-4.5 p-4 ${STYLES[kind]}`}>
      <p className={`font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${LABEL_COLOR[kind]}`}>
        {title ?? LABELS[kind]}
      </p>
      <div className="mt-1.5 text-[14px] leading-relaxed text-muted [&_code]:whitespace-nowrap [&_code]:rounded [&_code]:bg-fg/[0.07] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-fg [&_strong]:font-semibold [&_strong]:text-fg">
        {children}
      </div>
    </div>
  );
}
