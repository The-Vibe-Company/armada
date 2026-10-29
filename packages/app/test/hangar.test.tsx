import { expect, test } from "bun:test";
import { APP_TOO_OLD, PROTOCOL_VERSION } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { skyProject } from "../src/fleet/sky";
import { type FoldedSession, readFleetState } from "../src/fleet/state";
import { parseRoute } from "../src/lib/route";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Hangar } from "../src/screens/Hangar";
import { Project } from "../src/screens/Project";
import { Settings } from "../src/screens/Settings";
import type { SkyContext } from "../src/sky/draw";
import { BONE, LIME } from "../src/sky/flock";
import { HARNESS_COLOR, layoutSky, SQUADRON_LABEL, STATE_COLOR } from "../src/sky/layout";
import { createSkyView } from "../src/sky/view";

// The hangar on two synthetic projects: each one a squadron of the stage,
// its size, its colours and its counts; then the page around the sky.

const AT = "2026-03-10T09:00:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const ZONE = "UTC";

const STATE_OF = {
  blocked: ["blocked", "blocked"],
  you: ["awaiting-approval", "waiting-for-owner"],
  running: ["implementing", "in-progress"],
  ready: ["ready-to-merge", "ready-to-merge"],
  merged: ["merged", "merged"],
} as const;

/** One folded session as the daemon sends it. */
function session(ticket: string, group: keyof typeof STATE_OF, runtime: string): FoldedSession {
  const [phase, state] = STATE_OF[group];
  return {
    ticket,
    session: `s-${ticket}`,
    title: `Ticket ${ticket}`,
    phase,
    state,
    reason: "",
    flowStep: "implementing",
    at: AT,
    runtime,
  };
}

const PROJECTS = [
  { id: "kestrel", name: "Kestrel", repository: "example/kestrel" },
  { id: "osprey", name: "Osprey", repository: "example/osprey" },
];

/** Kestrel: three Codex agents, one of them blocked, and two merges of the day. Osprey: three at work, one ready. */
const STATES: Record<string, { sessions: FoldedSession[] }> = {
  kestrel: {
    sessions: [
      session("KES-1", "running", "codex"),
      session("KES-2", "blocked", "codex"),
      session("KES-3", "running", "codex"),
      session("KES-4", "merged", "claude"),
      session("KES-5", "merged", "codex"),
    ],
  },
  osprey: {
    sessions: [
      session("OSP-1", "running", "claude"),
      session("OSP-2", "running", "opencode"),
      session("OSP-3", "ready", "claude"),
      session("OSP-4", "running", "pi"),
    ],
  },
};

const squadrons = () => PROJECTS.map((p) => skyProject(p, readFleetState(STATES[p.id]), { now: NOW, zone: ZONE }));

/** A 2D context that keeps the frame's triangles per colour and its strokes. */
function fakeContext() {
  let moves = 0;
  const triangles: Record<string, number> = {};
  const strokes: string[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    setTransform() {},
    clearRect() {
      for (const k of Object.keys(triangles)) delete triangles[k];
      strokes.length = 0;
    },
    beginPath() {
      moves = 0;
    },
    moveTo() {
      moves++;
    },
    lineTo() {},
    quadraticCurveTo() {},
    fill() {
      triangles[String(ctx.fillStyle)] = (triangles[String(ctx.fillStyle)] ?? 0) + moves;
    },
    stroke() {
      strokes.push(String(ctx.strokeStyle));
    },
  };
  return { ctx: ctx as unknown as SkyContext, triangles, strokes };
}

test("each project is a squadron: its size, its agents' colours, its arc and its counts", () => {
  const layout = layoutSky(squadrons(), "stage", 1100, 700);
  const of = (id: string) => layout.targets.filter((t) => t.key.startsWith(`${id}/`) && t.group !== "merged");
  // The coordinator's V of five, then one ship per agent in flight; merges fly apart, not in the squadron.
  expect(of("kestrel").map((t) => t.color)).toEqual([
    LIME,
    BONE,
    BONE,
    BONE,
    BONE,
    HARNESS_COLOR.codex,
    HARNESS_COLOR.codex,
    HARNESS_COLOR.codex,
  ]);
  expect(of("osprey").map((t) => t.color)).toEqual([
    LIME,
    BONE,
    BONE,
    BONE,
    BONE,
    HARNESS_COLOR.claude,
    HARNESS_COLOR.opencode,
    BONE,
    HARNESS_COLOR.claude,
  ]);
  // In depth: the squadron with an agent blocked flies nearer, larger than the one at work.
  const lead = (id: string) => of(id)[0]?.size ?? 0;
  expect(lead("kestrel")).toBeGreaterThan(lead("osprey"));
  // A hairline arc under each squadron's agents, in its most urgent state's colour.
  expect(layout.arcs.map((a) => [a.key, a.color])).toEqual([
    ["kestrel", STATE_COLOR.blocked],
    ["osprey", STATE_COLOR.running],
  ]);

  // Drawn as laid out: the harnesses' colours and the arcs reach the canvas.
  const fake = fakeContext();
  const view = createSkyView(fake.ctx, { frame: () => () => {} });
  view.resize(1100, 700, 1);
  view.show(layout);
  expect(fake.triangles[HARNESS_COLOR.codex]).toBe(3);
  expect(fake.triangles[HARNESS_COLOR.claude]).toBe(2);
  expect(fake.triangles[HARNESS_COLOR.opencode]).toBe(1);
  expect(fake.triangles[LIME]).toBe(2);
  expect(fake.strokes).toEqual([STATE_COLOR.blocked, STATE_COLOR.running]);

  // Its name and counts under it, zero counts left out; the blocked number in its colour.
  const words = layout.labels.map((l) => [l.text, l.facts?.map((f) => `${f.n} ${f.text}`).join(" · ")]);
  expect(words).toEqual([
    ["Kestrel", "3 in flight · 2 on their own · 1 blocked · 2 merged today"],
    ["Osprey", "4 in flight · 3 on their own · 1 ready to merge"],
  ]);
  expect(layout.labels[0]?.facts?.find((f) => f.key === "blocked")?.group).toBe("blocked");
  // The link covers the whole squadron: every ship of it, and its words, and nothing of the other.
  for (const label of layout.labels) {
    const area = label.area;
    if (!area) throw new Error(`${label.key} has no area`);
    for (const t of of(label.key)) {
      expect(t.x).toBeGreaterThanOrEqual(area.x);
      expect(t.x).toBeLessThanOrEqual(area.x + area.width);
      expect(t.y).toBeGreaterThanOrEqual(area.y);
      expect(t.y).toBeLessThanOrEqual(area.y + area.height);
    }
    expect(label.y).toBeLessThan(area.y + area.height);
  }
  const [a, b] = layout.labels.map((l) => l.area ?? { x: 0, y: 0, width: 0, height: 0 });
  expect((a?.x ?? 0) + (a?.width ?? 0)).toBeLessThanOrEqual(b?.x ?? 0);
});

test("on a crowded or short sky, no squadron's link reaches over another's", () => {
  const crowd = (n: number, agents: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      coordinator: true,
      agents: Array.from({ length: agents }, (_, k) => ({
        key: `p${i}/T-${k}`,
        ticket: `T-${k}`,
        group: k === 0 ? ("blocked" as const) : ("running" as const),
        harness: "claude" as const,
      })),
    }));
  for (const [n, agents, w, h] of [
    [4, 3, 900, 420],
    [10, 12, 1200, 700],
    [6, 2, 1100, 700],
    [6, 3, 1000, 500],
  ] as const) {
    const labels = layoutSky(crowd(n, agents), "stage", w, h).labels;
    const areas = labels.map((l) => l.area);
    expect(areas).toHaveLength(n);
    // Each squadron's words, "Enter the room" included, lie inside its own link.
    for (const l of labels) {
      if (!l.area) throw new Error("a squadron has no area");
      expect(l.y).toBeGreaterThanOrEqual(l.area.y);
      expect(l.y + SQUADRON_LABEL.height).toBeLessThanOrEqual(l.area.y + l.area.height + 0.001);
    }
    for (const [i, a] of areas.entries())
      for (const b of areas.slice(i + 1)) {
        if (!a || !b) throw new Error("a squadron has no area");
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
  }
});

/** A client the daemon told of these projects and their folded states, and how to tell it more. */
function connect(states: Record<string, { sessions: FoldedSession[] }>) {
  let socket: SocketLike | null = null;
  const client = createDaemonClient({
    url: "ws://daemon.test/",
    open: () => {
      socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
      return socket;
    },
    schedule: () => () => {},
  });
  client.start();
  const say = (m: Record<string, unknown>) =>
    socket?.onmessage?.({ data: JSON.stringify({ version: PROTOCOL_VERSION, ...m }) });
  say({ type: "projects.result", id: "r1", projects: PROJECTS });
  for (const p of PROJECTS)
    say({
      type: "project.subscribed",
      id: `s-${p.id}`,
      subscriptionId: `sub-${p.id}`,
      project: p.id,
      after: 0,
      snapshot: { seq: 1, state: states[p.id] },
    });
  return { client, say };
}

/** The hangar as the app renders it, on these folded states, before the sky measures itself. */
function render(states: Record<string, { sessions: FoldedSession[] }>) {
  const { client } = connect(states);
  return renderToStaticMarkup(
    <DaemonProvider client={client}>
      <Hangar onReload={() => {}} now={NOW} zone={ZONE} />
    </DaemonProvider>,
  );
}

/** The facts line, as it reads. */
const factsLine = (html: string) =>
  (html.match(/<header[^>]*>(.*?)<\/header>/)?.[1] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("the hangar's facts line counts the whole fleet, and its sky holds every squadron", () => {
  const html = render(STATES);
  expect(html.match(/<h1\b[^>]*>(.*?)<\/h1>/)?.[1]).toBe("Hangar");
  expect(factsLine(html)).toBe(
    "Hangar 7 agents in flight 5 moving on their own 1 ready to merge 2 merged today 1 blocked 2 projects",
  );
  expect(html).toMatch(/<b class="[^"]*text-red[^"]*">1<\/b>blocked/);
  expect(html).toContain('data-sky="stage"');
  expect(html).not.toContain("Nothing in flight");
});

test("an empty fleet leaves the sky empty, with one quiet line", () => {
  const html = render({ kestrel: { sessions: [] }, osprey: { sessions: [session("OSP-9", "merged", "claude")] } });
  expect(factsLine(html)).toBe(
    "Hangar 0 agents in flight 0 moving on their own 0 ready to merge 1 merged today 2 projects",
  );
  expect(html).toContain("Nothing in flight. A squadron takes off here when its coordinator launches an agent.");
  // No squadron and no legend: the sky is empty.
  expect(html).toContain('data-sky="stage"');
  expect(html).not.toContain("data-legend");
});

test("the daemon's problem, with its Reload, shows on every screen, not only the hangar", () => {
  const { client, say } = connect(STATES);
  say({ type: "error", code: "app-too-old", message: APP_TOO_OLD });
  const screens = [
    <Hangar key="hangar" onReload={() => {}} now={NOW} zone={ZONE} />,
    <Settings key="settings" address="ws://daemon.test/" onReload={() => {}} />,
    <Project key="room" id="kestrel" onReload={() => {}} />,
  ];
  for (const screen of screens) {
    const html = renderToStaticMarkup(<DaemonProvider client={client}>{screen}</DaemonProvider>);
    const alert = html.match(/<div role="alert"[^>]*>(.*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, " ");
    expect(alert?.replace(/\s+/g, " ").trim()).toBe(`${APP_TOO_OLD} Reload`);
  }
});

test("the address's hash names the screen: the hangar, a project's room, the settings", () => {
  expect(["", "#", "#/", "#/elsewhere"].map((h) => parseRoute(h).screen)).toEqual([
    "hangar",
    "hangar",
    "hangar",
    "hangar",
  ]);
  expect(parseRoute("#/projects/sea%20lane")).toEqual({ screen: "project", id: "sea lane" });
  expect(parseRoute("#/projects/%E0%A4%A")).toEqual({ screen: "hangar" });
  expect(parseRoute("#/settings")).toEqual({ screen: "settings" });
});
