"use client";

// Scroll-scrubbed progress (THE-887): sets `--p` (0 to 1) on the element it
// wraps as the page scrolls through it, and `data-step` to the step reached.
// The value follows the scroll through a short spring, so a wheel's steps
// glide instead of jumping, and it is interruptible: scrolling back runs the
// story backwards. Nothing re-renders: the scenes read `--p` in CSS.
// With reduced motion it sets nothing: the CSS shows each step still.
import { type ReactNode, useEffect, useRef } from "react";
import { onFrame, prefersReducedMotion } from "./frames";

export function Scrub({
  steps,
  className,
  id,
  label,
  children,
}: {
  steps: number;
  className?: string;
  id?: string;
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    let shown = 0;
    let target = 0;
    let step = -1;
    const read = () => {
      const r = el.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      target = run > 0 ? Math.min(1, Math.max(0, -r.top / run)) : 0;
    };
    const write = (p: number) => {
      el.style.setProperty("--p", p.toFixed(4));
      const next = Math.min(steps - 1, Math.floor(p * steps));
      if (next !== step) {
        step = next;
        el.dataset.step = String(step);
      }
    };
    read();
    shown = target;
    write(shown);
    // The loop runs while the value moves, and stops once it caught up with the scroll.
    let stop: (() => void) | null = null;
    const frame = (dt: number) => {
      read();
      // A spring toward the scroll position: fast enough to feel attached, soft enough to glide.
      shown += (target - shown) * (1 - Math.exp(-14 * Math.min(dt, 0.05)));
      const settled = Math.abs(target - shown) < 0.0005;
      if (settled) shown = target;
      write(shown);
      if (settled && stop) {
        stop();
        stop = null;
      }
    };
    const scroll = () => {
      if (!stop) stop = onFrame(frame);
    };
    // A resize or a jump to an anchor: catch up at once.
    const jump = () => {
      read();
      shown = target;
      write(shown);
    };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", jump);
    window.addEventListener("hashchange", jump);
    return () => {
      stop?.();
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", jump);
      window.removeEventListener("hashchange", jump);
    };
  }, [steps]);

  return (
    <section ref={ref} className={className} id={id} aria-label={label} data-step="0" style={{ ["--p" as string]: 0 }}>
      {children}
    </section>
  );
}
