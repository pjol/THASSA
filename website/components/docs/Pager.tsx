import Link from "next/link";

export default function Pager({
  prev,
  next,
}: {
  prev?: { href: string; label: string };
  next?: { href: string; label: string };
}) {
  return (
    <div className="not-prose mt-14 grid gap-3 border-t hairline pt-6 sm:grid-cols-2">
      {prev ? (
        <Link
          href={prev.href}
          className="group rounded-2xl border hairline p-4 transition hover:border-brand/50"
        >
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
            ← Previous
          </span>
          <span className="mt-1 block text-[14.5px] font-semibold transition group-hover:text-brand">
            {prev.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group rounded-2xl border hairline p-4 text-right transition hover:border-brand/50"
        >
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
            Next →
          </span>
          <span className="mt-1 block text-[14.5px] font-semibold transition group-hover:text-brand">
            {next.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
