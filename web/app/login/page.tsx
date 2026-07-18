"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/providers/AuthProvider";
import { Spinner } from "@/components/icons";

export default function LoginPage() {
  const { ready, authenticated, login } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && authenticated) router.replace("/");
  }, [ready, authenticated, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-6">
      <div className="w-full max-w-sm text-center">
        <Image
          src="/thassa-logo.svg"
          alt="Thassa"
          width={72}
          height={72}
          priority
          className="mx-auto"
        />
        <h1 className="mt-6 text-3xl font-extrabold tracking-tight text-fg">
          Thassa
        </h1>
        <p className="mt-2 text-[15px] text-muted">
          Share moments. Bet on what happens next.
        </p>

        <div className="card mt-10 p-6 shadow-soft">
          {!ready ? (
            <div className="flex justify-center py-3">
              <Spinner className="text-muted" />
            </div>
          ) : (
            <>
              <button onClick={login} className="btn-brand w-full !py-3 text-base">
                Log in or sign up
              </button>
              <p className="mt-4 text-xs leading-relaxed text-muted">
                We&apos;ll create a wallet for you automatically — no seed
                phrases, no gas. Powered by Privy.
              </p>
            </>
          )}
        </div>

        <div className="mt-8 flex items-center justify-center gap-2 text-xs text-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-yes" /> YES
          <span className="ml-3 inline-block h-1.5 w-1.5 rounded-full bg-no" /> NO
          <span className="ml-3">Every post can carry a market.</span>
        </div>
      </div>
    </div>
  );
}
