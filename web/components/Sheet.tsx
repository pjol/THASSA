"use client";

// Modal + bottom-sheet primitives. On mobile a Sheet slides up from the
// bottom (IG-style); on desktop it renders as a centered dialog. Both trap
// Escape and click-outside, lock scroll, and label themselves for a11y.

import { useEffect } from "react";
import { CloseIcon } from "@/components/icons";

function useDismiss(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useDismiss(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px] md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md animate-sheet-up rounded-t-3xl border border-edge bg-card shadow-sheet md:animate-fade-up md:rounded-3xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-base font-bold text-fg">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-muted transition hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto px-5 pb-6 pt-2">
          {children}
        </div>
      </div>
    </div>
  );
}

export function FullModal({
  onClose,
  children,
  label,
}: {
  onClose: () => void;
  children: React.ReactNode;
  label: string;
}) {
  useDismiss(onClose);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 rounded-full bg-black/40 p-2 text-white transition hover:bg-black/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
      >
        <CloseIcon size={20} />
      </button>
      {children}
    </div>
  );
}
