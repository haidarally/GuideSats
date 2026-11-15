// QR code for the meeting code, drawn as one SVG path (no innerHTML, CSP-safe).
import { encode } from "uqr";

export function Qr({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const { data } = encode(value, { ecc: "M", border: 2 });
  const n = data.length;
  let d = "";
  data.forEach((row, y) => row.forEach((on, x) => (d += on ? `M${x} ${y}h1v1h-1z` : "")));
  return (
    <svg class="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shape-rendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
