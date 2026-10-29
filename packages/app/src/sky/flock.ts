// The fleet's sky (THE-2024): the mark's triangles in V formations on the
// night surface. The pure rules below the line marked "copied" come from the
// landing's flock (packages/dashboard/components/landing/flock.ts, THE-887),
// copied, never imported: the colours, the three depths, the V's slots, the
// frame-rate independent easing and the triangle's shape.
//
// Unlike the landing, nothing here wanders: each ship has a place the fleet's
// state gives it (layout.ts) and flies there when that place changes, then
// holds still. Pure: no DOM, no clock; the view (view.ts) steps it with the
// time since the last frame, so it moves the same at 60 Hz and 120 Hz.

// --- copied from packages/dashboard/components/landing/flock.ts ---

/** The mark's colours (components/shell/Logo.tsx). */
export const LIME = "#b6f15a";
export const BONE = "#f0efec";

/** Three depths: far ships are small and faint. */
export const LAYERS = [
  { scale: 0.55, alpha: 0.4 },
  { scale: 0.8, alpha: 0.7 },
  { scale: 1, alpha: 1 },
] as const;

/** A ship's length at size 1, in CSS pixels, before its depth's scale: 4 grid units of the mark. */
export const SHIP = 10;
/** How much longer than the mark's triangle a ship in flight is. */
export const DART = 1.55;
/** The mark's five tones: the lead, the wings, the fainter back ones. */
export const MARK_TONES = [1, 0.92, 0.92, 0.5, 0.5] as const;

/** One step of the V behind the leader, in ship lengths: the mark's own 8.5 back and 6 aside, with some air. */
export const V_BACK = (8.5 / 4) * 1.35;
export const V_SIDE = (6 / 4) * 1.35;

/** Frame-rate independent smoothing: the share of the gap closed in `dt` at `rate` per second. */
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

function angleTo(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Where slot `k` of a V sits behind a leader heading `angle`: `back` and `side` pixels per row. */
export function slotOffset(k: number, angle: number, back: number, side: number): { x: number; y: number } {
  if (k === 0) return { x: 0, y: 0 };
  const row = Math.ceil(k / 2);
  const s = k % 2 ? -1 : 1;
  const b = -row * back;
  const lateral = s * row * side;
  const c = Math.cos(angle);
  const n = Math.sin(angle);
  return { x: b * c - lateral * n, y: b * n + lateral * c };
}

/**
 * The mark's triangle around its centroid, apex forward: 8 units wide and 7
 * long at stretch 1, longer and narrower in flight. `roll` foreshortens its
 * width, as a ship banking shows less of its wings (the landing's ships never bank).
 */
export function trianglePoints(
  x: number,
  y: number,
  angle: number,
  u: number,
  stretch: number,
  roll = 0,
): [number, number, number, number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ax = 4.67 * u * stretch;
  const bx = -2.33 * u * stretch;
  const by = ((4 * u) / stretch ** 0.6) * (0.35 + 0.65 * Math.abs(Math.cos(roll)));
  return [x + ax * c, y + ax * s, x + bx * c - by * s, y + bx * s + by * c, x + bx * c + by * s, y + bx * s - by * c];
}

// --- the sky's own rules ---

/** Pointing up the screen: the mark's own heading. */
export const UP = -Math.PI / 2;

/** Where a ship belongs: its place, its pose and its look, as the layout gives them. */
export interface Pose {
  x: number;
  y: number;
  /** Heading, in radians; 0 points right. */
  angle: number;
  /** Roll, in radians: a blocked ship holds a bank, a ship whose state changes banks through its turn. */
  bank: number;
  /** Size over its depth's. */
  size: number;
  /** Depth: 0 far, 1 middle, 2 near; between two while it flies from one to the other. */
  depth: number;
  stretch: number;
  color: string;
  /** Opacity over its depth's. */
  tone: number;
}

export interface Target extends Pose {
  /** `project/ticket` for an agent, `project/coordinator/k` for the coordinator's ships. */
  key: string;
  /** What the ship stands for: its session's state, or the coordinator. A change makes it bank. */
  group: string;
}

export interface Ship extends Pose {
  key: string;
  group: string;
  vx: number;
  vy: number;
  bankV: number;
  target: Pose;
  /** Its session left the sky (released, or merged on another day): it flies out and is dropped. */
  leaving: boolean;
}

export interface Flock {
  width: number;
  height: number;
  /** In drawing order is the depth order: the view sorts by depth when it draws. */
  ships: Map<string, Ship>;
}

export const createFlock = (): Flock => ({ width: 0, height: 0, ships: new Map() });

/** How hard a ship rolls when its session changes state, in radians per second. */
const BANK_KICK = 7;
/** The roll a blocked ship holds. */
export const BLOCKED_BANK = 0.8;

/**
 * Gives every ship its place. A ship the sky did not hold flies in from below
 * (or is placed, with `still`); one whose group changed banks toward its new
 * place; one with no place any more leaves through the top. With `still`,
 * nothing flies: every ship is put where it belongs (the first paint, a
 * resize, reduced motion).
 */
export function aim(flock: Flock, targets: readonly Target[], { still = false }: { still?: boolean } = {}) {
  const seen = new Set<string>();
  for (const t of targets) {
    seen.add(t.key);
    const pose = poseOf(t);
    const ship = flock.ships.get(t.key);
    if (!ship) {
      flock.ships.set(t.key, {
        ...pose,
        key: t.key,
        group: t.group,
        vx: 0,
        vy: 0,
        bankV: 0,
        target: pose,
        leaving: false,
        // From below the sky, heading up into it.
        ...(still ? {} : { y: flock.height + SHIP * 3, angle: UP, tone: 0 }),
      });
      continue;
    }
    if (ship.group !== t.group && !still) {
      // Roll toward the side it turns to.
      ship.bankV += (t.x >= ship.x ? 1 : -1) * BANK_KICK;
    }
    ship.group = t.group;
    ship.target = pose;
    ship.leaving = false;
    ship.color = t.color;
  }
  for (const ship of flock.ships.values()) {
    if (seen.has(ship.key) || ship.leaving) continue;
    ship.leaving = true;
    ship.target = { ...ship.target, y: -SHIP * 4, angle: UP, bank: 0, tone: 0 };
  }
  if (still) snap(flock);
}

const poseOf = (t: Target): Pose => ({
  x: t.x,
  y: t.y,
  angle: t.angle,
  bank: t.bank,
  size: t.size,
  depth: t.depth,
  stretch: t.stretch,
  color: t.color,
  tone: t.tone,
});

/** Puts every ship where it belongs and drops the ones leaving. */
function snap(flock: Flock) {
  for (const ship of [...flock.ships.values()]) {
    if (ship.leaving) {
      flock.ships.delete(ship.key);
      continue;
    }
    Object.assign(ship, ship.target, { vx: 0, vy: 0, bankV: 0 });
  }
}

/** A spring per ship toward its place: about a second and a half to arrive, without overshoot. */
const PULL = 4;
/** The roll's spring: softer damping, so a ship rocks once through its turn. */
const ROLL = 7;
const ROLL_DAMPING = 0.45;

/**
 * Advances the sky by `dt` seconds (clamped, so a long pause is not a jump).
 * Returns whether anything still moves; once nothing does, every ship is put
 * exactly in place and the view stops asking for frames.
 */
export function step(flock: Flock, rawDt: number): boolean {
  const dt = Math.min(0.05, Math.max(0, rawDt));
  // Integrated in steps of at most 1/120 s: stable at any frame rate.
  const n = Math.max(1, Math.ceil(dt * 120));
  const h = dt / n;
  let moving = false;
  for (const ship of [...flock.ships.values()]) {
    const t = ship.target;
    for (let i = 0; i < n; i++) {
      ship.vx += (PULL * PULL * (t.x - ship.x) - 2 * PULL * ship.vx) * h;
      ship.vy += (PULL * PULL * (t.y - ship.y) - 2 * PULL * ship.vy) * h;
      ship.x += ship.vx * h;
      ship.y += ship.vy * h;
      ship.bankV += (ROLL * ROLL * (t.bank - ship.bank) - 2 * ROLL_DAMPING * ROLL * ship.bankV) * h;
      ship.bank += ship.bankV * h;
    }
    // In flight a ship leans toward where it goes (never more than half way:
    // the squadron keeps its heading); as it slows it turns back to its place's.
    const speed = Math.hypot(ship.vx, ship.vy);
    const flying = Math.min(0.5, Math.max(0, (speed - 20) / 200));
    const heading = t.angle + angleTo(t.angle, Math.atan2(ship.vy, ship.vx)) * flying;
    ship.angle += angleTo(ship.angle, heading) * ease(8, dt);
    const k = ease(3, dt);
    ship.size += (t.size - ship.size) * k;
    ship.depth += (t.depth - ship.depth) * k;
    ship.stretch += (t.stretch - ship.stretch) * k;
    ship.tone += (t.tone - ship.tone) * (ship.leaving ? ease(2, dt) : k);

    if (ship.leaving && (ship.y < -SHIP * 3 || ship.tone < 0.02)) {
      flock.ships.delete(ship.key);
      continue;
    }
    if (!inPlace(ship)) moving = true;
  }
  if (!moving) snap(flock);
  return moving;
}

/** Whether a ship is where it belongs, at rest, close enough to be put there. */
function inPlace(ship: Ship): boolean {
  const t = ship.target;
  return (
    !ship.leaving &&
    Math.abs(t.x - ship.x) < 0.25 &&
    Math.abs(t.y - ship.y) < 0.25 &&
    Math.hypot(ship.vx, ship.vy) < 1 &&
    Math.abs(t.bank - ship.bank) < 0.004 &&
    Math.abs(ship.bankV) < 0.02 &&
    Math.abs(angleTo(ship.angle, t.angle)) < 0.003 &&
    Math.abs(t.size - ship.size) < 0.003 &&
    Math.abs(t.depth - ship.depth) < 0.003 &&
    Math.abs(t.stretch - ship.stretch) < 0.003 &&
    Math.abs(t.tone - ship.tone) < 0.004
  );
}

/** Whether every ship is in place: nothing to fly, no frame to ask for. */
export const atRest = (flock: Flock) => [...flock.ships.values()].every(inPlace);

/** A depth's scale and opacity, between two depths while a ship flies from one to the other. */
export function depthLook(depth: number): { scale: number; alpha: number } {
  const d = Math.min(2, Math.max(0, depth));
  const lo = LAYERS[Math.floor(d) as 0 | 1 | 2];
  const hi = LAYERS[Math.ceil(d) as 0 | 1 | 2];
  const u = d - Math.floor(d);
  return { scale: lo.scale + (hi.scale - lo.scale) * u, alpha: lo.alpha + (hi.alpha - lo.alpha) * u };
}
