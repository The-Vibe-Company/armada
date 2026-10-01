import { MARK } from "@/components/shell/Logo";

/** The Armada mark, at any size, from the one source the dashboard and its icons use. */
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      {MARK.map((s) => (
        <path key={s.d} d={s.d} fill={s.fill} fillOpacity={s.opacity} />
      ))}
    </svg>
  );
}
