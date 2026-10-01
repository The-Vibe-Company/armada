"use client";

// Coordinators and workers (THE-887): one canvas, three projects. Each
// coordinator (the mark's lime ship) holds its workers in orbit; it briefs one
// (blue), the worker's question flies back to it and on to you (orange), your
// answer comes back down (blue), and a green hand-back returns to be merged
// (lime). Steps with the time between frames; runs only while on screen, and
// draws one still frame with reduced motion.
import { useEffect, useRef } from "react";
import { onFrame, prefersReducedMotion, whileVisible } from "./frames";

const BLUE = "#7ea6ff";
const ORANGE = "#ff8a4c";
const LIME = "#b6f15a";
const BONE = "#f0efec";
const HARNESS = { "Conductor Cloud": "#bb87fc", "Claude Code": "#d97757", Codex: "#10a37f" } as const;

interface System {
  name: string;
  harness: keyof typeof HARNESS;
  workers: string[];
  /** Center, as a share of the canvas. */
  fx: number;
  fy: number;
  /** Orbit radius, as a share of the smaller side; its speed in radians per second. */
  r: number;
  spin: number;
  /** Seconds into the shared loop at which its story starts. */
  offset: number;
}

const SYSTEMS: System[] = [
  {
    name: "Widgets",
    harness: "Conductor Cloud",
    workers: ["WID-12", "WID-14", "WID-15", "WID-17"],
    fx: 0.5,
    fy: 0.5,
    r: 0.19,
    spin: 0.22,
    offset: 0,
  },
  {
    name: "Gadgets",
    harness: "Claude Code",
    workers: ["GAD-3", "GAD-5"],
    fx: 0.2,
    fy: 0.76,
    r: 0.11,
    spin: -0.3,
    offset: 3.4,
  },
  {
    name: "Armada",
    harness: "Codex",
    workers: ["THE-858", "THE-862", "THE-864"],
    fx: 0.8,
    fy: 0.76,
    r: 0.12,
    spin: 0.26,
    offset: 6.8,
  },
];

/** One system's story, in seconds from its start: who sends what to whom. */
const STORY: { at: number; from: "c" | "w" | "you"; to: "c" | "w" | "you"; color: string }[] = [
  { at: 0, from: "c", to: "w", color: BLUE },
  { at: 2.2, from: "w", to: "c", color: ORANGE },
  { at: 3.1, from: "c", to: "you", color: ORANGE },
  { at: 4.6, from: "you", to: "c", color: BLUE },
  { at: 5.5, from: "c", to: "w", color: BLUE },
  { at: 8.4, from: "w", to: "c", color: LIME },
];
const LOOP = 10.2;
const FLIGHT = 0.95;

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, len: number, wide: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(x + c * len * 0.67, y + s * len * 0.67);
  ctx.lineTo(x - c * len * 0.33 - s * wide, y - s * len * 0.33 + c * wide);
  ctx.lineTo(x - c * len * 0.33 + s * wide, y - s * len * 0.33 - c * wide);
  ctx.closePath();
  ctx.fill();
}

export function CrewSky() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = prefersReducedMotion();
    let w = 0;
    let h = 0;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    let time = 0;
    // A phone's narrow canvas: the three projects closer together, the ticket names left out.
    const narrow = () => w < 480;
    const you = () => ({ x: w * 0.5, y: h * 0.12 });
    const center = (s: System) => ({
      x: (narrow() ? 0.5 + (s.fx - 0.5) * 1.12 : s.fx) * w,
      y: (narrow() ? (s.fx === 0.5 ? 0.44 : 0.68) : s.fy) * h,
    });
    const radius = (s: System) => Math.min(w, h * 1.4) * s.r * (narrow() ? 0.8 : 1);
    /** The worker the story is about this loop: a different one each time round. */
    const worker = (s: System, k: number) => {
      const c = center(s);
      const R = radius(s);
      const a = time * s.spin + (k / s.workers.length) * Math.PI * 2;
      return { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R * 0.6, a };
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const y = you();
      // You, at the top: every question reaches you through a coordinator.
      ctx.globalAlpha = 1;
      const glow = ctx.createRadialGradient(y.x, y.y, 0, y.x, y.y, 40);
      glow.addColorStop(0, "rgba(255,138,76,0.25)");
      glow.addColorStop(1, "rgba(255,138,76,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(y.x, y.y, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ORANGE;
      ctx.beginPath();
      ctx.arc(y.x, y.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 13px Geist, ui-sans-serif, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = BONE;
      ctx.fillText("You", y.x, y.y - 18);

      for (const s of SYSTEMS) {
        const c = center(s);
        const R = radius(s);
        // The thread to you, faint.
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - 20);
        ctx.quadraticCurveTo((c.x + y.x) / 2, (c.y + y.y) / 2 - 40, y.x, y.y + 10);
        ctx.stroke();
        // The orbit.
        ctx.strokeStyle = "rgba(255,255,255,0.09)";
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, R, R * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        // Workers: darts flying their orbit, the harness's color.
        s.workers.forEach((id, k) => {
          const p = worker(s, k);
          const heading = Math.atan2(Math.cos(p.a) * 0.6 * Math.sign(s.spin), -Math.sin(p.a) * Math.sign(s.spin));
          ctx.fillStyle = BLUE;
          ctx.globalAlpha = 0.95;
          triangle(ctx, p.x, p.y, heading, 15, 4.5);
          ctx.globalAlpha = 1;
          if (narrow()) return;
          ctx.fillStyle = "#a1a1a6";
          ctx.font = "10.5px 'Geist Mono', ui-monospace, monospace";
          ctx.fillText(id, p.x, p.y - 14);
        });
        // The coordinator: the mark's lime ship, pointing up, its name and harness below.
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 54);
        g.addColorStop(0, "rgba(182,241,90,0.22)");
        g.addColorStop(1, "rgba(182,241,90,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 54, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = LIME;
        triangle(ctx, c.x, c.y + 2, -Math.PI / 2, 26, 11);
        ctx.font = "600 13px Geist, ui-sans-serif, sans-serif";
        ctx.fillStyle = BONE;
        ctx.fillText(s.name, c.x, c.y + 32);
        ctx.font = "11px 'Geist Mono', ui-monospace, monospace";
        ctx.fillStyle = HARNESS[s.harness];
        ctx.fillText(s.harness, c.x, c.y + 48);

        // This loop's story: messages in flight.
        if (still) continue;
        const loop = Math.floor((time + LOOP - s.offset) / LOOP);
        const local = (time + LOOP - s.offset) % LOOP;
        const k = loop % s.workers.length;
        const wp = worker(s, k);
        for (const m of STORY) {
          const u = (local - m.at) / FLIGHT;
          if (u < 0 || u > 1) continue;
          const at = (who: "c" | "w" | "you") => (who === "c" ? { x: c.x, y: c.y - 6 } : who === "w" ? wp : y);
          const a = at(m.from);
          const b = at(m.to);
          const e = easeInOut(u);
          // An arc between the two, bowing up.
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2 - Math.hypot(b.x - a.x, b.y - a.y) * 0.18;
          const px = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * mx + e * e * b.x;
          const py = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * my + e * e * b.y;
          ctx.shadowColor = m.color;
          ctx.shadowBlur = 14;
          ctx.fillStyle = m.color;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        // The merge: the coordinator's ring flashes lime as the hand-back lands.
        const merged = local - (STORY.at(-1)?.at ?? 0) - FLIGHT;
        if (merged > 0 && merged < 0.8) {
          const u = merged / 0.8;
          ctx.strokeStyle = LIME;
          ctx.globalAlpha = 1 - u;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(c.x, c.y, 16 + (1 - (1 - u) ** 3) * 34, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.globalAlpha = 1;
        }
      }
    };

    draw();
    let stop: (() => void) | null = null;
    const unwatch = whileVisible(canvas, (on) => {
      if (still) return;
      if (on && !stop)
        stop = onFrame((dt) => {
          time += Math.min(dt, 0.05);
          draw();
        });
      if (!on && stop) {
        stop();
        stop = null;
      }
    });
    const ro = new ResizeObserver(() => {
      size();
      draw();
    });
    ro.observe(canvas);
    return () => {
      unwatch();
      stop?.();
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="lp-crew-sky" aria-hidden />;
}
