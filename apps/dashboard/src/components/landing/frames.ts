// One requestAnimationFrame loop for every moving part of the landing
// (THE-887): each registers a callback with the seconds since the last frame,
// and the loop stops when none is active, so nothing runs off screen or in a
// hidden tab (the browser stops rAF there, and a callback's dt is clamped by its owner).

type Frame = (dt: number, now: number) => void;

const active = new Set<Frame>();
let handle = 0;
let last = 0;

function tick(now: number) {
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  for (const f of active) f(dt, now);
  handle = active.size ? requestAnimationFrame(tick) : 0;
  if (!handle) last = 0;
}

/** Runs `f` every frame until the returned stop is called. */
export function onFrame(f: Frame): () => void {
  active.add(f);
  if (!handle) handle = requestAnimationFrame(tick);
  return () => {
    active.delete(f);
  };
}

/** Whether the viewer asked for less motion. */
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Calls `run(true)` while `el` is on screen and the tab is visible, `run(false)` otherwise.
 * Returns the cleanup.
 */
export function whileVisible(el: Element, run: (on: boolean) => void, rootMargin = "0px"): () => void {
  let seen = false;
  let on = false;
  const update = () => {
    const next = seen && document.visibilityState === "visible";
    if (next !== on) {
      on = next;
      run(on);
    }
  };
  const io = new IntersectionObserver(
    ([entry]) => {
      seen = !!entry?.isIntersecting;
      update();
    },
    { rootMargin },
  );
  io.observe(el);
  document.addEventListener("visibilitychange", update);
  return () => {
    io.disconnect();
    document.removeEventListener("visibilitychange", update);
    if (on) run(false);
  };
}
