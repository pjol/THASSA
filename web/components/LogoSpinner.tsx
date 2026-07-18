import Image from "next/image";

// The Thassa mark spinning — used as the loading indicator wherever a large,
// centered spinner fits (splash / screen / section loaders). The ensō is
// circular, so rotating the logo itself reads as a spinner. Small inline
// spinners inside colored buttons keep the neutral <Spinner> (contrast).
export function LogoSpinner({
  size = 44,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/thassa-logo.svg"
      alt=""
      aria-hidden
      width={size}
      height={size}
      priority
      className={`animate-spin ${className}`}
      style={{ animationDuration: "0.95s" }}
    />
  );
}
