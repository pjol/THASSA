"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";
import { APP_URL } from "@/lib/config";

const LINKS: [string, string][] = [
  ["/docs", "Docs"],
  ["/download", "Download"],
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <header
        className={`glass fixed left-1/2 top-3 z-[100] w-[min(1180px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border transition-all duration-300 ${
          scrolled || open
            ? "border-brand/20 shadow-pop"
            : "hairline shadow-card"
        }`}
      >
        <div className="flex h-[58px] items-center justify-between gap-5 px-4 sm:px-5">
          <Link
            href="/"
            aria-label="Thassa home"
            className="flex min-w-0 items-center gap-2.5"
            onClick={() => setOpen(false)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/thassa-logo.svg" alt="" className="h-7 w-7" />
            <span className="text-[21px] font-bold tracking-tight">
              Thassa<span className="text-brand">.</span>
            </span>
          </Link>

          <nav className="ml-auto hidden items-center gap-7 sm:flex" aria-label="Primary">
            {LINKS.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="group relative py-1.5 text-[14.5px] font-medium text-muted transition hover:text-fg"
              >
                {label}
                <span className="absolute bottom-0 left-0 right-full h-0.5 rounded bg-brand transition-all duration-300 group-hover:right-0" />
              </Link>
            ))}
          </nav>

          <a
            href={APP_URL}
            className="hidden shrink-0 items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_12px_30px_-12px_rgba(48,124,222,0.65)] transition hover:-translate-y-0.5 hover:bg-brand-deep sm:inline-flex"
          >
            Open the app
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[13px] w-[13px]" aria-hidden="true">
              <path d="M7 17 17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </a>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              className="inline-flex h-10 w-10 items-center justify-center sm:hidden"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="mobileMenu"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-6 w-6">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-6 w-6">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      <nav
        id="mobileMenu"
        aria-label="Mobile"
        className={`glass fixed left-1/2 top-[80px] z-[99] w-[min(1180px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border hairline p-4 shadow-pop sm:hidden ${
          open ? "block" : "hidden"
        }`}
      >
        {LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className="block border-b hairline py-3.5 text-[16px] font-medium last:border-b-0"
          >
            {label}
          </Link>
        ))}
        <a
          href={APP_URL}
          className="mt-3 flex justify-center rounded-xl bg-brand px-4 py-3 text-[14px] font-semibold text-white"
        >
          Open the app
        </a>
      </nav>
    </>
  );
}
