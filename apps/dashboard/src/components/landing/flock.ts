// The landing's sky (THE-887): squadrons of Armada ships, each ship the mark's
// triangle, each squadron a V like the mark. Pure: no DOM, no clock. The
// canvas (Sky.tsx) steps it with the time since the last frame, so it moves
// the same at 60 Hz and 120 Hz, and draws what it holds.
//
// On load, five ships fly in and settle into the mark itself. The mark then
// breaks: its five ships peel off on their own headings while squadrons fly in
// from the edges, and they join the flock. Squadrons cruise with the wind,
// lean softly toward the pointer, split in two now and then and regroup when
// they meet.

/** The mark's colors (components/shell/Logo.tsx) and the harnesses' (globals.css `--h-*`). */
export const LIME = "#b6f15a";
export const BONE = "#f0efec";
export const HARNESS_COLORS = ["#bb87fc", "#d97757", "#10a37f"] as const;

/** Three depths: far ships are small, slow and faint. */
export const LAYERS = [
  { scale: 0.55, speed: 0.6, alpha: 0.4 },
  { scale: 0.8, speed: 0.8, alpha: 0.7 },
  { scale: 1, speed: 1, alpha: 1 },
] as const;

export interface Ship {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Heading, in radians; 0 points right. */
  angle: number;
  /** Size over its layer's; the mark's ships start large. */
  size: number;
  /** The size it settles to: the mark's five stay a little larger than the flock, its flagships. */
  rest: number;
  /**
   * Length over the mark's triangle, which is nearly equilateral and so shows
   * no heading: 1 in the mark, a slender dart in flight.
   */
  stretch: number;
  color: string;
  /** Opacity over its layer's: the mark's back ships are fainter, as on the mark. */
  tone: number;
  /** Recent positions for the wake, newest first. */
  wake: { x: number; y: number }[];
}

export interface Squadron {
  id: number;
  layer: 0 | 1 | 2;
  /** ships[0] leads; the others hold the V's slots in order. */
  ships: Ship[];
  /** The phase of the leader's wandering. */
  wander: number;
  /** Seconds before this squadron may split or merge again. */
  calm: number;
  /** A burst of speed that decays: a launch, an arrival, the mark's break. */
  boost: number;
  /** A heading it holds while its boost lasts (the mark's break), instead of wandering. */
  bearing: number | null;
}

export interface Ripple {
  x: number;
  y: number;
  age: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SkyState {
  width: number;
  height: number;
  time: number;
  squadrons: Squadron[];
  ripples: Ripple[];
  /** The pointer, smoothed by a spring; null when away. */
  pointer: { x: number; y: number; vx: number; vy: number; tx: number; ty: number } | null;
  /** The intro: the mark's squadron flies to `anchor` and holds. Null once the mark broke. */
  intro: { anchor: { x: number; y: number }; scale: number; squadron: number } | null;
  /** When squadrons fly in from the edges, in seconds of sky time, soonest first. */
  arrivals: number[];
  /** Where the hero's words are: ships dim while they cross it. */
  quiet: Box | null;
  nextId: number;
  /** A deterministic random source, so the sky is the same on every load and in tests. */
  seed: number;
  /** How many ships the sky holds at most, from its area. */
  cap: number;
  /** When a squadron next splits, in sky time: drawn per split, not per frame, so 60 Hz and 120 Hz agree. */
  nextSplit: number;
}

/** The intro's schedule, in seconds of sky time: arrival, hold, then the break. */
export const INTRO = { arrive: 1.3, hold: 0.6 } as const;
export const BREAK_AT = INTRO.arrive + INTRO.hold;

/** The mark's five triangles: centroids relative to the leader's, in its 32-unit grid, pointing up. */
const MARK_SLOTS = [
  { x: 0, y: 0 },
  { x: -6, y: 8.5 },
  { x: 6, y: 8.5 },
  { x: -12, y: 17 },
  { x: 12, y: 17 },
];
const MARK_TONES = [1, 0.92, 0.92, 0.5, 0.5];

/**
 * One step of the V behind the leader, in ship lengths (a length is 4 of the
 * mark's grid units): the mark's own 8.5 back and 6 aside, with some air.
 */
const V_BACK = (8.5 / 4) * 1.35;
const V_SIDE = (6 / 4) * 1.35;
/** A ship's length at size 1, in CSS pixels, before its layer's scale: 4 grid units of the mark. */
export const SHIP = 10;
/** How much longer than the mark's triangle a ship in flight is. */
export const DART = 1.55;
const CRUISE = 66;

function random(s: SkyState): number {
  // mulberry32
  s.seed = (s.seed + 0x6d2b79f5) | 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Frame-rate independent smoothing: the share of the gap closed in `dt` at `rate` per second. */
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export function angleTo(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Where slot `k` of a V sits behind a leader heading `angle`, at ship length `len`. */
export function slotOffset(k: number, angle: number, len: number): { x: number; y: number } {
  if (k === 0) return { x: 0, y: 0 };
  const row = Math.ceil(k / 2);
  const side = k % 2 ? -1 : 1;
  const back = -row * V_BACK * len;
  const lateral = side * row * V_SIDE * len;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: back * c - lateral * s, y: back * s + lateral * c };
}

/** The wind: squadrons drift left to right and a little up, its direction turning slowly. */
const wind = (time: number) => -0.18 + Math.sin(time * 0.045) * 0.14;

/** The ships a sky this size holds: fewer on a phone. */
export const capOf = (width: number, height: number) =>
  Math.round(Math.max(20, Math.min(80, (width * height) / 16_000)));

export const shipCount = (s: SkyState) => s.squadrons.reduce((n, q) => n + q.ships.length, 0);

const pickColor = (s: SkyState) => HARNESS_COLORS[Math.floor(random(s) * HARNESS_COLORS.length)] ?? BONE;

function addSquadron(
  s: SkyState,
  layer: 0 | 1 | 2,
  x: number,
  y: number,
  angle: number,
  count: number,
  color = pickColor(s),
): Squadron {
  const speed = CRUISE * LAYERS[layer].speed;
  const len = SHIP * LAYERS[layer].scale;
  const ships: Ship[] = [];
  for (let k = 0; k < count; k++) {
    const o = slotOffset(k, angle, len);
    ships.push({
      x: x + o.x,
      y: y + o.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      angle,
      size: 1,
      rest: 1,
      stretch: DART,
      color,
      tone: 1,
      wake: [],
    });
  }
  const sq: Squadron = {
    id: s.nextId++,
    layer,
    ships,
    wander: random(s) * 100,
    calm: 3 + random(s) * 4,
    boost: 0,
    bearing: null,
  };
  s.squadrons.push(sq);
  return sq;
}

export function createSky(
  width: number,
  height: number,
  opts: { anchor: { x: number; y: number }; markScale: number; seed?: number; intro?: boolean },
): SkyState {
  const s: SkyState = {
    width,
    height,
    time: 0,
    squadrons: [],
    ripples: [],
    pointer: null,
    intro: null,
    arrivals: [],
    quiet: null,
    nextId: 1,
    seed: opts.seed ?? 887,
    cap: capOf(width, height),
    nextSplit: BREAK_AT + 4,
  };
  const playIntro = opts.intro ?? true;

  // The mark's five ships: lime leader, bone wings, fainter back ones.
  const mark = addSquadron(s, 2, opts.anchor.x, opts.anchor.y, -Math.PI / 2, 5, BONE);
  mark.ships.forEach((sh, k) => {
    sh.color = k === 0 ? LIME : BONE;
    sh.tone = MARK_TONES[k] ?? 1;
    sh.size = opts.markScale;
    sh.rest = 1.35;
    sh.stretch = 1;
  });
  mark.calm = 1e9;
  s.intro = { anchor: opts.anchor, scale: opts.markScale, squadron: mark.id };
  placeMark(s, playIntro ? 0 : 1);

  // Squadrons already in the sky, mostly away from the words, so it is never empty, even before the mark lands.
  const already = Math.max(3, Math.round(s.cap / 10));
  for (let k = 0; k < already; k++) {
    const layer = (k % 2) as 0 | 1;
    const angle = wind(0) + (random(s) - 0.5) * 0.5;
    const x = width * (0.3 + random(s) * 0.7);
    addSquadron(s, layer, x, height * (0.08 + random(s) * 0.84), angle, 3 + Math.floor(random(s) * 3));
  }
  // The flock flies in as the mark breaks.
  const incoming = Math.max(5, Math.round(s.cap / 5));
  for (let k = 0; k < incoming; k++) s.arrivals.push(BREAK_AT - 0.6 + k * (2.2 / incoming) + random(s) * 0.15);
  // The still sky: the mark in place, the flock already spread out.
  if (!playIntro) while (s.arrivals.length) arrive(s, true);
  return s;
}

/** A squadron flying in from the left or the bottom edge (or placed anywhere, for the still sky). */
function arrive(s: SkyState, anywhere = false) {
  s.arrivals.shift();
  if (shipCount(s) >= s.cap) return;
  const r = random(s);
  const layer = (r < 0.15 ? 0 : r < 0.55 ? 1 : 2) as 0 | 1 | 2;
  const count = 3 + Math.floor(random(s) * 3);
  if (anywhere) {
    const angle = wind(0) + (random(s) - 0.5) * 0.6;
    addSquadron(s, layer, s.width * (0.05 + random(s) * 0.9), s.height * (0.1 + random(s) * 0.8), angle, count);
    return;
  }
  const fromLeft = random(s) < 0.4;
  const x = fromLeft ? -50 : s.width * (0.3 + random(s) * 0.65);
  const y = fromLeft ? s.height * (0.15 + random(s) * 0.7) : s.height + 50;
  const angle = fromLeft ? wind(s.time) + (random(s) - 0.5) * 0.6 : -1.15 + (random(s) - 0.5) * 0.5;
  const sq = addSquadron(s, layer, x, y, angle, count);
  sq.boost = fromLeft ? 1.3 : 0.9;
  sq.bearing = angle;
}

/** The mark's squadron during the intro: along its path at `u` (0 to 1 of the arrival). */
function placeMark(s: SkyState, u: number) {
  const intro = s.intro;
  const sq = intro && s.squadrons.find((q) => q.id === intro.squadron);
  if (!intro || !sq) return;
  const { anchor, scale } = intro;
  // A curve from below the left of the sky, sweeping under the anchor, settling on it.
  const p0 = { x: anchor.x - s.width * 0.55, y: s.height * 1.15 };
  const p1 = { x: anchor.x + s.width * 0.02, y: anchor.y + s.height * 0.42 };
  const p2 = anchor;
  const e = easeOutCubic(Math.min(1, u));
  const a = 1 - e;
  const x = a * a * p0.x + 2 * a * e * p1.x + e * e * p2.x;
  const y = a * a * p0.y + 2 * a * e * p1.y + e * e * p2.y;
  // Heading: along the path; the path itself ends pointing up, as the mark does.
  const dx = 2 * a * (p1.x - p0.x) + 2 * e * (p2.x - p1.x);
  const dy = 2 * a * (p1.y - p0.y) + 2 * e * (p2.y - p1.y);
  const along = Math.atan2(dy, dx);
  const up = -Math.PI / 2;
  const angle = along + angleTo(along, up) * easeInOutCubic(Math.min(1, u * 1.15));
  const unit = (SHIP * scale) / 4;
  const r = angle - up;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  sq.ships.forEach((sh, k) => {
    const slot = MARK_SLOTS[k] ?? { x: 0, y: 0 };
    // The V flies in open and closes up as it lands, each ship a beat after the one ahead.
    const lag = Math.max(0, Math.min(1, (u - 0.04 * k) / (1 - 0.04 * k)));
    const spread = 1 + (1 - easeOutCubic(lag)) * 0.9;
    sh.x = x + (slot.x * c - slot.y * sn) * unit * spread;
    sh.y = y + (slot.x * sn + slot.y * c) * unit * spread;
    sh.angle = angle;
  });
}

/**
 * The mark breaks: its five ships peel off on their own headings (the leader
 * straight up, the wings and the back ones fanning out), shrinking to the
 * flock's size, and fly on as squadrons of one until they meet others.
 */
function breakMark(s: SkyState) {
  const intro = s.intro;
  const sq = intro && s.squadrons.find((q) => q.id === intro.squadron);
  s.intro = null;
  if (!sq) return;
  s.squadrons = s.squadrons.filter((q) => q !== sq);
  const up = -Math.PI / 2;
  const fan = [up, up - 0.55, up + 0.55, up - 1.25, up + 1.25];
  sq.ships.forEach((sh, k) => {
    const bearing = fan[k] ?? up;
    sh.vx = Math.cos(bearing) * CRUISE * 0.6;
    sh.vy = Math.sin(bearing) * CRUISE * 0.6;
    s.squadrons.push({
      id: s.nextId++,
      layer: 2,
      ships: [sh],
      wander: random(s) * 100,
      calm: 2.5 + k * 0.4,
      boost: 1.2,
      bearing,
    });
  });
}

/** Advances the sky by `dt` seconds (clamped, so a long pause is not a jump). */
export function step(s: SkyState, rawDt: number) {
  const dt = Math.min(0.05, Math.max(0, rawDt));
  s.time += dt;

  // The pointer: a critically damped spring toward where it is, so leaning on it has momentum.
  const p = s.pointer;
  if (p) {
    const w = 8;
    p.vx += (w * w * (p.tx - p.x) - 2 * w * p.vx) * dt;
    p.vy += (w * w * (p.ty - p.y) - 2 * w * p.vy) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  while (s.arrivals.length && (s.arrivals[0] ?? Number.POSITIVE_INFINITY) <= s.time) arrive(s);

  const intro = s.intro;
  if (intro) {
    if (s.time < INTRO.arrive) placeMark(s, s.time / INTRO.arrive);
    else if (s.time < BREAK_AT) {
      placeMark(s, 1);
      // A breath while it holds: the whole mark lifts by a couple of pixels and settles.
      const lift = Math.sin(((s.time - INTRO.arrive) / INTRO.hold) * Math.PI) * 2.5;
      const sq = s.squadrons.find((q) => q.id === intro.squadron);
      for (const sh of sq?.ships ?? []) sh.y -= lift;
    } else breakMark(s);
  }

  for (const sq of s.squadrons) {
    if (s.intro?.squadron !== sq.id) {
      steerLeader(s, sq, dt);
      followLeader(sq, dt);
    }
    recordWake(sq);
  }

  splitAndMerge(s, dt);
  wrap(s);

  for (const r of s.ripples) r.age += dt;
  s.ripples = s.ripples.filter((r) => r.age < 0.9);
}

function steerLeader(s: SkyState, sq: Squadron, dt: number) {
  const lead = sq.ships[0];
  if (!lead) return;
  const layer = LAYERS[sq.layer];
  sq.boost = Math.max(0, sq.boost - dt * 0.55);
  if (sq.boost === 0) sq.bearing = null;
  // The mark's ships shrink to the flock's size and stretch into darts as they leave it.
  for (const sh of sq.ships) {
    if (sh.size > sh.rest) sh.size = Math.max(sh.rest, sh.size - (sh.size - sh.rest) * ease(1.6, dt) - dt * 0.05);
    if (sh.stretch < DART) sh.stretch = Math.min(DART, sh.stretch + (DART - sh.stretch) * ease(4, dt) + dt * 0.02);
  }
  const speed = CRUISE * layer.speed * (1 + sq.boost * 1.4);
  // Wander around the wind: two slow waves per squadron; a bearing wins while the boost lasts.
  const t = s.time + sq.wander;
  const wandering = wind(s.time) + Math.sin(t * 0.29) * 0.5 + Math.sin(t * 0.11 + 1.7) * 0.32;
  let heading = wandering;
  if (sq.bearing !== null) heading = sq.bearing + angleTo(sq.bearing, wandering) * (1 - Math.min(1, sq.boost));
  else {
    // Steer back into the sky's height rather than skimming its top or bottom edge.
    const margin = s.height * 0.1;
    if (lead.y < margin) heading += ((margin - lead.y) / margin) * 0.8;
    if (lead.y > s.height - margin) heading -= ((lead.y - (s.height - margin)) / margin) * 0.8;
  }
  let dx = Math.cos(heading) * speed;
  let dy = Math.sin(heading) * speed;

  // Lean toward the pointer: the near layer most, never straight at it (they circle it).
  const p = s.pointer;
  if (p) {
    const ax = p.x - lead.x;
    const ay = p.y - lead.y;
    const d = Math.hypot(ax, ay);
    const reach = 340 * (0.45 + layer.scale * 0.55);
    if (d < reach && d > 1) {
      const pull = (1 - d / reach) ** 1.5 * (0.3 + sq.layer * 0.3);
      // Toward it far away, around it close by: a circle rather than a pile-up.
      const around = Math.min(1, 110 / d);
      dx += ((ax / d) * (1 - around) - (ay / d) * around) * speed * pull * 2.4;
      dy += ((ay / d) * (1 - around) + (ax / d) * around) * speed * pull * 2.4;
    }
  }

  // Keep clear of other squadrons of the same depth.
  for (const other of s.squadrons) {
    if (other === sq || other.layer !== sq.layer) continue;
    const o = other.ships[0];
    if (!o) continue;
    const ax = lead.x - o.x;
    const ay = lead.y - o.y;
    const d = Math.hypot(ax, ay);
    const room = 64 * layer.scale;
    if (d < room && d > 0.1) {
      dx += (ax / d) * (room - d) * 1.2;
      dy += (ay / d) * (room - d) * 1.2;
    }
  }

  const k = ease(2.2, dt);
  lead.vx += (dx - lead.vx) * k;
  lead.vy += (dy - lead.vy) * k;
  lead.x += lead.vx * dt;
  lead.y += lead.vy * dt;
  if (Math.hypot(lead.vx, lead.vy) > 1) lead.angle += angleTo(lead.angle, Math.atan2(lead.vy, lead.vx)) * ease(7, dt);
}

function followLeader(sq: Squadron, dt: number) {
  const lead = sq.ships[0];
  if (!lead) return;
  // A spring per ship toward its slot: stiff enough to hold the V, soft enough to swing on a turn.
  const w = 5;
  // Integrated in steps of at most 1/120 s: stable at any frame rate.
  const n = Math.max(1, Math.ceil(dt * 120));
  const h = dt / n;
  for (let k = 1; k < sq.ships.length; k++) {
    const sh = sq.ships[k];
    if (!sh) continue;
    const len = SHIP * LAYERS[sq.layer].scale * Math.max(lead.size, sh.size);
    const o = slotOffset(k, lead.angle, len);
    const tx = lead.x + o.x;
    const ty = lead.y + o.y;
    for (let i = 0; i < n; i++) {
      sh.vx += (w * w * (tx - sh.x) - 2 * w * (sh.vx - lead.vx)) * h;
      sh.vy += (w * w * (ty - sh.y) - 2 * w * (sh.vy - lead.vy)) * h;
      sh.x += sh.vx * h;
      sh.y += sh.vy * h;
    }
    // A follower turns to its leader's heading, so the V reads as one shape.
    sh.angle += angleTo(sh.angle, lead.angle) * ease(7, dt);
  }
}

const WAKE_LENGTH = 8;
function recordWake(sq: Squadron) {
  for (const sh of sq.ships) {
    const last = sh.wake[0];
    if (!last || Math.hypot(last.x - sh.x, last.y - sh.y) > 3) {
      sh.wake.unshift({ x: sh.x, y: sh.y });
      if (sh.wake.length > WAKE_LENGTH) sh.wake.pop();
    }
  }
}

/** Now and then a squadron splits in two; two small ones that meet regroup. */
function splitAndMerge(s: SkyState, dt: number) {
  for (const sq of s.squadrons) sq.calm -= dt;
  const ready = s.squadrons.filter((q) => q.calm <= 0);
  // Regroup: two of the same depth whose leaders fly close and roughly the same way.
  for (const a of ready) {
    for (const b of ready) {
      if (a === b || a.layer !== b.layer || a.ships.length + b.ships.length > 7) continue;
      const la = a.ships[0];
      const lb = b.ships[0];
      if (!la || !lb) continue;
      const d = Math.hypot(la.x - lb.x, la.y - lb.y);
      if (d < 130 * LAYERS[a.layer].scale && Math.abs(angleTo(la.angle, lb.angle)) < 1.1) {
        const [big, small] = a.ships.length >= b.ships.length ? [a, b] : [b, a];
        big.ships.push(...small.ships);
        big.calm = 6 + random(s) * 5;
        big.boost = Math.max(big.boost, small.boost * 0.5);
        s.squadrons = s.squadrons.filter((q) => q !== small);
        return;
      }
    }
  }
  // Split: now and then, one wing of a long V breaks away and turns off to its side.
  const long = ready.filter((q) => q.ships.length >= 4);
  if (!long.length || s.time < s.nextSplit) return;
  s.nextSplit = s.time + 2.5 + random(s) * 4;
  const sq = long[Math.floor(random(s) * long.length)];
  if (!sq) return;
  const leaving = sq.ships.filter((_, k) => k % 2 === 1);
  const lead = leaving[0];
  if (!lead || leaving.length < 2 || sq.ships.length - leaving.length < 2) return;
  sq.ships = sq.ships.filter((sh) => !leaving.includes(sh));
  sq.calm = 7 + random(s) * 4;
  s.squadrons.push({
    id: s.nextId++,
    layer: sq.layer,
    ships: leaving,
    wander: random(s) * 100,
    calm: 7 + random(s) * 4,
    boost: 0.5,
    bearing: lead.angle - 0.6,
  });
}

/** A squadron that leaves the sky comes back on the other side, at a new height. */
function wrap(s: SkyState) {
  const m = 90;
  for (const sq of s.squadrons) {
    const lead = sq.ships[0];
    if (!lead) continue;
    let dx = 0;
    let dy = 0;
    if (lead.x > s.width + m) dx = -(s.width + 2 * m);
    else if (lead.x < -m && lead.vx < 0) dx = s.width + 2 * m;
    else if (lead.y < -m) {
      // Out through the top: back in from the left, lower down.
      dx = -m - lead.x;
      dy = s.height * (0.3 + random(s) * 0.6) - lead.y;
    } else if (lead.y > s.height + m && lead.vy > 0) dy = -(s.height + 2 * m);
    if (!dx && !dy) continue;
    if (dx && !dy) dy = s.height * (0.12 + random(s) * 0.76) - lead.y;
    for (const sh of sq.ships) {
      sh.x += dx;
      sh.y += dy;
      sh.wake = [];
    }
  }
}

/** Moves the pointer the squadrons lean toward; null when it leaves the sky. */
export function point(s: SkyState, at: { x: number; y: number } | null) {
  if (!at) {
    s.pointer = null;
    return;
  }
  if (!s.pointer) s.pointer = { x: at.x, y: at.y, vx: 0, vy: 0, tx: at.x, ty: at.y };
  s.pointer.tx = at.x;
  s.pointer.ty = at.y;
}

/** A click launches a new squadron from where it landed, up and away, with a ripple. */
export function launch(s: SkyState, x: number, y: number) {
  s.ripples.push({ x, y, age: 0 });
  const bearing = -1 + (random(s) - 0.5) * 0.9;
  const color = random(s) < 0.3 ? LIME : pickColor(s);
  const sq = addSquadron(s, 2, x, y, bearing, 3 + Math.floor(random(s) * 3), color);
  // Every ship starts on the point and fans out to its slot.
  for (const sh of sq.ships) {
    sh.x = x;
    sh.y = y;
  }
  sq.boost = 1.1;
  sq.bearing = bearing;
  sq.calm = 4;
  // Past the cap, the oldest far squadrons leave.
  while (shipCount(s) > s.cap + 14) {
    const far = s.squadrons.findIndex((q) => q.layer === 0);
    if (far < 0) break;
    s.squadrons.splice(far, 1);
  }
}

/** A new size for the sky (a resize): positions scale with it, and the mark's anchor moves. */
export function resize(
  s: SkyState,
  width: number,
  height: number,
  anchor: { x: number; y: number },
  markScale: number,
) {
  const fx = width / (s.width || width);
  const fy = height / (s.height || height);
  for (const sq of s.squadrons)
    for (const sh of sq.ships) {
      sh.x *= fx;
      sh.y *= fy;
      sh.wake = [];
    }
  s.width = width;
  s.height = height;
  s.cap = capOf(width, height);
  if (s.intro) {
    s.intro.anchor = anchor;
    s.intro.scale = markScale;
  }
}

/** How much a ship at (x, y) dims over the hero's words: 1 outside, down to 0.3 well inside. */
export function quietness(s: SkyState, x: number, y: number): number {
  const q = s.quiet;
  if (!q) return 1;
  const inside = Math.min(x - q.x, q.x + q.width - x, y - q.y, q.y + q.height - y);
  if (inside <= 0) return 1;
  return 1 - Math.min(1, inside / 60) * 0.7;
}
