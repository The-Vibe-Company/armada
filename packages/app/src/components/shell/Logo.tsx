// The Armada mark ("Formation": five agents in a V, the first leads), copied
// from packages/dashboard/components/shell/Logo.tsx.
const MARK: readonly { d: string; fill: string; opacity?: number }[] = [
  { d: "M16 4.5L20 11.5H12Z", fill: "#b6f15a" },
  { d: "M10 13L14 20H6Z", fill: "#f0efec" },
  { d: "M22 13L26 20H18Z", fill: "#f0efec" },
  { d: "M4 21.5L8 28.5H0Z", fill: "#f0efec", opacity: 0.45 },
  { d: "M28 21.5L32 28.5H24Z", fill: "#f0efec", opacity: 0.45 },
];

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="flex-none">
      {MARK.map((s) => (
        <path key={s.d} d={s.d} fill={s.fill} fillOpacity={s.opacity} />
      ))}
    </svg>
  );
}
