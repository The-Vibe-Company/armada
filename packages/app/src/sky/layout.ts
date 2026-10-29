// Where each ship of the sky belongs (THE-2024), from the fleet's state and
// the sky's size: never from randomness, so the same fleet is the same sky.
// Pure; flock.ts flies the ships to these places.
//
// - The coordinator is a V of five, the mark itself: the lime lead, bone wings,
//   the fainter back ones, at the near depth.
// - Each agent in flight is one triangle in its harness's colour, at the near
//   depth; a blocked one banks away. Ready to merge flies at the middle depth.
// - The tickets merged today are a faint bone V flying away at the far depth.
// - An arc under a group, in its state's colour, says what state it is in.
//
// The band (a project's room, about 200 px tall) lays one project's groups
// side by side, most urgent first, each under its label. The stage (the
// hangar) gives each project its own formation: the coordinator's V, its
// agents fanned out beneath it, its merged V far behind.
import { GROUP_LABEL, GROUPS, type Group } from "@/fleet/overview";
import type { Harness, SkyAgent, SkyProject } from "@/fleet/sky";
import {
  BLOCKED_BANK,
  BONE,
  DART,
  LAYERS,
  LIME,
  MARK_TONES,
  SHIP,
  slotOffset,
  type Target,
  UP,
  V_BACK,
  V_SIDE,
} from "./flock";

export type SkySize = "band" | "stage";

/** The harnesses' colours (the direction's `.aeom/direction`, the landing's `--h-*`). */
export const HARNESS_COLOR: Record<Harness, string> = { claude: "#d97757", codex: "#10a37f", opencode: "#bb87fc" };

/** The states' colours, the app's tokens (src/styles.css), so the sky and the list agree. */
export const STATE_COLOR: Record<Group, string> = {
  blocked: "#fd736d",
  you: "#f2af48",
  running: "#60aaf3",
  ready: "#61cb7c",
  merged: "#84888f",
};

/** At most this many of the day's merges fly in its V; the label counts them all. */
const MERGED_SHOWN = 15;

/** An arc under the ships of `members`, drawn where they are at each frame. */
export interface SkyArc {
  key: string;
  color: string;
  members: string[];
}

/** A word over the sky: a group's name and count on the band, a project's on the stage. */
export interface SkyLabel {
  key: string;
  x: number;
  y: number;
  /** The group, for the band; the coordinator's label has none. */
  group: Group | null;
  text: string;
  count: number | null;
  /** The stage's project labels: what is in flight, in words, within their cell's width. */
  detail?: string;
  width?: number;
}

export interface SkyLayout {
  targets: Target[];
  arcs: SkyArc[];
  labels: SkyLabel[];
}

const NEAR = 2;
const MIDDLE = 1;
const FAR = 0;

/** Each group's depth and heading: a small lean each, so the V's do not read as a grid. */
const LOOK: Record<Group, { depth: number; tilt: number }> = {
  blocked: { depth: NEAR, tilt: -0.7 },
  you: { depth: NEAR, tilt: 0.06 },
  running: { depth: NEAR, tilt: -0.05 },
  ready: { depth: MIDDLE, tilt: 0.08 },
  merged: { depth: FAR, tilt: -0.28 },
};
const COORDINATOR_TILT = -0.14;

export function layoutSky(projects: readonly SkyProject[], size: SkySize, width: number, height: number): SkyLayout {
  if (width <= 0 || height <= 0) return { targets: [], arcs: [], labels: [] };
  return size === "band" ? band(projects, width, height) : stage(projects, width, height);
}

/** One V of the formation: its ships, their look, and how it is spaced. */
interface Wing {
  id: string;
  group: Group | null;
  ships: Omit<Target, "x" | "y" | "angle" | "depth" | "size" | "stretch">[];
  depth: number;
  size: number;
  stretch: number;
  tilt: number;
  /** Spacing over the flock's own V. */
  spread: number;
  label: SkyLabel["text"];
  count: number;
}

/** The sky's words for each state: short, "Waiting for you" rather than the list's "Waiting for your decision". */
export const SKY_GROUP_LABEL: Record<Group, string> = { ...GROUP_LABEL, you: "Waiting for you" };

/** About how wide a band label is, in Geist at 13 px: a group never gets narrower than its words. */
const labelWidth = (w: Wing) => w.label.length * 6.6 + (w.group ? String(w.count).length * 7.8 + 6 : 0) + 16;

const agentShip = (a: SkyAgent) => ({
  key: a.key,
  group: a.group,
  color: a.group === "merged" ? BONE : a.harness ? HARNESS_COLOR[a.harness] : BONE,
  tone: a.group === "merged" ? 0.75 : a.harness ? 1 : 0.7,
  bank: a.group === "blocked" ? BLOCKED_BANK : 0,
});

const coordinatorShips = (project: string) =>
  MARK_TONES.map((tone, k) => ({
    key: `${project}/coordinator/${k}`,
    group: "coordinator",
    color: k === 0 ? LIME : BONE,
    tone,
    bank: 0,
  }));

/** The ship length of a wing, in CSS pixels. */
const lengthOf = (w: Pick<Wing, "depth" | "size">, f: number) => SHIP * LAYERS[w.depth as 0 | 1 | 2].scale * w.size * f;
const rowsOf = (n: number) => Math.ceil((n - 1) / 2);

/** A V's slots, its lead at (x, y). */
function place(w: Wing, x: number, y: number, f: number, back: number, side: number): Target[] {
  const angle = UP + w.tilt;
  return w.ships.map((s, k) => {
    const o = slotOffset(k, angle, back, side);
    return { ...s, x: x + o.x, y: y + o.y, angle, depth: w.depth, size: w.size * f, stretch: w.stretch };
  });
}

function wingsOf(project: SkyProject, size: SkySize): Wing[] {
  const wings: Wing[] = [];
  if (project.coordinator)
    wings.push({
      id: "coordinator",
      group: null,
      ships: coordinatorShips(project.id),
      depth: NEAR,
      size: size === "band" ? 1.05 : 1,
      stretch: 1,
      tilt: COORDINATOR_TILT,
      spread: 0.8,
      label: "Coordinator",
      count: 0,
    });
  for (const group of GROUPS) {
    const agents = project.agents.filter((a) => a.group === group);
    if (!agents.length) continue;
    const shown = group === "merged" ? agents.slice(-MERGED_SHOWN) : agents;
    wings.push({
      id: group,
      group,
      ships: shown.map(agentShip),
      depth: LOOK[group].depth,
      size: group === "merged" ? 1.5 : 1.3,
      stretch: DART,
      tilt: LOOK[group].tilt,
      spread: group === "merged" ? 0.7 : 1,
      label: SKY_GROUP_LABEL[group],
      count: agents.length,
    });
  }
  return wings;
}

const BAND = { top: 44, bottom: 60, edge: 40, gap: 28 } as const;
/** A group's V on the band is flatter and wider than the flock's: the band is short. */
const BAND_V = { back: 0.55, side: 1.2 } as const;
/** A crowded group flies as several V's of at most this many, side by side. */
const BAND_CHUNK = 7;

/** One project's groups side by side, most urgent first, the coordinator leading. */
function band(projects: readonly SkyProject[], width: number, height: number): SkyLayout {
  const project = projects[0];
  if (!project) return { targets: [], arcs: [], labels: [] };
  const wings = wingsOf(project, "band");
  const room = {
    width: width - 2 * BAND.edge - BAND.gap * (wings.length - 1),
    height: height - BAND.top - BAND.bottom,
  };
  const natural = (w: Wing, f: number) => {
    const len = lengthOf(w, f);
    const flat = w.group ? BAND_V : { back: 1, side: 1 };
    return { len, back: V_BACK * len * w.spread * flat.back, side: V_SIDE * len * w.spread * flat.side };
  };
  // The merged V and the coordinator stay one V each; the agents of a state split past BAND_CHUNK.
  const chunkOf = (w: Wing) => (w.group && w.group !== "merged" ? BAND_CHUNK : w.ships.length);
  const chunks = (w: Wing) => {
    const out: Wing["ships"][] = [];
    for (let k = 0; k < w.ships.length; k += chunkOf(w)) out.push(w.ships.slice(k, k + chunkOf(w)));
    return out;
  };
  const vWidth = (n: number, len: number, side: number) => 2 * rowsOf(n) * side + 2 * len;
  /** A wing's V's on `lines` lines: each line's V's and its width. */
  const linesOf = (w: Wing, f: number, lines: number) => {
    const { len, side } = natural(w, f);
    const all = chunks(w);
    const per = Math.ceil(all.length / lines);
    const out: { vs: Wing["ships"][]; width: number }[] = [];
    for (let k = 0; k < all.length; k += per) {
      const vs = all.slice(k, k + per);
      out.push({ vs, width: vs.reduce((sum, c, i) => sum + vWidth(c.length, len, side) + (i ? len : 0), 0) });
    }
    return out;
  };
  const shipsWidth = (w: Wing, f: number, lines: number) => Math.max(0, ...linesOf(w, f, lines).map((l) => l.width));
  const widthOf = (w: Wing, f: number, lines: number) => Math.max(shipsWidth(w, f, lines), labelWidth(w));
  // Shrink everything together when the groups do not fit side by side; past
  // half size, a crowded group's V's stack on two lines, then three.
  const total = (f: number, lines: number) => wings.reduce((n, w) => n + widthOf(w, f, lines), 0);
  let f = 1;
  let lines = 1;
  while (total(f, lines) > room.width && (f > 0.3 || lines < 3)) {
    if (f > 0.5 || (lines === 3 && f > 0.3)) f -= 0.05;
    else {
      lines += 1;
      f = 0.8;
    }
  }
  const used = total(f, lines);
  const air = Math.max(0, room.width - used) / (wings.length + 1);
  const targets: Target[] = [];
  const arcs: SkyArc[] = [];
  const labels: SkyLabel[] = [];
  let x = BAND.edge + air;
  for (const w of wings) {
    const span = widthOf(w, f, lines);
    const cx = x + span / 2;
    x += span + BAND.gap + air;
    const { len, back: open, side } = natural(w, f);
    const placed: Target[] = [];
    const rowsOfLines = linesOf(w, f, lines);
    const lineHeight = room.height / rowsOfLines.length;
    rowsOfLines.forEach((line, l) => {
      let left = cx - line.width / 2;
      for (const ships of line.vs) {
        const rows = rowsOf(ships.length);
        const vw = vWidth(ships.length, len, side);
        // A long V flattens rather than leave its line.
        const back = Math.max(0, Math.min(open, rows ? (lineHeight - 2 * len) / rows : 0));
        const top = BAND.top + l * lineHeight + (lineHeight - rows * back) / 2;
        placed.push(...place({ ...w, ships }, left + vw / 2, top, f, back, side));
        left += vw + len;
      }
    });
    targets.push(...placed);
    labels.push({ key: w.id, x: cx, y: 12, group: w.group, text: w.label, count: w.group ? w.count : null });
    if (w.group && w.group !== "merged")
      arcs.push({ key: w.id, color: STATE_COLOR[w.group], members: placed.map((t) => t.key) });
  }
  return { targets, arcs, labels };
}

/** The hangar: one formation per project, spread over the sky. */
function stage(projects: readonly SkyProject[], width: number, height: number): SkyLayout {
  const targets: Target[] = [];
  const arcs: SkyArc[] = [];
  const labels: SkyLabel[] = [];
  const n = projects.length;
  if (!n) return { targets, arcs, labels };
  const usable = { x: 32, y: 32, width: width - 64, height: height - 96 };
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt((n * usable.width) / usable.height / 1.2))));
  const rows = Math.ceil(n / cols);
  const cell = { width: usable.width / cols, height: usable.height / rows };
  const fit = Math.max(0.45, Math.min(1.3, Math.min(cell.width / 400, cell.height / 330)));
  projects.forEach((project, i) => {
    // A crowded project's formation is smaller, so it stays in its cell.
    const crowd = project.agents.filter((a) => a.group !== "merged").length;
    const f = fit * Math.max(0.55, Math.min(1, Math.sqrt(14 / Math.max(14, crowd))));
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Every other column sits a little lower: squadrons, not a table.
    const stagger = cols > 1 && rows === 1 ? (col % 2 ? 0.08 : -0.06) * cell.height : 0;
    const cx = usable.x + cell.width * (col + 0.5);
    const cy = usable.y + cell.height * (row + 0.45) + stagger;
    const lean = i % 2 ? 0.2 : -0.2;
    const wings = wingsOf(project, "stage");
    let bottom = cy;
    for (const w of wings) {
      if (w.id === "coordinator") {
        const len = lengthOf(w, f);
        const placed = place(
          { ...w, tilt: lean },
          cx,
          cy - 70 * f,
          f,
          V_BACK * len * w.spread,
          V_SIDE * len * w.spread,
        );
        targets.push(...placed);
        bottom = Math.max(bottom, ...placed.map((t) => t.y));
      }
    }
    // Its agents in flight, fanned out on arcs beneath the coordinator, most urgent first.
    const flying = wings.filter((w) => w.group && w.group !== "merged");
    const ships = flying.flatMap((w) => w.ships.map((s) => ({ ship: s, wing: w })));
    const PER_ROW = Math.max(9, Math.min(16, Math.ceil(Math.sqrt(2 * ships.length))));
    ships.forEach(({ ship, wing }, j) => {
      const r = Math.floor(j / PER_ROW);
      const inRow = Math.min(PER_ROW, ships.length - r * PER_ROW);
      const k = j - r * PER_ROW;
      const t = inRow > 1 ? (k / (inRow - 1)) * 2 - 1 : 0;
      const half = Math.min(22 * PER_ROW * 0.55, 22 * (inRow - 1)) * f + r * 18 * f;
      const x = cx + t * half;
      const y = cy + (24 + (1 - t * t) * 26 + r * 44) * f;
      const fan = UP + t * 0.45 + (wing.group === "blocked" ? LOOK.blocked.tilt : 0);
      targets.push({ ...ship, x, y, angle: fan, depth: wing.depth, size: 1.1 * f, stretch: DART });
      bottom = Math.max(bottom, y);
    });
    if (ships.length) {
      const urgent = flying[0]?.group ?? "running";
      arcs.push({ key: project.id, color: STATE_COLOR[urgent], members: ships.map((s) => s.ship.key) });
    }
    // The day's merges: a faint V flying away behind it.
    const merged = wings.find((w) => w.group === "merged");
    if (merged) {
      const len = lengthOf(merged, f);
      targets.push(
        ...place(
          { ...merged, tilt: 0.5 },
          cx + 150 * f,
          cy - 110 * f,
          f,
          V_BACK * len * merged.spread,
          V_SIDE * len * merged.spread,
        ),
      );
    }
    const count = (g: Group) => project.agents.filter((a) => a.group === g).length;
    const inFlight = project.agents.length - count("merged");
    const detail = [
      `${inFlight} in flight`,
      count("blocked") && `${count("blocked")} blocked`,
      count("you") && `${count("you")} waiting for you`,
      count("merged") && `${count("merged")} merged today`,
    ]
      .filter(Boolean)
      .join(" · ");
    labels.push({
      key: project.id,
      x: cx,
      y: bottom + 34 * f,
      group: null,
      text: project.name,
      count: null,
      detail,
      width: cell.width - 24,
    });
  });
  return { targets, arcs, labels };
}
