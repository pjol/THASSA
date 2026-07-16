import type { UserLite } from "@/lib/types";

const SIZES = { xs: 24, sm: 32, md: 44, lg: 64, xl: 96 } as const;

export function Avatar({
  user,
  size = "md",
  className = "",
}: {
  user: Pick<UserLite, "username" | "avatar_url" | "display_name"> | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  const name = user?.display_name || user?.username || "?";
  if (user?.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatar_url}
        alt={`${name}'s avatar`}
        width={px}
        height={px}
        className={`shrink-0 rounded-full border border-edge object-cover ${className}`}
        style={{ width: px, height: px }}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={`${name}'s avatar`}
      className={`flex shrink-0 select-none items-center justify-center rounded-full bg-brand-soft font-bold uppercase text-brand ${className}`}
      style={{ width: px, height: px, fontSize: px * 0.42 }}
    >
      {name.slice(0, 1)}
    </span>
  );
}
