import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ScrollFX from "@/components/ScrollFX";
import QRCode from "@/components/QRCode";
import { APP_URL, APPSTORE_URL, PLAYSTORE_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Get Thassa on iOS and Android, or open the web app. One account for the feed, markets, wallet, and the developer API.",
  openGraph: {
    title: "Download Thassa",
    description:
      "Get Thassa on iOS and Android, or open the web app. One account everywhere.",
  },
};

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-8 w-8" aria-hidden="true">
      <path d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.35-1.97-3.44-2.24-4.18-2.27-1.78-.18-3.47 1.05-4.37 1.05-.9 0-2.29-1.02-3.77-1-1.94.03-3.72 1.13-4.72 2.86-2.01 3.49-.51 8.66 1.45 11.49.96 1.39 2.1 2.94 3.6 2.88 1.44-.06 1.99-.93 3.73-.93 1.74 0 2.23.93 3.76.9 1.56-.03 2.54-1.41 3.49-2.8 1.1-1.61 1.55-3.17 1.58-3.25-.03-.02-3.02-1.16-3.04-4.59zM14.16 4.06c.8-.96 1.33-2.3 1.19-3.64-1.15.05-2.53.76-3.35 1.72-.74.85-1.38 2.21-1.21 3.51 1.28.1 2.58-.65 3.37-1.59z" />
    </svg>
  );
}

function PlayMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-8 w-8" aria-hidden="true">
      <path d="M3.6 1.8c-.37.39-.6.99-.6 1.77v16.86c0 .78.23 1.38.6 1.77l.1.09 9.44-9.44v-.22L3.7 1.71l-.1.09z" />
      <path d="m17.28 15.09-3.14-3.14v-.22l3.14-3.14.07.04 3.72 2.11c1.06.6 1.06 1.59 0 2.2l-3.72 2.11-.07.04z" opacity="0.85" />
      <path d="m17.35 15.05-3.21-3.21L3.6 22.2c.35.37.93.42 1.58.05l12.17-6.9v-.3z" opacity="0.7" />
      <path d="M17.35 8.63 5.18 1.75C4.53 1.38 3.95 1.43 3.6 1.8l10.54 10.36 3.21-3.21v-.32z" opacity="0.55" />
    </svg>
  );
}

function StoreBadge({
  href,
  mark,
  kicker,
  store,
}: {
  href: string;
  mark: React.ReactNode;
  kicker: string;
  store: string;
}) {
  const live = href.length > 0;
  const inner = (
    <>
      {mark}
      <span className="text-left leading-tight">
        <span className="block font-mono text-[9.5px] uppercase tracking-[0.16em] opacity-70">
          {live ? kicker : "Coming soon to"}
        </span>
        <span className="block text-[19px] font-bold tracking-tight">{store}</span>
      </span>
    </>
  );
  if (!live) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex min-w-[210px] cursor-not-allowed items-center gap-3.5 rounded-2xl border hairline bg-fg/[0.04] px-6 py-4 text-muted opacity-70"
      >
        {inner}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-w-[210px] items-center gap-3.5 rounded-2xl bg-fg px-6 py-4 text-bg shadow-card transition hover:-translate-y-0.5 hover:shadow-pop"
    >
      {inner}
    </a>
  );
}

export default function Download() {
  return (
    <>
      <ScrollFX />
      <Navbar />
      <main className="hero-grid-bg relative min-h-[100svh] pt-[calc(var(--header-h)+72px)]">
        <div className="container-page pb-24">
          <div className="mx-auto max-w-[720px] text-center">
            <p className="anim-rise inline-flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
              <span className="pulse-dot" aria-hidden="true" />
              iOS · Android · Web
            </p>
            <h1 className="anim-rise-1 mt-6 text-[clamp(40px,6vw,68px)] font-extrabold leading-[1.0] tracking-[-0.04em]">
              Thassa in your <span className="text-gradient-brand">pocket</span>.
            </h1>
            <p className="anim-rise-2 mx-auto mt-5 max-w-[520px] text-[16.5px] leading-relaxed text-muted">
              The full feed, every market, and your wallet, with one account
              across mobile, web, and the API. Scan the code or grab it from
              your store.
            </p>
          </div>

          <div className="anim-rise-3 mx-auto mt-14 grid max-w-[880px] items-center gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex flex-col items-center gap-5 md:items-start">
              <div className="flex flex-wrap justify-center gap-4 md:justify-start">
                <StoreBadge
                  href={APPSTORE_URL}
                  mark={<AppleMark />}
                  kicker="Download on the"
                  store="App Store"
                />
                <StoreBadge
                  href={PLAYSTORE_URL}
                  mark={<PlayMark />}
                  kicker="Get it on"
                  store="Google Play"
                />
              </div>
              <a
                href={APP_URL}
                className="group inline-flex items-center gap-2.5 rounded-2xl border hairline bg-bg px-6 py-4 text-[15px] font-semibold transition hover:-translate-y-0.5 hover:border-brand hover:text-brand"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                Or open the web app
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[14px] w-[14px] transition-transform group-hover:translate-x-0.5" aria-hidden="true">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </a>
              <p className="max-w-[420px] text-center text-[13px] leading-relaxed text-faint md:text-left">
                One Thassa account works everywhere. Sign up once in the app
                and the same login works in the web app and{" "}
                <a href="/docs" className="font-medium text-brand hover:underline">
                  the developer API
                </a>
                .
              </p>
            </div>

            <div className="mx-auto w-fit rounded-3xl border hairline bg-card p-6 shadow-pop">
              <QRCode value={APP_URL} />
              <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                Scan to open the app
              </p>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
