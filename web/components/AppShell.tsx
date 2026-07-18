"use client";

// App chrome (spec §7): desktop = left sidebar nav (icon-only < xl, labeled
// ≥ xl); mobile = top bar (logo + DM icon) and IG-style bottom tabs. Also
// hosts the global user:{me} WS listener that raises notification toasts.

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/providers/SessionProvider";
import { useWarp } from "@/providers/WarpProvider";
import { useChannel } from "@/lib/ws";
import { useToast } from "@/providers/ToastProvider";
import { Avatar } from "@/components/Avatar";
import { WarpBanner } from "@/components/WarpBanner";
import {
  BellIcon,
  ExploreIcon,
  HomeIcon,
  MessageIcon,
  PlusIcon,
  ReelsIcon,
} from "@/components/icons";
import type { Notification, WsFrame } from "@/lib/types";

function notifText(n: Notification): { title: string; body?: string } {
  switch (n.kind) {
    case "market.matched":
      return { title: "Your bet was taken", body: n.payload.market_question ?? undefined };
    case "market.settled":
      return { title: "Market settled", body: n.payload.market_question ?? undefined };
    case "order.filled":
      return { title: "Order filled", body: n.payload.market_question ?? undefined };
    case "dm.message":
      return {
        title: `New message${n.payload.actor ? ` from ${n.payload.actor.username}` : ""}`,
        body: n.payload.text ?? undefined,
      };
    case "post.liked":
      return { title: `${n.payload.actor?.username ?? "Someone"} liked your post` };
    case "post.commented":
      return { title: `${n.payload.actor?.username ?? "Someone"} commented on your post`, body: n.payload.text ?? undefined };
    case "follow":
      return { title: `${n.payload.actor?.username ?? "Someone"} started following you` };
    case "follow.request":
      return { title: `${n.payload.actor?.username ?? "Someone"} requested to follow you` };
    default:
      return { title: "Notification" };
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me } = useSession();
  const { active: warped } = useWarp();
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Global notification toasts + cache invalidation on user events.
  useChannel(me ? `user:${me.id}` : null, (frame: WsFrame) => {
    if (frame.type === "notification") {
      const n = frame.payload as Notification;
      const { title, body } = notifText(n);
      toast.info(title, body);
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      if (n.kind === "dm.message")
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (n.kind === "market.matched" || n.kind === "market.settled")
        queryClient.invalidateQueries({ queryKey: ["feed"] });
    }
    if (frame.type === "order.update")
      queryClient.invalidateQueries({ queryKey: ["orders"] });
  });

  const nav = [
    { href: "/", label: "Home", icon: HomeIcon },
    { href: "/explore", label: "Explore", icon: ExploreIcon },
    { href: "/reels", label: "Reels", icon: ReelsIcon },
    { href: "/messages", label: "Messages", icon: MessageIcon },
    { href: "/notifications", label: "Notifications", icon: BellIcon },
    { href: "/create", label: "Create", icon: PlusIcon },
  ];

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const profileHref = me ? `/u/${me.username}` : "/onboarding";
  const immersive = pathname.startsWith("/reels"); // full-bleed surfaces

  return (
    <div className={`min-h-screen bg-bg ${warped ? "pt-11" : ""}`}>
      {/* Persistent warp banner (spec §7c.3) — offsets below via `warped`. */}
      <WarpBanner />

      {/* Desktop sidebar */}
      <aside
        className={`fixed bottom-0 left-0 z-40 hidden w-[76px] flex-col border-r border-edge bg-bg px-3 py-6 md:flex xl:w-60 ${
          warped ? "top-11" : "top-0"
        }`}
      >
        <Link
          href="/"
          className="mb-8 flex items-center gap-3 rounded-xl px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          aria-label="Thassa home"
        >
          <Image src="/thassa-logo.svg" alt="" width={34} height={34} priority />
          <span className="hidden text-xl font-extrabold tracking-tight text-fg xl:block">
            Thassa
          </span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Primary">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={`flex items-center gap-4 rounded-xl px-3 py-2.5 text-[15px] transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
                isActive(href) ? "font-bold text-fg" : "font-medium text-fg/80"
              }`}
            >
              <Icon size={24} filled={isActive(href)} />
              <span className="hidden xl:block">{label}</span>
            </Link>
          ))}
          <Link
            href={profileHref}
            aria-current={pathname === profileHref ? "page" : undefined}
            className={`mt-auto flex items-center gap-4 rounded-xl px-3 py-2.5 text-[15px] transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${
              pathname === profileHref ? "font-bold" : "font-medium text-fg/80"
            }`}
          >
            <Avatar user={me} size="xs" />
            <span className="hidden xl:block">Profile</span>
          </Link>
        </nav>
      </aside>

      {/* Mobile top bar */}
      {!immersive && (
        <header
          className={`sticky z-40 flex items-center justify-between border-b border-edge bg-bg/85 px-4 py-2.5 backdrop-blur md:hidden ${
            warped ? "top-11" : "top-0"
          }`}
        >
          <Link href="/" className="flex items-center gap-2" aria-label="Thassa home">
            <Image src="/thassa-logo.svg" alt="" width={28} height={28} priority />
            <span className="text-lg font-extrabold tracking-tight text-fg">Thassa</span>
          </Link>
          <div className="flex items-center gap-1">
            <button
              onClick={() => router.push("/notifications")}
              aria-label="Notifications"
              className="rounded-full p-2 text-fg transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <BellIcon size={22} />
            </button>
            <button
              onClick={() => router.push("/messages")}
              aria-label="Messages"
              className="rounded-full p-2 text-fg transition hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <MessageIcon size={22} />
            </button>
          </div>
        </header>
      )}

      {/* Content */}
      <main className={`md:pl-[76px] xl:pl-60 ${immersive ? "" : "pb-16 md:pb-8"}`}>
        {children}
      </main>

      {/* Mobile bottom tabs */}
      <nav
        aria-label="Primary"
        className={`fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-edge bg-bg/90 py-1.5 backdrop-blur md:hidden ${
          immersive ? "border-transparent bg-black/40 text-white" : ""
        }`}
      >
        {[
          { href: "/", label: "Home", icon: HomeIcon },
          { href: "/explore", label: "Explore", icon: ExploreIcon },
          { href: "/create", label: "Create", icon: PlusIcon },
          { href: "/reels", label: "Reels", icon: ReelsIcon },
        ].map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-label={label}
            aria-current={isActive(href) ? "page" : undefined}
            className="rounded-xl p-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <Icon size={26} filled={isActive(href)} />
          </Link>
        ))}
        <Link
          href={profileHref}
          aria-label="Profile"
          className="rounded-xl p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Avatar user={me} size="xs" />
        </Link>
      </nav>
    </div>
  );
}
