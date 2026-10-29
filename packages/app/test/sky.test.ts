import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Group } from "../src/fleet/overview";
import { type Harness, type SkyAgent, type SkyProject, skyProject } from "../src/fleet/sky";
import { readFleetState } from "../src/fleet/state";
import type { SkyContext } from "../src/sky/draw";
import { BLOCKED_BANK, BONE, LIME } from "../src/sky/flock";
import { HARNESS_COLOR, layoutSky, type SkySize, STATE_COLOR } from "../src/sky/layout";
import { Sky } from "../src/sky/Sky";
import { createSkyView, type SkyClock } from "../src/sky/view";

// The sky on synthetic fleets, without a canvas: a fake 2D context records
// what each frame fills and strokes, and a hand-turned clock gives the frames.

const budget = JSON.parse(readFileSync(join(resolve(import.meta.dir, ".."), "perf-budget.json"), "utf8")) as {
  skyFrame: { triangles: number; maxCanvasCalls: number; maxMs: number };
};

/** A 2D context that keeps the last frame's fills (colour, opacity, triangles) and strokes, and counts every call and write. */
function fakeContext() {
  let calls = 0;
  let moves = 0;
  const frame = { fills: [] as { color: string; alpha: number; triangles: number }[], strokes: [] as string[] };
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
    },
    beginPath() {
      moves = 0;
    },
    moveTo() {
      moves++;
    },
    lineTo() {},
    closePath() {},
    quadraticCurveTo() {},
    fill() {
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
    const { fake, clock, view } = sky(size);
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
    // Three depths: the merges far and faint, ready to merge in the middle, the rest near.
    const ship = (ticket: string) => view.flock.ships.get(`harbor/${ticket}`);
    expect([ship("HAR-7")?.depth, ship("HAR-5")?.depth, ship("HAR-1")?.depth]).toEqual([0, 1, 2]);
    const merges = fake.frame.fills.filter((f) => f.color === BONE && f.triangles === 3);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.alpha).toBeLessThan(0.4);
    // The blocked one banks away; no other does.
    expect(ship("HAR-3")?.bank).toBe(BLOCKED_BANK);
    expect([...view.flock.ships.values()].filter((s) => s.bank !== 0).map((s) => s.key)).toEqual(["harbor/HAR-3"]);
    // An arc in each state's colour under its agents: one per state on the band, the most urgent on the stage.
    expect(fake.frame.strokes).toEqual(
      size === "band"
        ? [STATE_COLOR.blocked, STATE_COLOR.you, STATE_COLOR.running, STATE_COLOR.ready]
        : [STATE_COLOR.blocked],
    );
  });

  test("a ship banks and flies to its new group when its session changes state, then the sky stops", () => {
    const fleet = project([agent("HAR-1", "running", "claude"), agent("HAR-2", "running", "codex")]);
    const { clock, view, show } = sky(size, [fleet]);
    const ship = () => view.flock.ships.get("harbor/HAR-2");
    const before = { x: ship()?.x ?? 0, y: ship()?.y ?? 0 };
    expect(ship()?.bank).toBe(0);
    expect(clock.waiting).toBe(0);

    // The second one is blocked: it leaves its group for the blocked one, first of the sky.
    show([project([agent("HAR-1", "running", "claude"), agent("HAR-2", "blocked", "codex")])]);
    expect(clock.waiting).toBe(1);
    clock.tick();
    // It rolls at once, before it has gone far, and keeps its harness's colour.
    expect(Math.abs(ship()?.bank ?? 0)).toBeGreaterThan(0.05);
    expect(ship()?.color).toBe(HARNESS_COLOR.codex);
    // The coordinator's ships did not change state: they do not bank.
    expect(view.flock.ships.get("harbor/coordinator/0")?.bank).toBe(0);

    const frames = clock.settle();
    expect(frames).toBeGreaterThan(30);
    expect(frames).toBeLessThan(400);
    expect(clock.waiting).toBe(0);
    const target = ship()?.target;
    expect(ship()).toMatchObject({ x: target?.x, y: target?.y, bank: BLOCKED_BANK, bankV: 0 });
    expect(Math.hypot((ship()?.x ?? 0) - before.x, (ship()?.y ?? 0) - before.y)).toBeGreaterThan(5);
  });

  test("a merge flies the ship to the merged V and its squadron regroups", () => {
    const three = [agent("HAR-1", "running", "claude"), agent("HAR-2", "running", "codex")];
    const { fake, clock, view, show } = sky(size, [project([...three, agent("HAR-3", "running", "opencode")])]);
    const at = (ticket: string) => ({ ...view.flock.ships.get(`harbor/${ticket}`)?.target });
    const before = { one: at("HAR-1"), two: at("HAR-2") };

    show([project([...three, agent("HAR-3", "merged", "opencode")])]);
    clock.settle();
    const merged = view.flock.ships.get("harbor/HAR-3");
    expect(merged).toMatchObject({ color: BONE, depth: 0 });
    // The two left in progress closed ranks: each has a new place.
    expect(at("HAR-1")).not.toEqual(before.one);
    expect(at("HAR-2")).not.toEqual(before.two);
    expect(fake.triangles()[HARNESS_COLOR.opencode]).toBeUndefined();
  });

  test("a session that starts flies in, one that ends flies out and is dropped", () => {
    const { clock, view, show } = sky(size, [project([agent("HAR-1", "running", "claude")])]);
    show([project([agent("HAR-2", "running", "codex")])]);
    clock.tick();
    const arriving = view.flock.ships.get("harbor/HAR-2");
    // From below the sky, rising.
    expect(arriving?.y ?? 0).toBeGreaterThan(SIZES[size][1] - 10);
    expect(view.flock.ships.get("harbor/HAR-1")?.leaving).toBe(true);
    clock.settle();
    expect(view.flock.ships.has("harbor/HAR-1")).toBe(false);
    expect(view.flock.ships.get("harbor/HAR-2")).toMatchObject({ y: arriving?.target.y, tone: 1 });
  });

  test("with reduced motion, a change is drawn at once and nothing flies", () => {
    const { fake, clock, view, show } = sky(size, [project([agent("HAR-1", "running", "claude")])]);
    show([project([agent("HAR-1", "blocked", "claude"), agent("HAR-2", "running", "codex")])], { still: true });
    expect(clock.waiting).toBe(0);
    expect(view.flock.ships.get("harbor/HAR-1")).toMatchObject({ bank: BLOCKED_BANK, bankV: 0 });
    expect(fake.triangles()[HARNESS_COLOR.codex]).toBe(1);
  });

  test("showing the same fleet again asks for no frame", () => {
    const { clock, show } = sky(size);
    show([structuredClone(FLEET)]);
    expect(clock.waiting).toBe(0);
  });

  test(`a frame with ${budget.skyFrame.triangles} agents flying stays under the package's budget`, () => {
    const harnesses = ["claude", "codex", "opencode"] as const;
    const groups = ["running", "running", "running", "blocked", "you", "ready"] as const;
    const many = project(
      Array.from({ length: budget.skyFrame.triangles }, (_, k) =>
        agent(`HAR-${k}`, groups[k % groups.length] ?? "running", harnesses[k % 3] ?? null),
      ),
    );
    const { fake, clock, show } = sky(size, [project([])]);
    // Every one flies in at once.
    show([many]);
    clock.tick();
    fake.takeCalls();
    clock.tick();
    const calls = fake.takeCalls();
    console.log(`sky ${size}: ${calls} canvas calls per frame (budget ${budget.skyFrame.maxCanvasCalls})`);
    expect(calls).toBeLessThanOrEqual(budget.skyFrame.maxCanvasCalls);
    expect(Object.values(fake.triangles()).reduce((a, b) => a + b, 0)).toBe(budget.skyFrame.triangles + 5);

    const frames = 60;
    const start = performance.now();
    for (let k = 0; k < frames; k++) clock.tick();
    const ms = (performance.now() - start) / frames;
    console.log(`sky ${size}: ${ms.toFixed(3)} ms per frame (budget ${budget.skyFrame.maxMs} ms)`);
    expect(clock.waiting).toBe(1);
    expect(ms).toBeLessThan(budget.skyFrame.maxMs);
  });

  test("renders a canvas and a quiet legend, and no h1", () => {
    const html = renderToStaticMarkup(createElement(Sky, { projects: [FLEET], size }));
    expect(html).toContain(`data-sky="${size}"`);
    expect(html).toContain("<canvas");
    expect(html).not.toMatch(/<h1[\s>]/);
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
