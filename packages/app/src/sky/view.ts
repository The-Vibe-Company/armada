// The sky's frames (THE-2024): it asks its clock for a frame only while a
// ship moves, and stops once every ship is in place, so a still fleet costs
// nothing and nothing loops. The clock is injected: the browser's animation
// frames in the app, a hand-turned one in tests.
import { drawSky, type SkyContext } from "./draw";
import { aim, atRest, createFlock, type Flock, step } from "./flock";
import type { SkyLayout } from "./layout";

/** Calls `run` once, on the next frame, with the frame's time in milliseconds; returns a cancel. */
export interface SkyClock {
  frame(run: (now: number) => void): () => void;
}

export const animationFrames: SkyClock = {
  frame(run) {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  },
};

export interface SkyView {
  readonly flock: Flock;
  /** The sky's size in CSS pixels and the device's pixel ratio. */
  resize(width: number, height: number, dpr: number): void;
  /**
   * The fleet's places. `still` puts every ship there without flying: the
   * first paint, a resize, or reduced motion.
   */
  show(layout: SkyLayout, opts?: { still?: boolean }): void;
  /** Whether it asked its clock for a frame: something is moving. */
  readonly moving: boolean;
  stop(): void;
}

export function createSkyView(ctx: SkyContext, clock: SkyClock): SkyView {
  const flock = createFlock();
  let layout: SkyLayout = { targets: [], arcs: [], labels: [] };
  let dpr = 1;
  let cancel: (() => void) | null = null;
  let last: number | null = null;
  let shown = false;

  const draw = () => drawSky(ctx, flock, layout.arcs, dpr);
  const frame = (now: number) => {
    cancel = null;
    // The first frame of a flight has no frame before it: one 60 Hz frame.
    const dt = last === null ? 1 / 60 : (now - last) / 1000;
    last = now;
    const moving = step(flock, dt);
    draw();
    if (moving) cancel = clock.frame(frame);
    else last = null;
  };

  return {
    flock,
    get moving() {
      return cancel !== null;
    },
    resize(width, height, ratio) {
      flock.width = width;
      flock.height = height;
      dpr = ratio;
    },
    show(next, { still = false } = {}) {
      layout = next;
      // Nothing moves on the first paint.
      const put = still || !shown;
      shown = true;
      aim(flock, next.targets, { still: put });
      if (put) {
        cancel?.();
        cancel = null;
        last = null;
        draw();
        return;
      }
      // The same places as before: nothing flies, nothing to draw again.
      if (!cancel && !atRest(flock)) cancel = clock.frame(frame);
    },
    stop() {
      cancel?.();
      cancel = null;
    },
  };
}
