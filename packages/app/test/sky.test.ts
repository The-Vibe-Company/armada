import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Group } from "../src/fleet/overview";
import { type Harness, type SkyAgent, type SkyProject, skyProject } from "../src/fleet/sky";
import { readFleetState } from "../src/fleet/state";
import type { SkyContext } from "../src/sky/draw";
import { BONE, LIME } from "../src/sky/flock";
import { HARNESS_COLOR, layoutSky, type SkySize, STATE_COLOR } from "../src/sky/layout";
import { Sky } from "../src/sky/Sky";
import { createSkyView, type SkyClock } from "../src/sky/view";

// The sky on synthetic fleets, without a canvas: a fake 2D context records
// what each frame fills and strokes, and a hand-turned clock gives the frames.

const budget = JSON.parse(readFileSync(join(resolve(import.meta.dir, ".."), "perf-budget.json"), "utf8")) as {
  skyFrame: { triangles: number; maxCanvasCalls: number; maxMs: number };
};

/** A 2D context that keeps the last frame's fills (colour, opacity, triangles) and strokes, and counts every call and write. */
type Point = { x: number; y: number };
type Triangle = { points: [Point, Point, Point]; color: string; alpha: number };
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected drawing geometry");
  return value;
}
const center = (t: Triangle): Point => ({
  x: t.points.reduce((n, p) => n + p.x, 0) / 3,
  y: t.points.reduce((n, p) => n + p.y, 0) / 3,
});
const heading = (t: Triangle) => Math.atan2(t.points[0].y - center(t).y, t.points[0].x - center(t).x);
const proportions = (t: Triangle) => {
  const [a, b, c] = t.points;
  return area(t) / ((a.x - (b.x + c.x) / 2) ** 2 + (a.y - (b.y + c.y) / 2) ** 2);
};
const area = (t: Triangle) => {
  const [a, b, c] = t.points as [Point, Point, Point];
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
};

function fakeContext() {
  let calls = 0;
  let moves = 0;
  let points: Point[] = [];
  const frame = {
    fills: [] as { color: string; alpha: number; triangles: number }[],
    strokes: [] as string[],
    shapes: [] as Triangle[],
  };
  const target = {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    setTransform() {},
    clearRect() {
      frame.fills = [];
      frame.strokes = [];
      frame.shapes = [];
    },
    beginPath() {
      moves = 0;
      points = [];
    },
    moveTo(x: number, y: number) {
      moves++;
      points.push({ x, y });
    },
    lineTo(x: number, y: number) {
      points.push({ x, y });
    },
    closePath() {},
    quadraticCurveTo() {},
    fill() {
      for (let i = 0; i < points.length; i += 3)
        frame.shapes.push({
          points: points.slice(i, i + 3) as [Point, Point, Point],
          color: String(target.fillStyle),
          alpha: target.globalAlpha,
        });
      frame.fills.push({ color: String(target.fillStyle), alpha: target.globalAlpha, triangles: moves });
    },
    stroke() {
      frame.strokes.push(String(target.strokeStyle));
    },
  };
  const ctx = new Proxy(target, {
    get(t, key) {
      const v = Reflect.get(t, key);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls++;
        return v.apply(t, args);
      };
    },
    set(t, key, value) {
      calls++;
      return Reflect.set(t, key, value);
    },
  }) as unknown as SkyContext;
  return {
    ctx,
    frame,
    /** Triangles drawn per colour in the last frame. */
    triangles() {
      const out: Record<string, number> = {};
      for (const f of frame.fills) out[f.color] = (out[f.color] ?? 0) + f.triangles;
      return out;
    },
    ship(color: string) {
      const found = frame.shapes.filter((t) => t.color === color);
      expect(found).toHaveLength(1);
      return required(found[0]);
    },
    takeCalls() {
      const n = calls;
      calls = 0;
      return n;
    },
  };
}

/** Frames only when turned: `tick` runs the frame asked for, 1/60 s later. */
function manualClock() {
  let now = 1000;
  let pending: ((t: number) => void)[] = [];
  const clock: SkyClock & { waiting: number; tick(): void; settle(): number } = {
    frame(run) {
      pending.push(run);
      return () => {
        pending = pending.filter((r) => r !== run);
      };
    },
    get waiting() {
      return pending.length;
    },
    tick() {
      now += 1000 / 60;
      const runs = pending;
      pending = [];
      for (const r of runs) r(now);
    },
    /** Turns frames until none is asked for; how many it took. */
    settle() {
      let n = 0;
      while (pending.length && n < 3000) {
        clock.tick();
        n++;
      }
      return n;
    },
  };
  return clock;
}

const agent = (ticket: string, group: Group, harness: Harness | null): SkyAgent => ({
  key: `harbor/${ticket}`,
  ticket,
  group,
  harness,
});
const project = (agents: SkyAgent[]): SkyProject => ({ id: "harbor", name: "Harbor", coordinator: true, agents });

/** One agent in every state and harness, an unknown runtime, and three merges of the day. */
const FLEET = project([
  agent("HAR-1", "running", "claude"),
  agent("HAR-2", "running", "claude"),
  agent("HAR-3", "blocked", "codex"),
  agent("HAR-4", "you", "opencode"),
  agent("HAR-5", "ready", "codex"),
  agent("HAR-6", "running", null),
  agent("HAR-7", "merged", "claude"),
  agent("HAR-8", "merged", "codex"),
  agent("HAR-9", "merged", "opencode"),
]);

const SIZES: Record<SkySize, [number, number]> = { band: [1100, 200], stage: [1100, 700] };

function sky(size: SkySize, fleet: SkyProject[] = [FLEET]) {
  const fake = fakeContext();
  const clock = manualClock();
  const view = createSkyView(fake.ctx, clock);
  const [w, h] = SIZES[size];
  view.resize(w, h, 1);
  const show = (projects: SkyProject[], opts?: { still?: boolean }) => view.show(layoutSky(projects, size, w, h), opts);
  show(fleet);
  return { fake, clock, view, show };
}

describe.each(["band", "stage"] as const)("the %s", (size) => {
  test("draws the coordinator's V, one triangle per agent in its harness's colour, and the day's merges", () => {
    const { fake, clock } = sky(size);
    // The first paint is still: drawn once, no frame asked for.
    expect(clock.waiting).toBe(0);
    expect(fake.triangles()).toEqual({
      [LIME]: 1,
      // The coordinator's four wings, the unknown runtime, the three merges.
      [BONE]: 4 + 1 + 3,
      [HARNESS_COLOR.claude]: 2,
      [HARNESS_COLOR.codex]: 2,
      [HARNESS_COLOR.opencode]: 1,
    });
    // Far merges are smaller and fainter than ready ships; active ships are nearest.
    const merged = fake.frame.shapes.filter((t) => t.color === BONE && t.alpha < 0.4);
    expect(merged).toHaveLength(3);
    const ready = required(fake.frame.shapes.find((t) => t.color === HARNESS_COLOR.codex && t.alpha < 1));
    const running = required(fake.frame.shapes.find((t) => t.color === HARNESS_COLOR.claude));
    expect(required(merged[0]).alpha).toBeLessThan(ready.alpha);
    expect(ready.alpha).toBeLessThan(running.alpha);
    expect(area(required(merged[0]))).toBeLessThan(area(ready));
    expect(area(ready)).toBeLessThan(area(running));
    // Only the blocked ship visibly leans away from its formation's heading.
    const [w, h] = SIZES[size];
    const targets = layoutSky([FLEET], size, w, h).targets;
    const banked = fake.frame.shapes.filter((t) => {
      const c = center(t);
      const target = required(targets.find((p) => Math.hypot(p.x - c.x, p.y - c.y) < 0.1));
      return Math.abs(heading(t) - target.angle) > 0.1;
    });
    expect(banked).toHaveLength(1);
    expect(required(banked[0]).color).toBe(HARNESS_COLOR.codex);
    // An arc in each state's colour under its agents: one per state on the band, the most urgent on the stage.
    expect(fake.frame.strokes).toEqual(
      size === "band"
        ? [STATE_COLOR.blocked, STATE_COLOR.you, STATE_COLOR.running, STATE_COLOR.ready]
        : [STATE_COLOR.blocked],
    );
  });

  test("a ship banks and flies to its new group when its session changes state, then the sky stops", () => {
    const fleet = project([agent("HAR-1", "running", "claude"), agent("HAR-2", "running", "codex")]);
    const { fake, clock, show } = sky(size, [fleet]);
    const before = fake.ship(HARNESS_COLOR.codex);
    const coordinator = fake.frame.shapes.filter((t) => t.color === LIME || t.color === BONE);
    expect(clock.waiting).toBe(0);
    const changed = [project([agent("HAR-1", "running", "claude"), agent("HAR-2", "blocked", "codex")])];
    show(changed);
    expect(clock.waiting).toBe(1);
    clock.tick();
    const turning = fake.ship(HARNESS_COLOR.codex);
    expect(Math.abs(heading(turning) - heading(before))).toBeGreaterThan(0.01);
    const wings = fake.frame.shapes.filter((t) => t.color === LIME || t.color === BONE);
    for (const [i, wing] of wings.entries()) {
      // Unchanged groups can reposition, but their triangles do not roll/foreshorten.
      expect(proportions(wing)).toBeCloseTo(proportions(required(coordinator[i])), 8);
    }
    const frames = clock.settle();
    expect(frames).toBeGreaterThan(30);
    expect(frames).toBeLessThan(400);
    expect(clock.waiting).toBe(0);
    const after = fake.ship(HARNESS_COLOR.codex);
    expect(Math.hypot(center(after).x - center(before).x, center(after).y - center(before).y)).toBeGreaterThan(5);
    // A flight ends at exactly the geometry a still first paint draws.
    const destination = sky(size, changed).fake.ship(HARNESS_COLOR.codex);
    expect(after).toEqual(destination);
    fake.takeCalls();
    clock.tick();
    expect(fake.takeCalls()).toBe(0);
  });

  test("a merge flies the ship to the merged V and its squadron regroups", () => {
    const three = [agent("HAR-1", "running", "claude"), agent("HAR-2", "running", "codex")];
    const { fake, clock, show } = sky(size, [project([...three, agent("HAR-3", "running", "opencode")])]);
    const before = [center(fake.ship(HARNESS_COLOR.claude)), center(fake.ship(HARNESS_COLOR.codex))];
    const changed = [project([...three, agent("HAR-3", "merged", "opencode")])];
    show(changed);
    expect(clock.waiting).toBe(1);
    clock.tick();
    expect(fake.triangles()[HARNESS_COLOR.opencode]).toBeUndefined();
    clock.settle();
    expect(clock.waiting).toBe(0);
    const merged = fake.frame.shapes.filter((t) => t.color === BONE && t.alpha < 0.4);
    expect(merged).toHaveLength(1);
    expect(center(fake.ship(HARNESS_COLOR.claude))).not.toEqual(before[0]);
    expect(center(fake.ship(HARNESS_COLOR.codex))).not.toEqual(before[1]);
    expect(fake.frame.shapes).toEqual(sky(size, changed).fake.frame.shapes);
  });

  test("a session that starts flies in, one that ends flies out and is dropped", () => {
    const { fake, clock, show } = sky(size, [project([agent("HAR-1", "running", "claude")])]);
    const departed = center(fake.ship(HARNESS_COLOR.claude));
    const changed = [project([agent("HAR-2", "running", "codex")])];
    show(changed);
    // A just-launched ship fades in; turn enough frames for it to be visible.
    for (let n = 0; n < 4; n++) clock.tick();
    const arriving = fake.ship(HARNESS_COLOR.codex);
    expect(center(arriving).y).toBeGreaterThan(SIZES[size][1] - 10);
    const leaving = fake.ship(HARNESS_COLOR.claude);
    expect(center(leaving).y).toBeLessThan(departed.y);
    expect(leaving.alpha).toBeLessThan(1);
    clock.settle();
    expect(clock.waiting).toBe(0);
    expect(fake.triangles()[HARNESS_COLOR.claude]).toBeUndefined();
    expect(fake.ship(HARNESS_COLOR.codex)).toEqual(sky(size, changed).fake.ship(HARNESS_COLOR.codex));
  });

  test("with reduced motion, a change is drawn at once and nothing flies", () => {
    const { fake, clock, show } = sky(size, [project([agent("HAR-1", "running", "claude")])]);
    // Reduced motion cancels an already-running flight as well as placing newcomers.
    show([project([agent("HAR-1", "blocked", "claude")])]);
    expect(clock.waiting).toBe(1);
    const changed = [project([agent("HAR-1", "blocked", "claude"), agent("HAR-2", "running", "codex")])];
    show(changed, { still: true });
    expect(clock.waiting).toBe(0);
    expect(fake.frame.shapes).toEqual(sky(size, changed).fake.frame.shapes);
    expect(fake.triangles()[HARNESS_COLOR.codex]).toBe(1);
  });

  test("showing the same fleet again asks for no frame", () => {
    const { clock, show } = sky(size);
    show([structuredClone(FLEET)]);
    expect(clock.waiting).toBe(0);
  });

  test(`every frame with ${budget.skyFrame.triangles} agents in flight stays under the package's budget`, () => {
    const harnesses = ["claude", "codex", "opencode"] as const;
    const groups = ["running", "running", "running", "blocked", "you", "ready"] as const;
    const fleet = (n: number, turn = 0) =>
      project(
        Array.from({ length: n }, (_, k) =>
          agent(`HAR-${k}`, groups[(k + turn) % groups.length] ?? "running", harnesses[k % 3] ?? null),
        ),
      );
    const { fake, clock, show } = sky(size, [project([])]);
    // The worst a flight gets: launches every few frames, so ships fly in at
    // every opacity at once, then every one changing state, then merges.
    let maxCalls = 0;
    let totalMs = 0;
    let frames = 0;
    const turn = () => {
      fake.takeCalls();
      const start = performance.now();
      clock.tick();
      totalMs += performance.now() - start;
      maxCalls = Math.max(maxCalls, fake.takeCalls());
      frames++;
    };
    const { triangles } = budget.skyFrame;
    for (let n = 6; n <= triangles; n += 6) {
      show([fleet(n)]);
      for (let k = 0; k < 4; k++) turn();
    }
    show([fleet(triangles, 1)]);
    for (let k = 0; k < 20; k++) turn();
    const merged = fleet(triangles, 1);
    for (const a of merged.agents.slice(0, 15)) a.group = "merged";
    show([merged]);
    while (clock.waiting) turn();
    expect(Object.values(fake.triangles()).reduce((a, b) => a + b, 0)).toBe(triangles + 5);
    // Calls are counted on the worst frame; time, a noisy reading, is the flight's mean.
    const ms = totalMs / frames;
    console.log(
      `sky ${size}: at most ${maxCalls} canvas calls (budget ${budget.skyFrame.maxCanvasCalls}), ${ms.toFixed(2)} ms a frame on average (budget ${budget.skyFrame.maxMs} ms), over ${frames} frames`,
    );
    expect(frames).toBeGreaterThan(60);
    expect(maxCalls).toBeLessThanOrEqual(budget.skyFrame.maxCanvasCalls);
    expect(ms).toBeLessThan(budget.skyFrame.maxMs);
  });

  test("a ship whose colour changes in place is drawn again without flying", () => {
    const { fake, clock, show } = sky(size, [project([agent("HAR-1", "running", "claude")])]);
    show([project([agent("HAR-1", "running", "codex")])]);
    expect(clock.waiting).toBe(0);
    expect(fake.triangles()[HARNESS_COLOR.codex]).toBe(1);
    expect(fake.triangles()[HARNESS_COLOR.claude]).toBeUndefined();
  });

  test("renders a canvas and a quiet legend", () => {
    const html = renderToStaticMarkup(createElement(Sky, { projects: [FLEET], size }));
    expect(html).toContain(`data-sky="${size}"`);
    expect(html).toContain("<canvas");
    const legend = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, " ").trim());
    expect(legend.map((l) => l.replace(/\s+/g, " "))).toEqual([
      "Blocked 1",
      "Waiting for you 1",
      "In progress 3",
      "Ready to merge 1",
      "Merged today 3",
      "Claude",
      "Codex",
      "OpenCode",
    ]);
  });
});

test("the sky reads each session's harness from its runtime, and the day's merges oldest first", () => {
  const session = (ticket: string, state: string, runtime: string, at = "2026-03-10T09:00:00.000Z") => ({
    ticket,
    session: `s-${ticket}`,
    title: ticket,
    phase: state === "merged" ? "merged" : "implementing",
    state,
    reason: "",
    flowStep: "implementing",
    at,
    runtime,
  });
  const state = readFleetState({
    sessions: [
      session("T-1", "in-progress", "claude-code"),
      session("T-2", "blocked", "codex"),
      session("T-3", "waiting-for-owner", "opencode"),
      session("T-4", "ready-to-merge", "local"),
      session("T-5", "released", "codex"),
      session("T-6", "merged", "codex", "2026-03-10T14:00:00.000Z"),
      session("T-7", "merged", "claude", "2026-03-10T08:00:00.000Z"),
      session("T-8", "merged", "claude", "2026-03-09T12:00:00.000Z"),
    ],
  });
  const sky = skyProject({ id: "p", name: "P" }, state, { now: Date.parse("2026-03-10T15:00:00.000Z"), zone: "UTC" });
  expect(sky.agents.map((a) => [a.ticket, a.group, a.harness])).toEqual([
    ["T-1", "running", "claude"],
    ["T-2", "blocked", "codex"],
    ["T-3", "you", "opencode"],
    ["T-4", "ready", null],
    ["T-7", "merged", "claude"],
    ["T-6", "merged", "codex"],
  ]);
  expect(sky.coordinator).toBe(true);
});

test("a narrow band keeps every group in it, its labels giving way to the legend", () => {
  const all = project([
    agent("HAR-1", "blocked", "codex"),
    agent("HAR-2", "you", "opencode"),
    agent("HAR-3", "running", "claude"),
    agent("HAR-4", "ready", "codex"),
    agent("HAR-5", "merged", "claude"),
  ]);
  const wide = layoutSky([all], "band", 1100, 200);
  expect(wide.labels.map((l) => l.key)).toEqual(["coordinator", "blocked", "you", "running", "ready", "merged"]);
  expect(wide.compact).toBe(false);
  for (const width of [800, 700, 504]) {
    const narrow = layoutSky([all], "band", width, 200);
    expect(narrow.targets).toHaveLength(5 + 5);
    for (const t of narrow.targets) {
      expect(t.x).toBeGreaterThan(0);
      expect(t.x).toBeLessThan(width);
    }
    // The labels gave way: the legend names the groups (Sky.tsx wraps its states and drops its harnesses).
    expect(narrow.labels).toEqual([]);
    expect(narrow.compact).toBe(true);
  }
});
