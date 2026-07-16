"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DOCS_NAV } from "@/lib/docs-nav";

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs" className="space-y-7">
      {DOCS_NAV.map((group) => (
        <div key={group.title}>
          <p className="px-3 font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-faint">
            {group.title}
          </p>
          <ul className="mt-2 space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-3 py-1.5 text-[13.5px] transition ${
                      active
                        ? "bg-brand/10 font-semibold text-brand"
                        : "text-muted hover:bg-fg/5 hover:text-fg"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function DocsSidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const current = DOCS_NAV.flatMap((g) => g.items).find(
    (i) => i.href === pathname
  );

  return (
    <>
      {/* Desktop: sticky left rail */}
      <aside className="sticky top-[calc(var(--header-h)+20px)] hidden max-h-[calc(100vh-var(--header-h)-40px)] w-[230px] shrink-0 overflow-y-auto pb-10 pr-2 lg:block">
        <NavList />
      </aside>

      {/* Mobile: drawer trigger bar */}
      <div className="sticky top-[calc(var(--header-h)+8px)] z-40 -mx-1 mb-6 lg:hidden">
        <button
          onClick={() => setOpen(true)}
          className="glass flex w-full items-center gap-2.5 rounded-xl border hairline px-4 py-2.5 text-[13.5px] font-medium shadow-card"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 text-brand" aria-hidden="true">
            <path d="M4 7h16M4 12h10M4 17h7" />
          </svg>
          <span className="text-faint">Docs</span>
          <span className="text-muted">/</span>
          <span>{current?.label ?? "Menu"}</span>
        </button>
      </div>

      {/* Mobile: drawer */}
      {open && (
        <div className="fixed inset-0 z-[110] lg:hidden" role="dialog" aria-modal="true" aria-label="Docs navigation">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[290px] overflow-y-auto border-r hairline bg-bg p-5 shadow-pop">
            <div className="mb-6 flex items-center justify-between">
              <span className="text-[16px] font-bold tracking-tight">
                Docs<span className="text-brand">.</span>
              </span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close docs navigation"
                className="flex h-9 w-9 items-center justify-center rounded-lg border hairline"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <NavList onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
