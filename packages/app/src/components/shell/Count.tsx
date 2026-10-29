import { AnimatePresence, m } from "motion/react";

/**
 * A count that moved says so: the new number slides in once (README: movement
 * always says something). Nothing on the first paint, nothing that loops.
 */
export function Count({ value, className }: { value: number; className?: string }) {
  return (
    <span className={`relative inline-grid overflow-hidden font-mono text-label text-text-3 tnum ${className ?? ""}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <m.span
          key={value}
          className="col-start-1 row-start-1"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
        >
          {value}
        </m.span>
      </AnimatePresence>
    </span>
  );
}
