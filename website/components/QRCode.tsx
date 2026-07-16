import qrcode from "qrcode-generator";

// Statically generated inline SVG QR (rendered at build time — no client JS).
// Styling follows the repo QR treatment: brand-gradient tile, rounded modules.
export default function QRCode({ value, size = 220 }: { value: string; size?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const total = count + quiet * 2;
  const cell = size / total;

  const rects: JSX.Element[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={(c + quiet) * cell + cell * 0.06}
            y={(r + quiet) * cell + cell * 0.06}
            width={cell * 0.88}
            height={cell * 0.88}
            rx={cell * 0.24}
          />
        );
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`QR code linking to ${value}`}
      className="h-auto w-full max-w-[220px]"
    >
      <defs>
        <linearGradient id="thassa-qr-bg" x1="0" y1="0" x2={size} y2={size} gradientUnits="userSpaceOnUse">
          <stop stopColor="#081528" />
          <stop offset="1" stopColor="#307CDE" />
        </linearGradient>
      </defs>
      <rect width={size} height={size} rx={size * 0.08} fill="url(#thassa-qr-bg)" />
      <g fill="#FFFFFF">{rects}</g>
    </svg>
  );
}
