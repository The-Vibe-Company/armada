// What the landing's replica of the fleet plays (THE-887, THE-931), restored
// by #564. In armada-v1-final the replica drew the v1 dashboard's own overview
// from the demo world (`bun run demo:seed`); neither is on main, so this is
// that overview's list as the archived landing showed it, held as static data:
// the same sessions, reasons and steps, and the same beats. The coordinator
// answers WID-15's question and the worker goes back to work, WID-18 hands
// back a green pull request, then its merge waits for the owner. Pure: no
// DOM, no clock; times are minutes on the replica's own clock.

export type Group = "blocked" | "you" | "running" | "ready" | "merged";
export type Stage = "opening" | "delivered" | "handed-back" | "to-validate";
export type Project = "Widgets" | "Gadgets" | "Armada";

/** The question the coordinator answers, and the hand-back whose merge the owner validates. */
export const ASKED = "WID-15";
export const HANDED_BACK = "WID-18";

/** The overview's groups, in its order, with their color and hint (v1's lib/i18n.ts). */
export const GROUPS: { group: Group; name: string; hint: string; color: string }[] = [
  { group: "blocked", name: "Blocked", hint: "can't go on without someone", color: "var(--red)" },
  {
    group: "you",
    name: "Waiting for your decision",
    hint: "a plan, a merge or a question for you",
    color: "var(--amber)",
  },
  { group: "running", name: "In progress", hint: "moving on its own", color: "var(--blue)" },
  { group: "ready", name: "Ready to merge", hint: "approved, the coordinator merges", color: "var(--green)" },
  { group: "merged", name: "Merged today", hint: "", color: "var(--text-3)" },
];

/** A session's six steps, plan to merge; `step` is the index of the one it is on. */
export const STEPS = ["Plan", "Approval", "Code", "Review & CI", "Ready", "Merged"] as const;

export interface Row {
  id: string;
  title: string;
  project: Project;
  group: Group;
  /** Why it is where it is; `{silent}` reads the time since its last report. */
  reason: string;
  step: number;
  /** Its last report (a merge, when merged), in minutes on the replica's clock: 0 is the loop's start. */
  at: number;
}

/** The sessions as the replica opens, in the overview's order. */
const OPENING: Row[] = [
  {
    id: ASKED,
    title: "Sign in with a magic link",
    project: "Widgets",
    group: "blocked",
    reason: "Unanswered question: How long should a sign-in link stay valid?",
    step: 2,
    at: -12,
  },
  {
    id: "WID-17",
    title: "Retry failed webhook deliveries",
    project: "Widgets",
    group: "blocked",
    reason: "Silent for {silent}",
    step: 2,
    at: -42,
  },
  {
    id: "WID-14",
    title: "Show the invoice total on the order page",
    project: "Widgets",
    group: "blocked",
    reason: "Red CI on #41",
    step: 3,
    at: -4,
  },
  {
    id: "GAD-5",
    title: "Speed up the product search page",
    project: "Gadgets",
    group: "blocked",
    reason: "Conflict with main on #12",
    step: 3,
    at: -2,
  },
  {
    id: "GAD-3",
    title: "Import products from a spreadsheet",
    project: "Gadgets",
    group: "you",
    reason: "Plan to approve",
    step: 1,
    at: -18,
  },
  {
    id: "THE-858",
    title: "Show the harness on every session",
    project: "Armada",
    group: "ready",
    reason: "Approved by Ada Lovelace · #317 green",
    step: 4,
    at: -9,
  },
  {
    id: HANDED_BACK,
    title: "Add a dark theme to the settings page",
    project: "Widgets",
    group: "running",
    reason: "Handed back: CI green on the final head",
    step: 3,
    at: -6,
  },
  {
    id: "THE-862",
    title: "Add a local Codex harness adapter",
    project: "Armada",
    group: "you",
    reason: "Question: Should the local Codex adapter ship behind a flag first?",
    step: 2,
    at: -1,
  },
  {
    id: "GAD-9",
    title: "Design the catalogue's product card",
    project: "Gadgets",
    group: "you",
    reason:
      "Two directions for the product card: A keeps the photo square, B lets it bleed to the edges. Pick one, or say what to change.",
    step: 2,
    at: -14,
  },
  {
    id: "WID-12",
    title: "Let users export a report as CSV",
    project: "Widgets",
    group: "running",
    reason: "Streaming rows instead of building the file in memory",
    step: 2,
    at: -3,
  },
  {
    id: "GAD-6",
    title: "Send a weekly digest email",
    project: "Gadgets",
    group: "running",
    reason: "Reading the spec and the mailer code",
    step: 0,
    at: -4,
  },
  ...(
    [
      ["THE-130", "Explain why a coupon was refused (3)", "Armada", -172],
      ["THE-127", "Let a customer change the shipping address (3)", "Armada", -205],
      ["GAD-105", "Sort orders by date", "Gadgets", -260],
      ["THE-126", "Retry a failed payment once (3)", "Armada", -284],
      ["THE-129", "Sort orders by date (3)", "Armada", -301],
    ] as const
  ).map(([id, title, project, at]) => ({
    id,
    title,
    project,
    group: "merged" as const,
    reason: `#${id.split("-")[1]} merged`,
    step: 5,
    at,
  })),
];

/** The projects' cards: tickets done of all, and their coordinator (idle since, in minutes on the clock). */
export const PROJECTS: { name: Project; done: number; total: number; idleSince: number | null }[] = [
  { name: "Widgets", done: 14, total: 24, idleSince: null },
  { name: "Gadgets", done: 6, total: 11, idleSince: -24 },
  { name: "Armada", done: 31, total: 35, idleSince: null },
];

/** Validations open before the beats: GAD-3's plan and GAD-9's design. */
const OPEN_VALIDATIONS = 2;

/** The beats' times, in minutes on the replica's clock, as the replica passes them. */
export interface Beats {
  delivered: number;
  handedBack: number;
}

/** The sessions at `stage`: each beat moves one row, the way the dashboard's poll would bring it. */
export function rowsAt(stage: Stage, beats: Beats): Row[] {
  const reached = (s: Stage) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(s);
  return OPENING.map((row) => {
    if (row.id === ASKED && reached("delivered"))
      return {
        ...row,
        group: "running",
        reason: "Resumed: a sign-in link expires after 15 minutes",
        step: 2,
        at: beats.delivered,
      };
    if (row.id === HANDED_BACK && reached("to-validate"))
      return { ...row, group: "you", reason: "Merge to approve · #44 green", step: 4, at: beats.handedBack };
    if (row.id === HANDED_BACK && reached("handed-back"))
      return { ...row, group: "ready", reason: "Handed back · #44 green", step: 4, at: beats.handedBack };
    return row;
  });
}

const STAGE_ORDER: Stage[] = ["opening", "delivered", "handed-back", "to-validate"];

/** A short duration: "<1 min", "12 min", "3 h 05" (v1's lib/i18n.ts). */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return rest ? `${Math.floor(m / 60)} h ${String(rest).padStart(2, "0")}` : `${Math.floor(m / 60)} h`;
}

const agents = (n: number) => (n === 1 ? "1 agent" : `${n} agents`);

/** What the overview says of the sessions at one moment: its lines, counts and each project's facts. */
export function summary(rows: Row[], stage: Stage) {
  const count = (group: Group, project?: Project) =>
    rows.filter((r) => r.group === group && (!project || r.project === project)).length;
  const live = rows.filter((r) => r.group !== "merged");
  const blocked = count("blocked");
  const you = count("you");
  const waits = you === 0 ? "nothing waits for your decision" : `${you} waiting for your decision`;
  const headline = blocked
    ? `${agents(blocked)} blocked, ${waits}.`
    : you
      ? `Nothing blocked. ${waits}.`
      : "Everything is moving, nothing is waiting.";
  const subline = [
    `${agents(live.length)} in flight across ${PROJECTS.length} projects`,
    `${count("running")} moving on their own`,
    `${count("ready")} ready to merge`,
    `${count("merged")} merged today`,
  ].join(" · ");
  return {
    headline,
    subline,
    live: live.length,
    all: rows.length,
    validations: OPEN_VALIDATIONS + (stage === "to-validate" ? 1 : 0),
    projects: PROJECTS.map((p) => ({
      ...p,
      blocked: count("blocked", p.name),
      you: count("you", p.name),
      running: count("running", p.name),
      live: live.filter((r) => r.project === p.name).length,
      all: rows.filter((r) => r.project === p.name).length,
    })),
  };
}
