// Draws the sky's ships and arcs on a 2D context (THE-2024). The context is
// the few methods the sky uses, so a test draws on a fake one and counts the
// calls a frame makes (perf-budget.json's `skyFrame`). Ships of one depth,
// colour and opacity share one path and one fill.
import { depthLook, type Flock, SHIP, trianglePoints } from "./flock";
import type { SkyArc } from "./layout";

export type SkyContext = Pick<
  CanvasRenderingContext2D,
  | "setTransform"
  | "clearRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "fill"
  | "stroke"
  | "quadraticCurveTo"
  | "fillStyle"
  | "strokeStyle"
  | "globalAlpha"
  | "lineWidth"
  | "lineCap"
>;

/** How a banking ship leans into its turn, over its roll. */
const LEAN = 0.3;

export function drawSky(ctx: SkyContext, flock: Flock, arcs: readonly SkyArc[], dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, flock.width, flock.height);

  // The arcs first, under the ships they stand for, where those ships are now.
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  for (const arc of arcs) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let tone = 0;
    let n = 0;
    for (const key of arc.members) {
      const s = flock.ships.get(key);
      if (!s || s.leaving) continue;
      const reach = (SHIP * depthLook(s.depth).scale * s.size) / 2;
      minX = Math.min(minX, s.x - reach);
      maxX = Math.max(maxX, s.x + reach);
      maxY = Math.max(maxY, s.y + reach);
      tone += s.tone;
      n++;
    }
    if (!n) continue;
    const y = maxY + 12;
    ctx.globalAlpha = 0.7 * Math.min(1, tone / n);
    ctx.strokeStyle = arc.color;
    ctx.beginPath();
    ctx.moveTo(minX - 12, y);
    ctx.quadraticCurveTo((minX + maxX) / 2, y + 16, maxX + 12, y);
    ctx.stroke();
  }

  // The ships, far to near; one path per depth, colour and opacity.
  const ships = [...flock.ships.values()].sort((a, b) => a.depth - b.depth);
  const batches = new Map<string, typeof ships>();
  for (const s of ships) {
    const alpha = Math.round(depthLook(s.depth).alpha * s.tone * 40) / 40;
    if (alpha <= 0) continue;
    const key = `${Math.round(s.depth * 10)}|${s.color}|${alpha}`;
    const batch = batches.get(key);
    if (batch) batch.push(s);
    else batches.set(key, [s]);
  }
  for (const [key, batch] of batches) {
    const first = batch[0];
    if (!first) continue;
    ctx.globalAlpha = Number(key.slice(key.lastIndexOf("|") + 1));
    ctx.fillStyle = first.color;
    ctx.beginPath();
    for (const s of batch) {
      const u = (SHIP * depthLook(s.depth).scale * s.size) / 4;
      const [ax, ay, bx, by, cx, cy] = trianglePoints(s.x, s.y, s.angle + s.bank * LEAN, u, s.stretch, s.bank);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
