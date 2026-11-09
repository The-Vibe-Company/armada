"use client";

// The hero's sky (THE-887): one canvas drawing the squadrons of flock.ts. It
// steps the simulation with the real time between frames, so it moves the
// same at 60 Hz and 120 Hz; it runs only while the hero is on screen and the
// tab is visible. The mark lands on the `[data-mark]` box of the hero, so CSS
// decides where it sits on a phone and on a laptop. With reduced motion it
// draws one still sky, the mark already in place.
import { useEffect, useRef } from "react";
import {
  createSky,
  INTRO,
  LAYERS,
  LIME,
  launch,
  point,
  quietness,
  resize,
  SHIP,
  type SkyState,
  type Squadron,
  step,
} from "./flock";
import { onFrame, prefersReducedMotion, whileVisible } from "./frames";

/** The mark's width in the sky's units: 32 grid units of SHIP / 4 pixels at scale 1. */
const MARK_WIDTH = 32 * (SHIP / 4);

/** The hero's words, in the sky's coordinates: ships dim while they cross them. */
function quietOf(canvas: HTMLCanvasElement) {
  const words = canvas.parentElement?.querySelector<HTMLElement>("[data-quiet]");
  if (!words) return null;
  const c = canvas.getBoundingClientRect();
  const b = words.getBoundingClientRect();
  return { x: b.left - c.left - 24, y: b.top - c.top - 24, width: b.width + 48, height: b.height + 48 };
}

function anchorOf(canvas: HTMLCanvasElement) {
  const box = canvas.parentElement?.querySelector<HTMLElement>("[data-mark]");
  const c = canvas.getBoundingClientRect();
  if (!box) return { anchor: { x: c.width * 0.72, y: c.height * 0.42 }, scale: 5 };
  const b = box.getBoundingClientRect();
  const scale = Math.max(2.4, b.width / MARK_WIDTH);
  // The leader's centroid sits 7.33 grid units above the mark's middle (its paths span 4.5 to 28.5).
  const unit = (SHIP * scale) / 4;
  return {
    anchor: { x: b.left - c.left + b.width / 2, y: b.top - c.top + b.height / 2 - 7.33 * unit },
    scale,
  };
}

/** A soft round glow, drawn once and stamped behind each leader. */
function glowSprite(color: string): HTMLCanvasElement {
  const g = document.createElement("canvas");
  g.width = g.height = 128;
  const ctx = g.getContext("2d");
  if (!ctx) return g;
  const r = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, `${color}66`);
  r.addColorStop(0.4, `${color}1f`);
  r.addColorStop(1, `${color}00`);
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, 128, 128);
  return g;
}

/** Faint fixed stars, drawn once per size. */
function starfield(width: number, height: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(width * dpr);
  c.height = Math.round(height * dpr);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.scale(dpr, dpr);
  let seed = 41;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const n = Math.round((width * height) / 5200);
  for (let k = 0; k < n; k++) {
    const r = rnd() < 0.08 ? 1.1 : 0.6;
    ctx.globalAlpha = 0.06 + rnd() * 0.28;
    ctx.fillStyle = "#f0efec";
    ctx.beginPath();
    ctx.arc(rnd() * width, rnd() * height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, u: number, stretch: number) {
  // The mark's triangle, 8 units wide and 7 long around its centroid, apex
  // forward; stretched longer and narrower in flight, so its heading reads.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ax = 4.67 * u * stretch;
  const bx = -2.33 * u * stretch;
  const by = (4 * u) / stretch ** 0.6;
  ctx.moveTo(x + ax * c, y + ax * s);
  ctx.lineTo(x + bx * c - by * s, y + bx * s + by * c);
  ctx.lineTo(x + bx * c + by * s, y + bx * s - by * c);
  ctx.closePath();
}

function draw(
  ctx: CanvasRenderingContext2D,
  s: SkyState,
  stars: HTMLCanvasElement | null,
  glows: Map<string, HTMLCanvasElement>,
) {
  ctx.clearRect(0, 0, s.width, s.height);
  if (stars) {
    // The stars drift a few pixels against the pointer: depth without motion of their own.
    const p = s.pointer;
    const ox = p ? (p.x / s.width - 0.5) * -10 : 0;
    const oy = p ? (p.y / s.height - 0.5) * -6 : 0;
    ctx.drawImage(stars, ox, oy, s.width, s.height);
  }
  for (const layer of [0, 1, 2] as const)
    for (const sq of s.squadrons) if (sq.layer === layer) drawSquadron(ctx, s, sq, glows);
  for (const r of s.ripples) {
    const u = r.age / 0.9;
    const e = 1 - (1 - u) ** 3;
    ctx.globalAlpha = 0.5 * (1 - u);
    ctx.strokeStyle = LIME;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 8 + e * 72, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSquadron(ctx: CanvasRenderingContext2D, s: SkyState, sq: Squadron, glows: Map<string, HTMLCanvasElement>) {
  const { scale, alpha } = LAYERS[sq.layer];
  const isMark = s.intro?.squadron === sq.id;
  const lead = sq.ships[0];
  if (!lead) return;
  // The leader's glow, for the near ships: brightest on the mark as it lands and holds.
  const glow = glows.get(lead.color);
  if (glow && sq.layer > 0) {
    const held = isMark ? Math.max(0, Math.min(1, (s.time - INTRO.arrive * 0.6) / 0.7)) : 0;
    const size = SHIP * scale * lead.size * (4.5 + held * 2.5);
    ctx.globalAlpha = alpha * (lead.color === LIME ? 0.9 : 0.45) * quietness(s, lead.x, lead.y);
    ctx.drawImage(glow, lead.x - size / 2, lead.y - size / 2, size, size);
  }
  ctx.lineCap = "round";
  for (const sh of sq.ships) {
    const quiet = quietness(s, sh.x, sh.y);
    // The wake: a fading line behind the ship.
    if (sh.wake.length > 1 && sq.layer > 0) {
      ctx.strokeStyle = sh.color;
      ctx.lineWidth = Math.max(0.75, SHIP * scale * sh.size * 0.1);
      let x = sh.x;
      let y = sh.y;
      for (let i = 1; i < sh.wake.length; i++) {
        const b = sh.wake[i];
        if (!b) continue;
        ctx.globalAlpha = alpha * sh.tone * quiet * 0.26 * (1 - i / sh.wake.length);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        x = b.x;
        y = b.y;
      }
    }
    ctx.globalAlpha = alpha * sh.tone * quiet;
    ctx.fillStyle = sh.color;
    ctx.beginPath();
    drawShip(ctx, sh.x, sh.y, sh.angle, (SHIP * scale * sh.size) / 4, sh.stretch);
    ctx.fill();
  }
}

export function Sky() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const hero = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !hero || !ctx) return;
    const still = prefersReducedMotion();
    let dpr = 1;
    let stars: HTMLCanvasElement | null = null;
    const glows = new Map(["#b6f15a", "#bb87fc", "#d97757", "#10a37f", "#f0efec"].map((c) => [c, glowSprite(c)]));

    const size = () => {
      const r = canvas.getBoundingClientRect();
      // Two device pixels per CSS pixel at most: sharper costs frames on a phone.
      dpr = Math.min(window.devicePixelRatio || 1, r.width < 700 ? 1.5 : 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = starfield(r.width, r.height, dpr);
      return r;
    };
    const r = size();
    const { anchor, scale } = anchorOf(canvas);
    const sky = createSky(r.width, r.height, { anchor, markScale: scale, intro: !still });
    sky.quiet = quietOf(canvas);
    // A calm still sky: the mark in place, the squadrons where they are.
    if (still) draw(ctx, sky, stars, glows);
    // Development only: `?sky=<seconds>` freezes the sky at that time, to look at one moment.
    const frozen = process.env.NODE_ENV === "production" ? null : new URL(window.location.href).searchParams.get("sky");
    if (frozen) {
      while (sky.time < Number(frozen)) step(sky, 1 / 60);
      draw(ctx, sky, stars, glows);
      return;
    }

    const frame = (dt: number) => {
      step(sky, dt);
      draw(ctx, sky, stars, glows);
    };
    let stop: (() => void) | null = null;
    const run = (on: boolean) => {
      if (still) return;
      if (on && !stop) stop = onFrame(frame);
      if (!on && stop) {
        stop();
        stop = null;
      }
    };
    const unwatch = whileVisible(canvas, run);

    const ro = new ResizeObserver(() => {
      const next = size();
      const a = anchorOf(canvas);
      resize(sky, next.width, next.height, a.anchor, a.scale);
      sky.quiet = quietOf(canvas);
      draw(ctx, sky, stars, glows);
    });
    ro.observe(canvas);

    const local = (e: PointerEvent) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse") point(sky, local(e));
    };
    const leave = () => point(sky, null);
    const click = (e: PointerEvent) => {
      // Links, buttons and text keep their own click.
      if (e.target instanceof Element && e.target.closest("a, button, input, [data-no-launch]")) return;
      if (still) return;
      const at = local(e);
      launch(sky, at.x, at.y);
    };
    hero.addEventListener("pointermove", move, { passive: true });
    hero.addEventListener("pointerleave", leave);
    hero.addEventListener("pointerup", click);
    return () => {
      unwatch();
      ro.disconnect();
      stop?.();
      hero.removeEventListener("pointermove", move);
      hero.removeEventListener("pointerleave", leave);
      hero.removeEventListener("pointerup", click);
    };
  }, []);

  return <canvas ref={ref} className="lp-sky" aria-hidden />;
}
