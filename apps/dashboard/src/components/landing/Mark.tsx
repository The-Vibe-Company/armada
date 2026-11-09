// The Armada mark (design/dashboard-v4/logo.dc.html, "Formation"): five agents in a V, the first leads.
// Carried over from armada-v1-final's components/shell/Logo.tsx, whose v1 shell is not on main.
export const MARK: readonly { d: string; fill: string; opacity?: number }[] = [
  { d: "M16 4.5L20 11.5H12Z", fill: "#b6f15a" },
  { d: "M10 13L14 20H6Z", fill: "#f0efec" },
  { d: "M22 13L26 20H18Z", fill: "#f0efec" },
  { d: "M4 21.5L8 28.5H0Z", fill: "#f0efec", opacity: 0.45 },
  { d: "M28 21.5L32 28.5H24Z", fill: "#f0efec", opacity: 0.45 },
];

/** The Armada mark, at any size. */
export function Mark({ size = 20, className }: { size?: number; className?: string | undefined }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      {MARK.map((s) => (
        <path key={s.d} d={s.d} fill={s.fill} fillOpacity={s.opacity} />
      ))}
    </svg>
  );
}
