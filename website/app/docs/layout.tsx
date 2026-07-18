import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import DocsSidebar from "@/components/docs/DocsSidebar";
import OnThisPage from "@/components/docs/OnThisPage";

export const metadata: Metadata = {
  title: {
    default: "Developer docs",
    template: "%s · Thassa Docs",
  },
  description:
    "Build on Thassa: the protocol, the gasless order flow, and the full trading API reference.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      {/* Mobile: stacked (drawer trigger above the article). Desktop: the
          classic three-column rail / article / on-this-page row. */}
      <div className="container-page flex flex-col pt-[calc(var(--header-h)+36px)] lg:flex-row lg:gap-10">
        <DocsSidebar />
        <main className="min-w-0 flex-1 pb-24">
          <article className="docs-prose mx-auto max-w-[760px]">
            {children}
          </article>
        </main>
        <OnThisPage />
      </div>
      <Footer />
    </>
  );
}
