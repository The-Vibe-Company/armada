// The Armada mark (design/dashboard-v4/logo.dc.html, "Formation"): five agents in a V, the first leads.
// MARK is its one source: the sidebar draws it here, and `bun run icons` (scripts/icons.ts) builds the
// browser's icons from it, so the two never drift apart.
export const MARK: readonly { d: string; fill: string; opacity?: number }[] = [
  { d: "M16 4.5L20 11.5H12Z", fill: "#b6f15a" },
  { d: "M10 13L14 20H6Z", fill: "#f0efec" },
  { d: "M22 13L26 20H18Z", fill: "#f0efec" },
  { d: "M4 21.5L8 28.5H0Z", fill: "#f0efec", opacity: 0.45 },
  { d: "M28 21.5L32 28.5H24Z", fill: "#f0efec", opacity: 0.45 },
];

/** The mark's shapes as SVG markup (the leading `count` of them), in its 32 × 32 grid. */
export function markSvg(count = MARK.length): string {
  return MARK.slice(0, count)
    .map((s) => `<path d="${s.d}" fill="${s.fill}"${s.opacity === undefined ? "" : ` fill-opacity="${s.opacity}"`}/>`)
    .join("");
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="sh-logo">
      {MARK.map((s) => (
        <path key={s.d} d={s.d} fill={s.fill} fillOpacity={s.opacity} />
      ))}
    </svg>
  );
}

/** The search glass of the sidebar and the palette. */
export function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ flex: "none" }}>
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
