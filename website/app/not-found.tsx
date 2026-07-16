import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import StateChip from "@/components/StateChip";

export const metadata: Metadata = {
  title: "Page not found",
  description: "This page has been voided. All deposits refundable.",
};

export default function NotFound() {
  return (
    <>
      <Navbar />
      <main className="hero-grid-bg relative grid min-h-[100svh] place-items-center px-6 pt-[var(--header-h)]">
        <div className="text-center">
          <div className="flex justify-center">
            <StateChip state="VOID" />
          </div>
          <h1 className="mt-6 text-[clamp(64px,12vw,140px)] font-extrabold leading-none tracking-[-0.05em]">
            4<span className="text-gradient-brand">0</span>4
          </h1>
          <p className="mx-auto mt-4 max-w-[380px] text-[15.5px] leading-relaxed text-muted">
            This market never existed — the page you&rsquo;re looking for has been
            voided. All deposits refundable.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3.5">
            <Link
              href="/"
              className="rounded-xl bg-brand px-6 py-3 text-[14.5px] font-semibold text-white transition hover:-translate-y-0.5 hover:bg-brand-deep"
            >
              Back home
            </Link>
            <Link
              href="/docs"
              className="rounded-xl border hairline px-6 py-3 text-[14.5px] font-semibold transition hover:-translate-y-0.5 hover:border-brand hover:text-brand"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
