import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** QR code as an SVG path (enrol links, screens/17 Add a till). */
export function QrCode({
  value,
  size = 176,
  label,
}: {
  value: string;
  size?: number;
  label: string;
}) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r += 1)
      for (let c = 0; c < count; c += 1)
        if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    return { path: d, n: count + 4 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      className="rounded-control bg-white"
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
