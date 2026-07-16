"use client";

// Auth gate for all app routes: Privy auth is client-side (unlike ASSEMBLY's
// Clerk middleware), so the (app) route group gates here — loading → /login →
// /onboarding → shell.

import { useEffect } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/providers/AuthProvider";
import { useSession } from "@/providers/SessionProvider";
import { AppShell } from "@/components/AppShell";
import { Spinner } from "@/components/icons";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated } = useAuth();
  const { me, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const needsLogin = ready && !authenticated;
  const needsOnboarding =
    ready && authenticated && !loading && (!me || !me.onboarded);

  useEffect(() => {
    if (needsLogin) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    } else if (needsOnboarding) {
      router.replace("/onboarding");
    }
  }, [needsLogin, needsOnboarding, router, pathname]);

  if (!ready || (authenticated && loading) || needsLogin || needsOnboarding) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg">
        <Image src="/thassa-logo.svg" alt="Thassa" width={56} height={56} priority />
        <Spinner size={22} className="text-muted" />
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
