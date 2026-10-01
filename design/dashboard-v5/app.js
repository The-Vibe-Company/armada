// Armada dashboard v5 prototype, "Night watch" (THE-898). Plain JS, no
// dependency: hash routes over a synthetic Acme world (the demo's projects:
// Armada, Gadgets, Widgets). Not product code: THE-899 builds the approved
// look in packages/dashboard with the page kit.
"use strict";

/* ───────────────────────── The synthetic world ───────────────────────── */

const NOW = "17:40";
const HARNESS = {
  conductor: { name: "Conductor Cloud", c: "var(--h-conductor)" },
  claude: { name: "Claude Code", c: "var(--h-claude)" },
  codex: { name: "Codex", c: "var(--h-codex)" },
};
const PROJECTS = [
  {
    slug: "armada",
    name: "Armada",
    c: "#b6f15a",
    repo: "The-Vibe-Company/armada",
    root: "THE-812",
    rootTitle: "Armada roadmap",
    done: 31,
    total: 35,
    health: ["Needs watching", "var(--silent)"],
    owner: "Camille Roux",
    coord: { harness: "codex", handle: "camille-mbp/ttys011", model: "gpt-6.1-sol", state: "active", seen: "7 min ago", since: "14:23", waiting: 1 },
    prs: "1 open, 1 green",
    activity: "1 min ago",
  },
  {
    slug: "gadgets",
    name: "Gadgets",
    c: "#ffb547",
    repo: "acme/gadgets",
    root: "GAD-1",
    rootTitle: "Gadgets catalogue",
    done: 11,
    total: 20,
    health: ["Blocked", "var(--fail)"],
    owner: "Hugo Lefèvre",
    coord: { harness: "claude", handle: "hugo-mbp/ttys004", model: "opus-5-5-1m", state: "idle", seen: "29 min", since: "13:05", waiting: 1 },
    prs: "1 open, 0 green",
    activity: "2 min ago",
  },
  {
    slug: "widgets",
    name: "Widgets",
    c: "#7ea6ff",
    repo: "acme/widgets",
    root: "WID-1",
    rootTitle: "Widgets storefront",
    done: 14,
    total: 24,
    health: ["Blocked", "var(--fail)"],
    owner: "Inès Moreau",
    coord: { harness: "conductor", handle: "ws-0c01/coord", model: "opus-5-5-1m", state: "active", seen: "8 min ago", since: "12:48", waiting: 2 },
    prs: "2 open, 1 green",
    activity: "3 min ago",
  },
];
const P = Object.fromEntries(PROJECTS.map((p) => [p.slug, p]));

// state: yours | fail | silent | flight | merge (ready to merge)
// step: 0 plan · 1 approval · 2 implementation · 3 PR · 4 CI · 5 merge
const AGENTS = [
  { id: "WID-15", project: "widgets", title: "Sign in with a magic link", line: "How long should a sign-in link stay valid?", state: "yours", phase: "Waiting for your answer", step: 1, harness: "conductor", t: "12 min" },
  { id: "GAD-3", project: "gadgets", title: "Import products from a spreadsheet", line: "Plan posted: parse, validate, then import in one transaction", state: "yours", phase: "Waiting for your approval", step: 1, harness: "claude", t: "18 min" },
  { id: "GAD-9", project: "gadgets", title: "Design the catalogue's product card", line: "Two directions for the product card, attached for your validation", state: "yours", phase: "Waiting for your validation", step: 2, harness: "conductor", t: "14 min" },
  { id: "GAD-5", project: "gadgets", title: "Speed up the product search page", line: "Rebasing on main after the catalogue change", state: "fail", phase: "Conflict with main", step: 4, harness: "conductor", t: "2 min" },
  { id: "WID-14", project: "widgets", title: "Show the invoice total on the order page", line: "Fixing the rounding test that fails in CI", state: "fail", phase: "Red CI", step: 4, harness: "conductor", t: "4 min" },
  { id: "WID-17", project: "widgets", title: "Retry failed webhook deliveries", line: "Backoff schedule written, wiring the queue", state: "silent", phase: "Silent for 42 min", step: 2, harness: "codex", t: "42 min" },
  { id: "THE-862", project: "armada", title: "Add a local Codex harness adapter", line: "Mapping Codex session events onto armada report", state: "flight", phase: "Implementing", step: 2, harness: "conductor", t: "1 min" },
  { id: "WID-12", project: "widgets", title: "Let users export a report as CSV", line: "Streaming rows instead of building the file in memory", state: "flight", phase: "Implementing", step: 2, harness: "claude", t: "3 min" },
  { id: "GAD-6", project: "gadgets", title: "Send a weekly digest email", line: "Reading the spec and the mailer code", state: "plan", phase: "Planning", step: 0, harness: "codex", t: "4 min" },
  { id: "THE-858", project: "armada", title: "Show the harness on every session", line: "Handed back: PR #317 green, head 7c1e0a4", state: "merge", phase: "Ready to merge", step: 5, harness: "conductor", t: "9 min" },
  { id: "WID-18", project: "widgets", title: "Add a dark theme to the settings page", line: "Handed back: CI green on the final head", state: "merge", phase: "Ready to merge", step: 5, harness: "claude", t: "6 min" },
];
const A = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

const BANDS = [
  { key: "yours", label: "Waiting for your decision", side: "oldest 18 min" },
  { key: "fail", label: "Failing" },
  { key: "silent", label: "Silent", side: "no heartbeat for 15 min" },
  { key: "flight", label: "In progress", states: ["flight", "plan"] },
  { key: "merge", label: "Ready to merge", side: "the coordinator merges" },
];

// The live timeline: minutes before now, over a 180-minute window (14:40 → 17:40).
const WINDOW = 180;
const TIMELINE = {
  armada: {
    coord: { live: [[180, 7]], idle: null, end: ["active · 7 min ago", "var(--done)"] },
    rows: [
      { id: "THE-858", trail: [[180, 150, "flight"], [150, 110, "yours"], [110, 40, "flight"], [40, 12, "flight"]], now: [12, "merge"], reports: [172, 160, 140, 121, 96, 70, 55, 30, 20], pr: 40 },
      { id: "THE-862", trail: [[63, 46, "flight"], [46, 31, "yours"]], now: [31, "flight"], reports: [60, 52, 45, 19, 7, 1] },
    ],
  },
  gadgets: {
    coord: { live: [[180, 29]], idle: [29, 0], end: ["idle for 29 min", "var(--silent)"] },
    rows: [
      { id: "GAD-3", trail: [[70, 18, "flight"]], now: [18, "yours"], reports: [66, 52, 40, 24] },
      { id: "GAD-5", trail: [[180, 168, "flight"], [168, 110, "flight"], [62, 30, "flight"]], silence: [110, 62], now: [30, "fail"], reports: [176, 160, 140, 120, 58, 44, 33, 12, 2], pr: 30 },
      { id: "GAD-9", trail: [[95, 80, "flight"], [80, 14, "flight"]], now: [14, "yours"], reports: [92, 84, 70, 52, 40, 28, 16] },
      { id: "GAD-6", trail: [], now: [12, "flight"], reports: [11, 8, 4] },
    ],
  },
  widgets: {
    coord: { live: [[180, 8]], idle: null, end: ["active · 8 min ago", "var(--done)"] },
    rows: [
      { id: "WID-15", trail: [[100, 40, "flight"], [40, 12, "flight"]], now: [12, "yours"], reports: [96, 86, 70, 55, 41, 30, 14] },
      { id: "WID-18", trail: [[180, 160, "flight"], [160, 120, "yours"], [120, 60, "flight"], [60, 6, "flight"]], now: [6, "merge"], reports: [176, 150, 130, 110, 92, 75, 66, 40, 22, 9], pr: 60 },
      { id: "WID-17", trail: [[115, 100, "flight"], [100, 42, "flight"]], now: [42, "silent"], silent: true, reports: [112, 96, 82, 64, 50, 43] },
      { id: "WID-14", trail: [[165, 150, "flight"], [150, 110, "yours"], [110, 30, "flight"], [30, 4, "flight"]], now: [4, "fail"], reports: [160, 140, 104, 88, 70, 52, 34, 20, 6], pr: 30 },
      { id: "WID-12", trail: [[65, 50, "flight"]], now: [50, "flight"], reports: [62, 54, 44, 30, 18, 3] },
    ],
  },
};

const DECISIONS = [
  { kind: "coord", label: "Coordinator stopped", c: "var(--silent)", when: "29 min ago", title: "Bring back the Gadgets coordinator", project: "gadgets", body: "Its last command was 29 min ago and 1 item waits for it. Open its session and have it run armada watch again, or start a new coordinator.", oldest: true },
  { kind: "question", label: "Question for you", c: "var(--flight)", when: "27 min ago", title: "Add a local Codex harness adapter", project: "armada", id: "THE-862", quote: "Should the local Codex adapter ship behind a flag first?", why: "a product choice the worker escalated", choices: ["Behind a flag", "On for everyone"] },
  { kind: "validation", label: "To validate", c: "var(--yours)", when: "19 min ago", title: "Design the catalogue's product card", project: "gadgets", id: "GAD-9", quote: "Two directions for the product card: A keeps the photo square, B lets it bleed to the edges. Pick one, or say what to change.", shots: ["Direction A: square photo", "Direction B: full-bleed photo", "Both on a phone"] },
  { kind: "merge", label: "Merge to approve", c: "var(--done)", when: "10 min ago", title: "Add a dark theme to the settings page", project: "widgets", id: "WID-18", why: "touches the settings page users see; the rule keeps front-end changes for you", pr: { n: 44, title: "Add a dark theme to the settings page", add: 151, del: 15, files: 3, sha: "a3f9c2e" } },
];

// Insights: 30 days of merges (UTC days), oldest first; the previous 30 for the ghost bars.
const SHIPPED = [0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 2, 1, 0, 1, 2, 1, 1, 2, 1, 1, 2, 1, 3, 5, 4, 3, 6, 4, 5];
const SHIPPED_PREV = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 2, 1, 1, 2, 2, 3, 3, 4, 3, 4];
const CYCLE = [null, null, 6.2, null, 5.8, 6.4, null, 6.0, null, 5.6, 5.9, 5.1, 6.3, null, 5.5, 5.2, 5.7, 4.9, 5.4, 5.0, 5.6, 4.8, 5.3, 5.1, 4.6, 5.4, 5.0, 4.4, 5.2, 4.9];
const CYCLE_P90 = CYCLE.map((v, i) => (v == null ? null : v + 1.6 + ((i * 7) % 5) / 6));
const PHASE_TIME = [
  { label: "Planning", h: 33, med: "39 min", c: "var(--flight)", op: 0.55 },
  { label: "Waiting for approval", h: 36, med: "30 min", c: "var(--yours)", op: 0.9, who: "you" },
  { label: "Implementing", h: 128, med: "2 h 36", c: "var(--flight)", op: 1 },
  { label: "CI and review", h: 30, med: "36 min", c: "var(--flight)", op: 0.75 },
  { label: "Waiting for an answer", h: 8.6, med: "47 min", c: "var(--yours)", op: 0.6, who: "you" },
  { label: "Waiting for merge", h: 44, med: "42 min", c: "var(--silent)", op: 0.9, who: "coordinator" },
];
const WAITS = [
  { id: "THE-125", title: "Show the delivery date on the order page", phase: "Waiting for merge", since: "Wed 30 Sept", d: "3 h 15", m: 195, c: "var(--silent)" },
  { id: "WID-104", title: "Send the receipt again from the account page", phase: "Waiting for approval", since: "Wed 23 Sept", d: "2 h 19", m: 139, c: "var(--yours)" },
  { id: "THE-112", title: "Keep the cart when a session expires", phase: "Waiting for merge", since: "Fri 25 Sept", d: "2 h 06", m: 126, c: "var(--silent)" },
  { id: "THE-126", title: "Retry a failed payment once", phase: "Waiting for approval", since: "Thu 1 Oct", d: "2 h 06", m: 126, c: "var(--yours)" },
  { id: "THE-128", title: "Send the receipt again from the account page", phase: "Waiting for approval", since: "Thu 1 Oct", d: "2 h 04", m: 124, c: "var(--yours)" },
];

// The fleet's activity (THE-894): newest first, today; the owner last looked at 16:20.
// kind: merge | claim | report | handback | question | validation | plan | decision | coord
const LAST_VISIT = "16:20";
const FEED = [
  ["17:39", "report", "THE-862", "Add a local Codex harness adapter", "Mapping Codex session events onto armada report", "armada", "agent", 3],
  ["17:38", "report", "GAD-5", "Speed up the product search page", "Rebasing on main after the catalogue change", "gadgets", "agent", 1],
  ["17:36", "validation", "WID-18", "Add a dark theme to the settings page", "Merge to approve: touches the settings page users see", "widgets", "coordinator"],
  ["17:35", "handback", "WID-18", "Add a dark theme to the settings page", "PR #44 is ready: head a3f9c2e, CI green", "widgets", "agent"],
  ["17:34", "claim", "GAD-6", "Send a weekly digest email", "Codex, profile codex", "gadgets", "agent"],
  ["17:31", "handback", "THE-858", "Show the harness on every session", "PR #317 is ready: head 7c1e0a4, CI green", "armada", "agent"],
  ["17:28", "question", "WID-15", "Sign in with a magic link", "How long should a sign-in link stay valid?", "widgets", "agent"],
  ["17:26", "validation", "GAD-9", "Design the catalogue's product card", "Two directions for the product card, attached", "gadgets", "agent"],
  ["17:22", "plan", "GAD-3", "Import products from a spreadsheet", "Parse the sheet, validate every row, then import in one transaction", "gadgets", "agent"],
  ["17:18", "question", "THE-862", "Add a local Codex harness adapter", "Should the local Codex adapter ship behind a flag first?", "armada", "coordinator"],
  ["17:00", "decision", "THE-858", "Show the harness on every session", "Approved: looks right on mobile too", "armada", "Ada Lovelace"],
  ["16:58", "silent", "WID-17", "Retry failed webhook deliveries", "No heartbeat since 16:58", "widgets", "agent"],
  ["16:56", "claim", "GAD-3", "Import products from a spreadsheet", "Claude Code, profile opus", "gadgets", "agent"],
  ["16:42", "claim", "THE-862", "Add a local Codex harness adapter", "Conductor Cloud, profile opus", "armada", "agent"],
  ["16:31", "merge", "THE-131", "Keep the coupon when the cart changes", "PR #312 merged, the release follows", "armada", "coordinator"],
  ["16:25", "claim", "WID-12", "Let users export a report as CSV", "Claude Code, profile opus", "widgets", "agent"],
  ["16:12", "merge", "THE-130", "Explain why a coupon was refused", "PR #309 merged", "armada", "coordinator"],
  ["16:05", "coord", null, "Gadgets coordinator started", "Claude Code on hugo-mbp/ttys004", "gadgets", "coordinator"],
  ["15:48", "merge", "WID-11", "Show the order number in the receipt", "PR #41 merged", "widgets", "coordinator"],
  ["15:23", "merge", "THE-127", "Let a customer change the shipping address", "PR #305 merged", "armada", "coordinator"],
];
const AWAY = {
  since: "14:20",
  // minutes after 14:20 for each event, over 200 minutes to 17:40
  marks: [
    [18, "merge"], [41, "claim"], [63, "merge"], [88, "merge"], [105, "claim"], [112, "merge"], [131, "merge"], [142, "claim"],
    [158, "silent"], [176, "claim"], [184, "merge"], [196, "yours"],
  ],
};

/* ───────────────────────── Prototype state ───────────────────────── */

const state = {
  density: "compact",
  mode: "live", // live | loading | empty | error
  motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full",
  horizon: "auto", // auto | calm | yours | fail | clear
  away: "on", // the overview's "Since you were away": on | off
  panelOpen: true,
  merged: new Set(),
  selected: -1,
};
const params = new URLSearchParams(location.search);
for (const k of ["density", "mode", "motion", "horizon", "away"]) if (params.get(k)) state[k] = params.get(k);
if (params.get("panel") === "off") document.documentElement.classList.add("hide-shots");

/* ───────────────────────── Marks and glyphs ───────────────────────── */

const SHIPS = [
  "M16 4.5L20 11.5H12Z",
  "M10 13L14 20H6Z",
  "M22 13L26 20H18Z",
  "M4 21.5L8 28.5H0Z",
  "M28 21.5L32 28.5H24Z",
];
function mark(size = 18, cls = "") {
  return `<svg class="live-mark ${cls}" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <path class="lead" d="${SHIPS[0]}"/><path d="${SHIPS[1]}" fill="#f2f1ee"/><path d="${SHIPS[2]}" fill="#f2f1ee"/>
    <path d="${SHIPS[3]}" fill="#f2f1ee" fill-opacity=".45"/><path d="${SHIPS[4]}" fill="#f2f1ee" fill-opacity=".45"/></svg>`;
}
// The formation at rest: the empty state's picture. Outlines, the lead ship lit.
function formationAtRest(size = 112) {
  return `<svg class="rest" width="${size}" height="${size}" viewBox="-4 0 40 34" aria-hidden="true">
    <defs><radialGradient id="g-rest" cx="50%" cy="30%" r="50%"><stop offset="0" stop-color="#b6f15a" stop-opacity=".22"/><stop offset="1" stop-color="#b6f15a" stop-opacity="0"/></radialGradient></defs>
    <circle cx="16" cy="9" r="11" fill="url(#g-rest)"/>
    <path d="${SHIPS[0]}" fill="#b6f15a" fill-opacity=".9"/>
    ${SHIPS.slice(1)
      .map((d, i) => `<path d="${d}" fill="none" stroke="#f2f1ee" stroke-opacity="${i < 2 ? 0.55 : 0.28}" stroke-width=".7" stroke-linejoin="round"/>`)
      .join("")}
    <path d="M-2 32.5H34" stroke="#f2f1ee" stroke-opacity=".08" stroke-width=".5"/></svg>`;
}
// A ship pointing right: a live session's head on the timeline, the merge moment.
function ship(c, size = 11, cls = "") {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 12 12" aria-hidden="true"><path d="M11.5 6L1 11V1Z" fill="${c}"/></svg>`;
}

const HUE = {
  yours: "var(--yours)",
  fail: "var(--fail)",
  silent: "var(--silent)",
  flight: "var(--flight)",
  plan: "var(--flight)",
  merge: "var(--done)",
  done: "var(--done)",
};
function glyphSvg(s) {
  switch (s) {
    case "yours":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="var(--yours)" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" fill="var(--yours)"/></svg>`;
    case "fail":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="var(--fail)"/><circle cx="8" cy="8" r="2" fill="#160807"/></svg>`;
    case "silent":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="var(--silent)" stroke-width="1.5" stroke-dasharray="2.4 2.2"/></svg>`;
    case "flight":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="var(--flight)" stroke-width="1.5"/><path d="M8 3.5A4.5 4.5 0 0 1 8 12.5Z" fill="var(--flight)"/></svg>`;
    case "plan":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="var(--flight)" stroke-width="1.5"/><path d="M8 3.5A4.5 4.5 0 0 1 12.5 8H8Z" fill="var(--flight)"/></svg>`;
    case "merge":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="var(--done)"/><circle cx="8" cy="8" r="2" fill="#0b1203"/></svg>`;
    case "done":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="var(--done)"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#0b1203" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "coord":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1.8L14.2 8 8 14.2 1.8 8Z" fill="var(--done-dim)" stroke="var(--done)" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    case "coord-idle":
      return `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1.8L14.2 8 8 14.2 1.8 8Z" fill="none" stroke="var(--silent)" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    default:
      return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="var(--ink-4)"/></svg>`;
  }
}
const glyph = (s, label) => `<span class="glyph" role="img" aria-label="${label || s}">${glyphSvg(s)}</span>`;

const ICONS = {
  overview: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="M2 9.5h12"/></svg>`,
  validations: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.6L14.4 8 8 14.4 1.6 8Z"/><path d="M5.6 8.1l1.6 1.6 3.2-3.3" stroke-linecap="round"/></svg>`,
  projects: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1.5"/><rect x="9" y="2" width="5" height="5" rx="1.5"/><rect x="2" y="9" width="5" height="5" rx="1.5"/><rect x="9" y="9" width="5" height="5" rx="1.5"/></svg>`,
  agents: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2.5L11 8H5Z"/><path d="M4 9.5L6.5 14h-5Z"/><path d="M12 9.5L14.5 14h-5Z"/></svg>`,
  insights: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 13.5h11"/><path d="M4.5 11V8"/><path d="M8 11V4.5"/><path d="M11.5 11V6.5"/></svg>`,
  activity: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 3.5h9M4.5 8h9M4.5 12.5h9"/><circle cx="2" cy="3.5" r=".6" fill="currentColor"/><circle cx="2" cy="8" r=".6" fill="currentColor"/><circle cx="2" cy="12.5" r=".6" fill="currentColor"/></svg>`,
  system: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
  back: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>`,
  ext: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 2.5h5.5V8M9.5 2.5L3 9"/></svg>`,
  retry: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/></svg>`,
  chev: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg>`,
};

/* ───────────────────────── Small parts ───────────────────────── */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const projChip = (slug) => `<span class="chip"><span class="sq" style="background:${P[slug].c}"></span>${P[slug].name}</span>`;
const harness = (h, withName = true) =>
  `<span class="harness"><span class="dot" style="background:${HARNESS[h].c}"></span>${withName ? `<span class="harness-name">${HARNESS[h].name}</span>` : ""}</span>`;
function phases(step, s) {
  let out = "";
  for (let i = 0; i < 6; i++) {
    const cls = i < step ? "done" : i === step ? (s === "fail" ? "fail" : "now") : "";
    out += `<i class="${cls}"${i === step ? ` style="--c:${HUE[s]}"` : ""}></i>`;
  }
  return `<span class="phases" aria-label="step ${step + 1} of 6">${out}</span>`;
}
function ring(p, size = 40, stroke = 3, label = true) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return `<span class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" aria-hidden="true">
    <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-dasharray="${c * p} ${c}"/></svg>
    ${label ? `<b>${Math.round(p * 100)}</b>` : ""}</span>`;
}
const band = (label, count, side = "", id = "", icon = "") =>
  `<div class="band"${id ? ` id="${id}"` : ""}>${icon}<h2>${label}</h2>${count !== undefined ? `<span class="count">${count}</span>` : ""}${side ? `<span class="band-side">${side}</span>` : ""}</div>`;
const stat = (n, label, cls = "", href = "") =>
  `<${href ? `a href="${href}"` : "span"} class="stat ${cls}">${cls ? `<span class="dot" style="background:var(--${cls.replace("is-", "")})"></span>` : ""}<b>${n}</b>${label}</${href ? "a" : "span"}>`;

function agentRow(a, i) {
  const t = a.state === "silent" ? "is-silent" : "";
  return `<a class="row" href="#/agents/${a.id}" data-row="${i}" data-id="${a.id}">
    ${glyph(a.state, a.phase)}
    <span class="row-id">${a.id}<span class="m-line"> · ${a.phase}</span></span>
    <span class="row-text"><span class="row-title">${esc(a.title)}</span><span class="row-line">${esc(a.line)}</span></span>
    <span class="row-end">${projChip(a.project)}${phases(a.step, a.state)}${harness(a.harness, false)}<span class="row-time ${t}">${a.t}</span></span>
  </a>`;
}
function coordRow(p) {
  const idle = p.coord.state === "idle";
  return `<a class="row coord" href="#/projects/${p.slug}">
    ${glyph(idle ? "coord-idle" : "coord", idle ? "coordinator idle" : "coordinator active")}
    <span class="row-text"><span class="row-title">${p.name}</span><span class="row-line">${harness(p.coord.harness)} <span class="mono" style="margin-left:8px">${p.coord.handle}</span></span></span>
    <span class="row-end"><span class="hide-sm" style="color:var(--yours)">${p.coord.waiting} waiting for you</span>
    <span style="color:${idle ? "var(--silent)" : "var(--done)"};font-size:12px">${idle ? `idle for ${p.coord.seen}` : `active · ${p.coord.seen}`}</span></span>
  </a>`;
}

/* ───────────────────────── The shell ───────────────────────── */

const NAV = [
  { key: "", label: "Overview", icon: "overview", n: 4, yours: true },
  { key: "validations", label: "Validations", icon: "validations", n: 3, yours: true },
  { key: "projects", label: "Projects", icon: "projects", n: 3 },
  { key: "agents", label: "Agents", icon: "agents", n: 11 },
  { key: "activity", label: "Activity", icon: "activity" },
  { key: "insights", label: "Insights", icon: "insights" },
];

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  return h.split("?")[0];
}
function section(r) {
  return r.split("/")[0];
}

const count = (n) => (state.mode === "empty" && ["", "agents"].includes(n.key) ? 0 : state.mode === "loading" ? 0 : n.n);
function renderSide(r) {
  const sec = section(r);
  const live = state.mode === "error" ? "is-paused" : state.mode === "loading" ? "is-assembling" : "";
  document.getElementById("side").innerHTML = `
    <div class="brand">${mark(20)}<span>Armada</span><span class="org">Acme ${ICONS.chev}</span></div>
    <button class="search" type="button">${ICONS.search}<span>Search</span><span class="kbd">⌘K</span></button>
    <div class="nav">${NAV.map(
      (n) =>
        `<a href="#/${n.key}"${sec === n.key || (n.key === "projects" && sec === "projects") ? ' aria-current="page"' : ""}>${ICONS[n.icon]}${n.label}${count(n) ? `<span class="n ${n.yours ? "is-yours" : ""}">${count(n)}</span>` : ""}</a>`,
    ).join("")}</div>
    <div class="nav"><div class="nav-h">Projects</div>${PROJECTS.map(
      (p) =>
        `<a href="#/projects/${p.slug}"${r === `projects/${p.slug}` ? ' aria-current="page"' : ""}>${ring(p.done / p.total, 14, 2.2, false).replace('class="arc"', `class="arc" style="stroke:${p.c}"`)}${p.name}<span class="n">${AGENTS.filter((a) => a.project === p.slug).length}</span></a>`,
    ).join("")}</div>
    <div class="nav"><div class="nav-h">Harness</div>${Object.entries(HARNESS)
      .map(([k, h]) => `<a href="#/agents">${harness(k, false)}${h.name}<span class="n">${AGENTS.filter((a) => a.harness === k).length}</span></a>`)
      .join("")}</div>
    <div class="nav"><a href="#/system"${sec === "system" ? ' aria-current="page"' : ""}>${ICONS.system}System<span class="n">v5</span></a></div>
    <div class="side-foot">${mark(16, live)}<span>${state.mode === "error" ? "<b>Paused</b> · last reading 8 min ago" : state.mode === "loading" ? "<b>Connecting</b>" : "<b>Live</b> · checked 2 s ago"}</span></div>`;
}

function renderTabbar(r) {
  const sec = section(r);
  document.getElementById("tabbar").innerHTML = NAV.map(
    (n) =>
      `<a href="#/${n.key}"${sec === n.key ? ' aria-current="page"' : ""}>${ICONS[n.icon]}<span>${n.label}</span>${n.yours && count(n) ? `<span class="badge">${count(n)}</span>` : ""}</a>`,
  ).join("");
}

function bar(crumbs, actions = "") {
  const live =
    state.mode === "error"
      ? `<span class="livechip is-paused">${mark(14, "is-paused")}<b>Paused</b> last reading 8 min ago</span>`
      : state.mode === "loading"
        ? `<span class="livechip">${mark(14, "is-assembling")}Connecting</span>`
        : `<span class="livechip">${mark(14, "js-beat")}<b>Live</b> checked 2 s ago</span>`;
  return `<header class="bar"><div class="crumbs">${crumbs}</div><div class="bar-end">${actions}${live}<span class="kbd">j</span><span class="kbd">k</span></div></header>`;
}
function topbar(title, back = "") {
  return `<header class="topbar">${back ? `<a class="back" href="${back}" aria-label="Back">${ICONS.back}</a>` : mark(18, state.mode === "error" ? "is-paused" : "js-beat")}
    <span class="t">${title}</span><span class="end">${back ? "" : `<button class="org" type="button">Acme ${ICONS.chev}</button>`}<button class="icon-btn" aria-label="Search">${ICONS.search}</button></span></header>`;
}
const crumb = (parts) =>
  parts.map((p, i) => (i < parts.length - 1 ? `<a href="${p[1]}">${p[0]}</a><span class="sep">/</span>` : `<span>${p[0]}</span>`)).join("");

function errorAlert() {
  if (state.mode !== "error") return "";
  return `<div class="alert" role="alert">${glyph("fail", "error")}<p><b>Armada can't reach Linear since 17:32.</b> You're seeing the reading from 8 min ago; answers and launches still go through.</p><button class="btn is-sm">${ICONS.retry}Retry</button></div>`;
}

function skeletonStatus() {
  return `<div class="status" aria-busy="true"><span class="skel is-display" style="width:min(520px,80%)"></span><span class="skel" style="width:min(380px,60%)"></span></div>`;
}
function skeletonRows(n = 6) {
  let out = "";
  for (let i = 0; i < n; i++)
    out += `<div class="row" aria-hidden="true"><span class="skel" style="width:14px;height:14px;border-radius:50%"></span><span class="skel" style="width:44px"></span><span class="skel" style="width:${40 + ((i * 17) % 35)}%"></span><span class="skel" style="width:80px"></span></div>`;
  return out;
}
function loadingPage(label) {
  return `${skeletonStatus()}${band(label, "…")}<div class="rows">${skeletonRows(7)}</div>`;
}

/* ───────────────────────── Pages ───────────────────────── */

function overview() {
  const head = bar(`<span>Overview</span>`) + topbar("Overview");
  if (state.mode === "loading") return head + loadingPage("Yours to decide");
  if (state.mode === "empty")
    return `${head}<div class="status"><h1>No agent in flight. <span class="then">3 tickets are ready to start.</span></h1><p>Thursday 1 October, 17:40. 3 projects, each with its coordinator watching.</p></div>
    ${band("Live fleet", 0)}
    <div class="empty">${formationAtRest(120)}<h3>The fleet is at rest</h3><p>Launch a ready ticket and its agent appears here, live, from its claim to its merge.</p>
    <div class="actions"><button class="btn is-primary">Launch THE-866</button><a class="btn is-quiet" href="#/projects/armada">See the ready tickets</a></div></div>`;
  return `${head}${errorAlert()}
  <div class="status">
    <h1>${state.away === "on" ? `Welcome back. 6 merged while you were away. <span class="then">4 wait for you.</span>` : `11 agents in flight. <span class="then">4 wait for you.</span>`}</h1>
    <p>Thursday 1 October, 17:40. 11 agents in flight across three projects, each with its coordinator, on three harnesses.</p>
    <div class="chips">${stat(4, "to decide", "is-yours", "#/validations")}${stat(2, "failing", "is-fail", "#/agents")}${stat(1, "silent", "is-silent", "#/agents")}${stat(2, "ready to merge", "is-done", "#/agents")}
    <a class="stat" href="#/insights">This week <b>30</b> merged <span class="trend">↑ 43%</span></a></div>
  </div>
  ${state.away === "on" ? sinceAway() : ""}
  ${band("Yours to decide", 4, `<a href="#/validations">All validations</a>`)}
  <div class="cards">${DECISIONS.map(decisionCard).join("")}</div>
  ${band("Live fleet", 11, `<span class="seg hide-sm"><button aria-pressed="true">All <span class="n">11</span></button><button>${harness("conductor", false)}Conductor <span class="n">6</span></button><button>${harness("claude", false)}Claude Code <span class="n">3</span></button><button>${harness("codex", false)}Codex <span class="n">2</span></button></span>`)}
  ${timeline()}
  ${band("Projects", 3)}
  <div class="cards is-projects">${PROJECTS.map(projectCard).join("")}</div>`;
}

function decisionCard(d, i, all, wide = false) {
  const meta = `<div class="meta">${projChip(d.project)}${d.id ? `<span class="mono">${d.id}</span>` : ""}</div>`;
  let body = "";
  if (d.kind === "coord")
    body = `<p class="why" style="margin:0">${d.body}</p><div class="actions"><a class="btn is-sm" href="#/projects/${d.project}">Open the project</a></div>`;
  if (d.kind === "question")
    body = `<blockquote class="quote" style="--q:var(--flight)">${d.quote}</blockquote><div class="why">Why you: <b>${d.why}</b></div>
      <div class="actions"><button class="btn is-primary is-sm">${d.choices[0]} <span class="k" style="color:#55565c">recommended</span></button><button class="btn is-sm">${d.choices[1]}</button><button class="btn is-quiet is-sm">Answer in words</button></div>`;
  if (d.kind === "validation")
    body = `<blockquote class="quote" style="--q:var(--yours)">${d.quote}</blockquote><div class="gallery" style="grid-template-columns:repeat(3,minmax(0,1fr))">${d.shots.map((c, k) => shot(c, k, !wide)).join("")}</div>
      <div class="actions"><button class="btn is-primary is-sm">Approve</button><button class="btn is-sm">Request changes</button></div>`;
  if (d.kind === "merge")
    body = `<div class="why">Why you: <b>${d.why}</b></div><div class="pr-box"><span style="font-weight:500">#${d.pr.n} ${d.pr.title}</span>
      <span class="meta" style="font-size:12px"><span class="mono" style="color:var(--done)">+${d.pr.add}</span><span class="mono" style="color:var(--fail)">−${d.pr.del}</span><span class="ink-3">${d.pr.files} files</span><span style="display:inline-flex;gap:6px;align-items:center" class="ink-3"><span class="dot" style="background:var(--done)"></span>CI green</span><span class="mono ink-3">${d.pr.sha}</span></span></div>
      <div class="actions"><button class="btn is-primary is-sm">Approve the merge</button><button class="btn is-sm">Request changes</button><a class="btn is-quiet is-sm" href="#">Try the preview ${ICONS.ext}</a></div>`;
  return `<article class="card ${d.oldest ? "is-oldest" : ""} ${wide ? "vcard" : ""}">
    <div class="card-h"><span class="dot" style="background:${d.c}"></span><span style="color:${d.c}">${d.label}</span><span class="when">${d.when}</span></div>
    <h3>${d.title}</h3>${meta}${body}</article>`;
}

// Synthetic attachments: the product card directions GAD-9 asks about.
function shot(caption, k, small = false) {
  const photo = k === 1 ? `<rect x="0" y="0" width="160" height="70" fill="url(#ph${k})"/>` : `<rect x="12" y="12" width="${k === 2 ? 40 : 58}" height="${k === 2 ? 40 : 58}" rx="4" fill="url(#ph${k})"/>`;
  const svg = `<svg viewBox="0 0 160 100" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="ph${k}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a4a6b"/><stop offset="1" stop-color="#1c2233"/></linearGradient></defs>
    <rect width="160" height="100" fill="#101115"/>${photo}
    <rect x="${k === 1 ? 12 : k === 2 ? 60 : 80}" y="${k === 1 ? 78 : 16}" width="52" height="5" rx="2" fill="#f2f1ee" fill-opacity=".8"/>
    <rect x="${k === 1 ? 12 : k === 2 ? 60 : 80}" y="${k === 1 ? 87 : 26}" width="34" height="4" rx="2" fill="#f2f1ee" fill-opacity=".35"/>
    <rect x="${k === 1 ? 118 : k === 2 ? 60 : 80}" y="${k === 1 ? 80 : 40}" width="30" height="10" rx="3" fill="#b6f15a" fill-opacity=".85"/></svg>`;
  return `<figure class="shot"><div class="img" role="img" aria-label="${caption}">${svg}</div>${small ? "" : `<figcaption>${caption}</figcaption>`}</figure>`;
}

function projectCard(p) {
  return `<a class="card proj-card" href="#/projects/${p.slug}">${ring(p.done / p.total, 44, 3).replace('class="arc"', `class="arc" style="stroke:${p.c}"`)}
    <div style="display:grid;gap:8px;min-width:0"><div style="display:flex;align-items:baseline;gap:8px"><h3>${p.name}</h3><span class="mono ink-3" style="font-size:11px">${p.done}/${p.total}</span></div>
    <dl><dt>Health</dt><dd style="color:${p.health[1]}">${p.health[0]}</dd><dt>Coordinator</dt><dd>${harness(p.coord.harness)}</dd><dt>Agents</dt><dd>${AGENTS.filter((a) => a.project === p.slug).length} in flight</dd><dt>PRs</dt><dd>${p.prs}</dd></dl></div></a>`;
}

/* The live timeline: each session a flight path, its head a ship at now. */
function timeline() {
  const x = (ago) => `${((WINDOW - ago) / WINDOW) * 100}%`;
  const ticks = [
    [160, "15:00"],
    [100, "16:00"],
    [40, "17:00"],
  ];
  const rowsFor = (slug) => {
    const t = TIMELINE[slug];
    const p = P[slug];
    const coord = `<div class="tl-row" style="min-height:40px"><span class="tl-name">${glyph(p.coord.state === "idle" ? "coord-idle" : "coord", "coordinator")}<span><b>Coordinator</b><small><em class="ink-3">${HARNESS[p.coord.harness].name}</em></small></span></span>
      <span class="tl-track">${t.coord.live.map(([a, b]) => `<i class="tl-coord" style="left:${x(a)};right:${100 - parseFloat(x(b))}%"></i>`).join("")}${t.coord.idle ? `<i class="tl-coord is-idle" style="left:${x(t.coord.idle[0])};right:0"></i>` : ""}</span>
      <span class="tl-end" style="color:${t.coord.end[1]};font-family:var(--font-sans);font-size:12px">${t.coord.end[0]}</span></div>`;
    const rows = t.rows
      .filter((r) => !state.merged.has(r.id))
      .map((r) => {
        const a = A[r.id];
        const hue = HUE[r.now[1]];
        const trail = r.trail.map(([f, to, k]) => `<i class="tl-trail" style="left:${x(f)};width:${((f - to) / WINDOW) * 100}%;--c:${HUE[k]}"></i>`).join("");
        const silence = r.silence ? `<i class="tl-silence" style="left:${x(r.silence[0])};width:${((r.silence[0] - r.silence[1]) / WINDOW) * 100}%"></i>` : "";
        const now = r.silent
          ? `<i class="tl-silence" style="left:${x(r.now[0])};right:0"></i>`
          : `<i class="tl-now-bar" style="left:${x(r.now[0])};right:0;--c:${hue}"></i>`;
        const dots = r.reports.map((ago) => `<i class="tl-dot" style="left:${x(ago)}"></i>`).join("");
        const pr = r.pr ? `<i class="tl-pr" style="left:${x(r.pr)}"></i>` : "";
        const head = `<span class="tl-ship ${r.silent ? "is-silent" : ""}" style="--c:${hue}">${ship(hue, 11)}</span>`;
        return `<a class="tl-row" href="#/agents/${a.id}"><span class="tl-name">${glyph(a.state, a.phase)}<span><b>${esc(a.title)}</b><small>${a.id} <em style="color:${hue}">${a.phase}</em></small></span></span>
          <span class="tl-track">${trail}${silence}${now}${dots}${pr}${head}</span><span class="tl-end ${r.silent ? "" : ""}" style="${r.silent ? "color:var(--silent)" : ""}">${a.t}</span></a>`;
      })
      .join("");
    return `<div class="tl-group"><span><span class="dot" style="background:${p.c};border-radius:2px"></span>${p.name} <span class="mono ink-3" style="font-weight:400">${t.rows.length}</span></span></div>${coord}${rows}`;
  };
  return `<div class="tl" id="tl">
    <div class="tl-axis"><span>Session</span><span class="tl-ticks">${ticks.map(([a, l]) => `<span style="left:${x(a)}">${l}</span>`).join("")}<span class="now" style="left:calc(100% - 14px)">now</span></span><span></span></div>
    ${PROJECTS.map((p) => rowsFor(p.slug)).join("")}
    <i class="tl-now" style="left:calc(var(--name) + 24px + (100% - var(--name) - 24px - var(--end)) * 1)"></i>
    <i class="tl-cross" id="tl-cross"><span>16:12</span></i>
    <div class="tl-legend"><span><i class="lg-trail"></i>earlier phases</span><span><i class="lg-now"></i>current phase</span><span>${ship("var(--flight)", 9)}the agent, now</span><span><i class="lg-dot"></i>report</span><span><i class="lg-pr"></i>PR opened</span><span><i class="lg-silence"></i>silence</span><span><i class="lg-coord"></i>coordinator watching</span></div>
  </div>`;
}

function agents() {
  const head = bar(`<span>Agents</span>`) + topbar("Agents");
  const toolbar = `<div class="toolbar"><span class="seg"><button aria-pressed="true">All <span class="n">11</span></button><button>${harness("conductor", false)}Conductor Cloud <span class="n">6</span></button><button>${harness("claude", false)}Claude Code <span class="n">3</span></button><button>${harness("codex", false)}Codex <span class="n">2</span></button></span>
    <span class="grow"></span><span class="seg hide-sm" role="group" aria-label="Density"><button data-density="compact" aria-pressed="${state.density === "compact"}">Compact</button><button data-density="airy" aria-pressed="${state.density === "airy"}">Airy</button></span></div>`;
  if (state.mode === "loading") return head + skeletonStatus() + toolbar + band("Coordinators", "…") + `<div class="rows">${skeletonRows(9)}</div>`;
  if (state.mode === "empty")
    return `${head}<div class="status"><h1>No agent in flight.</h1><p>Three coordinators are watching; nothing is claimed.</p></div>${toolbar}
    ${band("Coordinators", 3, "one per project")}<div class="rows">${PROJECTS.map(coordRow).join("")}</div>
    <div class="empty">${formationAtRest(104)}<h3>Every ticket is waiting for its agent</h3><p>3 tickets are ready to start. Launch one from its project, or let a coordinator pick.</p><div class="actions"><a class="btn is-primary" href="#/projects/armada">Open Armada's ready tickets</a></div></div>`;
  let i = 0;
  const live = AGENTS.filter((a) => !state.merged.has(a.id));
  const sections = BANDS.map((b) => {
    const list = live.filter((a) => (b.states || [b.key]).includes(a.state));
    if (!list.length) return "";
    return `<section class="section" id="${b.key}">${band(b.label, list.length, b.side || "", "", glyph(b.key === "flight" ? "flight" : b.key, b.label))}<div class="rows">${list.map((a) => agentRow(a, i++)).join("")}</div></section>`;
  }).join("");
  return `${head}${errorAlert()}<div class="status"><h1>${live.length} agents in flight. <span class="then">3 wait for your decision, 2 are failing.</span></h1></div>${toolbar}
    <section class="section">${band("Coordinators", 3, "one per project", "", glyph("coord", "coordinators"))}<div class="rows">${PROJECTS.map(coordRow).join("")}</div></section>${sections}`;
}

function agent(id) {
  const a = A[id] || A["THE-862"];
  const p = P[a.project];
  const head =
    bar(crumb([["Agents", "#/agents"], [a.id]]), `<button class="btn is-primary is-sm">Open in Conductor</button><a class="btn is-sm" href="#">Linear ${ICONS.ext}</a>`) +
    topbar(a.id, "#/agents");
  if (state.mode === "loading") return head + loadingPage("Flight path");
  const steps = ["Plan", "Approval", "Implementation", "PR", "CI", "Merge"];
  const detail = ["done · 17 min", "done · 15 min", "31 min", "", "", ""];
  const path = steps
    .map((s, k) => {
      const cls = k < a.step ? "done" : k === a.step ? "now" : "next";
      const node =
        k < a.step
          ? glyphSvg("done")
          : k === a.step
            ? `<span class="ship-now" style="--c:${HUE[a.state]}">${ship(HUE[a.state], 15)}</span>`
            : `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--ink-4)" stroke-width="1.5"/></svg>`;
      return `<div class="path-step ${cls}"><span class="path-node">${node}</span><b>${s}</b><span>${a.id === "THE-862" ? detail[k] : k < a.step ? "done" : k === a.step ? a.t : ""}</span></div>`;
    })
    .join("");
  const ev = [
    ["var(--flight)", "Report", "Mapping Codex session events onto armada report", "6 min ago"],
    ["var(--flight)", "Report", "Writing the change and its tests", "19 min ago"],
    ["var(--flight)", "Moved to implementing", "Plan approved by the coordinator", "31 min ago"],
    ["var(--yours)", "Waiting for approval", "Plan posted: one adapter per harness, events mapped in core", "46 min ago"],
    ["var(--flight)", "Report", "Reading the ticket and the code", "52 min ago"],
    ["var(--ink-4)", "Branch feature/the-862 created", "", "1 h 03 ago"],
    ["var(--ink-4)", "Ticket claimed on Conductor Cloud", "Session ws-a1c4/ses-03, profile opus", "1 h 03 ago"],
  ];
  const facts = (rows) => `<dl class="facts" style="margin:0">${rows.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  return `${head}${errorAlert()}
  <div class="status">
    <div style="display:flex;align-items:center;gap:8px;font-weight:500;color:${HUE[a.state]}">${glyph(a.state, a.phase)}${a.phase} <span class="mono ink-3" style="font-weight:400">for ${a.t === "1 min" ? "31 min" : a.t}</span></div>
    <h1>${esc(a.title)}</h1>
    <p>${esc(a.line)}.</p>
    <div class="chips"><span class="stat"><span class="dot" style="background:${p.c};border-radius:2px"></span>${p.name}</span><span class="stat"><b>${a.id}</b></span><span class="stat"><span class="dot" style="background:${HARNESS[a.harness].c}"></span>${HARNESS[a.harness].name}</span><span class="stat">opus · high</span></div>
  </div>
  ${band("Flight path", `${a.step}/6`)}
  <div class="path">${path}</div>
  <div class="columns">
    <div>${band("Activity", 10, `<span class="seg"><button aria-pressed="true">Activity</button><button>Files <span class="n">0</span></button><button>Attachments <span class="n">0</span></button></span>`)}
      <div class="activity">${ev.map(([c, t, d, w]) => `<div class="event"><span class="pin" style="background:${c}"></span><div><b>${t}</b>${d ? `<p>${d}</p>` : ""}</div><time>${w}</time></div>`).join("")}</div></div>
    <aside>${band("Session")}${facts([
      ["Harness", harness(a.harness)],
      ["Profile", "opus"],
      ["Model", `<span class="mono">opus-5-5-1m · high</span>`],
      ["Session", `<span class="mono">ws-a1c4/ses-03</span>`],
      ["Started", `<span class="mono">16:37 · 1 h 03</span>`],
      ["Last report", "1 min ago"],
    ])}
    ${band("Coordinator")}${facts([
      [p.name, harness(p.coord.harness)],
      ["State", `<span style="color:var(--done)">active · ${p.coord.seen}</span>`],
    ])}
    ${band("Code")}${facts([
      ["Branch", `<span class="mono">feature/${a.id.toLowerCase()}</span>`],
      ["PR", `<span class="ink-3">not opened yet</span>`],
    ])}
    <div style="padding:14px 12px"><button class="btn is-quiet is-danger is-sm">Ask to release the ticket</button></div></aside>
  </div>`;
}

function project(slug) {
  const p = P[slug] || P.armada;
  const head = bar(crumb([["Projects", "#/projects"], [p.name]]), `<a class="btn is-sm" href="#">Linear ${ICONS.ext}</a><a class="btn is-sm" href="#">GitHub ${ICONS.ext}</a>`) + topbar(p.name, "#/projects");
  if (state.mode === "loading") return head + loadingPage("Coordinator");
  const inflight = AGENTS.filter((a) => a.project === p.slug && !state.merged.has(a.id));
  const ready = [
    ["THE-864", "Spike a boat.dev harness", "", "chosen by the coordinator"],
    ["THE-866", "Filter the fleet by harness", "web", "opus"],
  ];
  return `${head}${errorAlert()}
  <div class="status" style="grid-template-columns:auto 1fr;align-items:center;column-gap:20px">
    ${ring(p.done / p.total, 64, 4).replace('class="arc"', `class="arc" style="stroke:${p.c}"`)}
    <div style="display:grid;gap:8px"><h1>${p.done} of ${p.total} tickets done. <span class="then">${inflight.length} in flight, 2 ready to start.</span></h1>
    <p>${p.rootTitle} in <span class="mono">${p.repo}</span>. ${p.owner} watches it.</p></div>
  </div>
  <section class="section">${band("Coordinator", undefined, `<span style="color:var(--done)">active · inbox read ${p.coord.seen}</span>`, "", glyph("coord", "coordinator"))}
    <div class="facts" style="grid-template-columns:repeat(3,minmax(0,1fr));display:grid">${[
      ["Harness", harness(p.coord.harness)],
      ["Session", `<span class="mono">${p.coord.handle}</span>`],
      ["Model", `<span class="mono">${p.coord.model}</span>`],
      ["Inbox", `<span style="color:var(--yours)">${p.coord.waiting} waiting for you</span>`],
      ["On duty since", `<span class="mono">${p.coord.since} · 3 h 17</span>`],
      ["Watch", `<span>re-armed 7 min ago</span>`],
    ]
      .map(([k, v]) => `<div class="fact" style="padding-left:24px"><dt>${k}</dt><dd>${v}</dd></div>`)
      .join("")}</div></section>
  <section class="section">${band("Agents in flight", inflight.length)}<div class="rows">${inflight.map((a, i) => agentRow(a, i)).join("")}</div></section>
  <section class="section">${band("Ready to start", 2, "profile: labels, otherwise the coordinator")}<div class="rows">${ready
    .map(
      ([id, t, label, prof]) =>
        `<div class="row" style="grid-template-columns:18px 64px minmax(0,1fr) auto">${glyph("idle", "ready")}<span class="row-id">${id}</span><span class="row-text"><span class="row-title">${t}</span>${label ? `<span class="chip">${label}</span>` : ""}</span><span class="row-end"><button class="btn is-sm">Launch <span class="k">${prof}</span></button></span></div>`,
    )
    .join("")}</div></section>
  <section class="section">${band("Blockers", 0)}<div class="empty-inline">${formationAtRest(28)}<span>Nothing blocks this project.</span></div></section>
  <section class="section">${band("Open PRs", 1, "1 green")}<div class="rows"><div class="row" style="grid-template-columns:18px 64px minmax(0,1fr) auto">${glyph("merge", "green")}<span class="row-id">#317</span><span class="row-text"><span class="row-title">Show the harness on every session</span><span class="row-line mono" style="font-size:11px">feature/the-858</span></span><span class="row-end"><span style="color:var(--done);font-size:12px">CI green</span><span class="row-time">9 min</span></span></div></div></section>`;
}

function projects() {
  const head = bar(`<span>Projects</span>`) + topbar("Projects");
  if (state.mode === "loading") return head + loadingPage("Projects");
  return `${head}${errorAlert()}<div class="status"><h1>3 projects, 56 of 79 tickets done. <span class="then">Two are blocked.</span></h1></div>${band("Projects", 3)}<div class="cards is-projects">${PROJECTS.map(projectCard).join("")}</div>`;
}

function validations() {
  const head = bar(`<span>Validations</span>`) + topbar("Validations");
  if (state.mode === "loading") return head + loadingPage("Waiting for your check");
  if (state.mode === "empty")
    return `${head}<div class="status"><h1>Nothing waits for you.</h1><p>When an agent needs your eye on a design, a merge or a product choice, it lands here first.</p></div>${band("Waiting for your check", 0)}
      <div class="empty">${formationAtRest(104)}<h3>You're all caught up</h3><p>The last decision was yours, 2 h ago: you approved GAD-2's empty cart.</p><div class="actions"><a class="btn" href="#/">Back to the overview</a></div></div>`;
  const list = DECISIONS.filter((d) => d.kind !== "coord");
  const decided = [
    ["GAD-2", "Show an empty cart with a way back to the catalogue", "Approved", "2 h ago"],
    ["WID-9", "Let a customer save a draft order", "Changes asked: keep the draft 7 days, not 30", "5 h ago"],
  ];
  return `${head}${errorAlert()}<div class="status"><h1>3 decisions wait for you. <span class="then">The oldest for 27 min.</span></h1><p>Each one stops a worker until you answer. Approve, pick a choice, or say what to change.</p></div>
  ${band("Waiting for your check", 3)}
  <div class="vlist">${list.map((d, i) => decisionCard(d, i, list, true)).join("")}</div>
  ${band("Decided today", 2)}<div class="rows decided">${decided
    .map(
      ([id, t, what, w]) =>
        `<div class="row" style="grid-template-columns:18px 64px minmax(0,1fr) auto">${glyph("done", "decided")}<span class="row-id">${id}</span><span class="row-text"><span class="row-title">${t}</span><span class="row-line">${what}</span></span><span class="row-end"><span class="row-time">${w}</span></span></div>`,
    )
    .join("")}</div>`;
}

/* Insights: figures, then charts drawn as thin SVG marks. */
function insights() {
  const head = bar(`<span>Insights</span>`) + topbar("Insights");
  const toolbar = `<div class="toolbar"><span class="seg"><button>7 days</button><button aria-pressed="true">30 days</button><button>90 days</button></span><span class="seg"><button aria-pressed="true">All projects</button>${PROJECTS.map((p) => `<button>${p.name}</button>`).join("")}</span></div>`;
  if (state.mode === "loading") return head + skeletonStatus() + toolbar + `<div class="figures">${[1, 2, 3, 4].map(() => `<div class="figure"><span class="skel" style="width:60%"></span><span class="skel is-display" style="width:50%;margin:8px 0"></span><span class="skel" style="width:80%"></span></div>`).join("")}</div>`;
  const spark = (vals, c) => {
    const v = vals.filter((x) => x != null);
    const max = Math.max(...v);
    const min = Math.min(...v);
    const pts = v.map((y, i) => `${(i / (v.length - 1)) * 100},${26 - ((y - min) / (max - min || 1)) * 22}`).join(" ");
    return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  };
  const figures = `<div class="figures">
    <a class="figure" href="#"><span class="label">Merged</span><span class="value">51</span><span class="sub"><span class="trend">↑ 43%</span> this week vs last</span>${spark(SHIPPED, "var(--done)")}</a>
    <a class="figure" href="#"><span class="label">Claim to merge</span><span class="value">5<small>h</small>21</span><span class="sub">median · p90 7 h 35</span>${spark(CYCLE, "var(--flight)")}</a>
    <a class="figure" href="#"><span class="label">First-pass green</span><span class="value">71<small>%</small></span><span class="sub">36 of 51 merged on their first head</span>${spark([60, 62, 58, 66, 64, 70, 68, 71], "var(--done)")}</a>
    <a class="figure" href="#"><span class="label">Silences</span><span class="value">0.07</span><span class="sub">per worker-hour · 21 in 302 h</span>${spark([0.12, 0.1, 0.11, 0.09, 0.08, 0.09, 0.07, 0.07], "var(--silent)")}</a></div>`;
  // Bars: this period solid, the previous one as a ghost outline behind.
  const W = 1000;
  const H = 150;
  const n = SHIPPED.length;
  const bw = W / n;
  const max = 7;
  const bars = SHIPPED.map((v, i) => {
    const g = SHIPPED_PREV[i];
    const gh = (g / max) * H;
    const h = (v / max) * H;
    const today = i === n - 1;
    return `<rect x="${i * bw + bw * 0.18}" y="${H - gh}" width="${bw * 0.64}" height="${gh}" rx="2" fill="rgba(255,255,255,.07)"/>
      ${v ? `<rect x="${i * bw + bw * 0.26}" y="${H - h}" width="${bw * 0.48}" height="${h}" rx="2" fill="${today ? "var(--done)" : "var(--flight)"}" fill-opacity="${today ? 1 : 0.85}"/>` : `<rect x="${i * bw + bw * 0.26}" y="${H - 1.5}" width="${bw * 0.48}" height="1.5" fill="var(--ink-4)"/>`}`;
  }).join("");
  const grid = [0, 2, 4, 6].map((g) => `<line x1="0" x2="${W}" y1="${H - (g / max) * H}" y2="${H - (g / max) * H}" stroke="rgba(255,255,255,${g ? 0.05 : 0.12})" vector-effect="non-scaling-stroke"/><text x="${W + 8}" y="${H - (g / max) * H + 3}" fill="var(--ink-3)" font-size="10" font-family="Geist Mono">${g}</text>`).join("");
  // Claim to merge: the median line inside its p50–p90 band.
  const CH = 110;
  const cy = (h) => CH - ((h - 3) / 6) * CH;
  const pts = CYCLE.map((v, i) => (v == null ? null : [i * bw + bw / 2, cy(v)])).filter(Boolean);
  const top = CYCLE_P90.map((v, i) => (v == null ? null : [i * bw + bw / 2, cy(v)])).filter(Boolean);
  const area = `M${pts.map((p) => p.join(",")).join(" L")} L${top
    .slice()
    .reverse()
    .map((p) => p.join(","))
    .join(" L")} Z`;
  const total = PHASE_TIME.reduce((s, p) => s + p.h, 0);
  return `${head}${errorAlert()}
  <div class="status"><h1>30 tickets shipped this week. <span class="then">43% more than last week.</span></h1><p>Median 5 h 19 from claim to merge over 30 days, across three projects. Days are UTC.</p></div>
  ${toolbar}
  <div style="height:20px"></div>${figures}
  <section class="section">${band("Tickets shipped", 51, "per day · today in green")}
    <div class="chart"><svg viewBox="0 0 ${W + 24} ${H + 4}" height="170" preserveAspectRatio="none" role="img" aria-label="Tickets merged per day: 51 in 30 days, at most 6 in one day">${grid}${bars}</svg></div>
    <div class="chart-cap"><span>Wed 2 Sept</span><span class="key"><span><i class="swatch" style="background:var(--flight)"></i>last 30 days</span><span><i class="swatch" style="background:rgba(255,255,255,.12)"></i>the 30 days before</span></span><span>Thu 1 Oct</span></div></section>
  <section class="section">${band("Claim to merge", 51, "median 5 h 21 · p90 7 h 35")}
    <div class="chart"><svg viewBox="0 0 ${W + 24} ${CH}" height="130" preserveAspectRatio="none" role="img" aria-label="Daily median from claim to merge, falling from 6 h to 4 h 54">
      <defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--flight)" stop-opacity=".22"/><stop offset="1" stop-color="var(--flight)" stop-opacity=".04"/></linearGradient></defs>
      ${[4, 6, 8].map((h) => `<line x1="0" x2="${W}" y1="${cy(h)}" y2="${cy(h)}" stroke="rgba(255,255,255,.05)" vector-effect="non-scaling-stroke"/><text x="${W + 8}" y="${cy(h) + 3}" fill="var(--ink-3)" font-size="10" font-family="Geist Mono">${h} h</text>`).join("")}
      <path d="${area}" fill="url(#band)"/>
      <polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="var(--flight)" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="3.5" fill="var(--flight)" stroke="var(--deck)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>
    <div class="chart-cap"><span>The line is the daily median; the band reaches the p90.</span><span class="key"><span><i class="swatch" style="background:var(--flight)"></i>median</span><span><i class="swatch" style="background:var(--flight-dim)"></i>to p90</span></span></div></section>
  <div class="two">
    <section class="section">${band("Where time goes", undefined, "279 h over 51 tickets")}
      <div class="stack" role="img" aria-label="Time in each phase">${PHASE_TIME.map((p) => `<i style="flex:${p.h};background:${p.c};opacity:${p.op}" title="${p.label}"></i>`).join("")}</div>
      <div class="rows">${PHASE_TIME.map(
        (p) =>
          `<div class="row" style="grid-template-columns:12px minmax(0,1fr) auto"><span class="swatch" style="background:${p.c};opacity:${p.op}"></span><span class="row-text"><span class="row-title">${p.label}</span><span class="row-line">median ${p.med}${p.who ? ` · waits on ${p.who}` : ""}</span></span><span class="row-time" style="color:var(--ink-2)">${Math.round((p.h / total) * 100)}%</span></div>`,
      ).join("")}</div></section>
    <section class="section">${band("Waiting on people")}
      <div class="rows">
        <div class="row" style="grid-template-columns:18px minmax(0,1fr) auto">${glyph("coord", "coordinator")}<span class="row-text"><span class="row-title">The coordinator</span><span class="row-line">question, plan or hand-back to its answer</span></span><span class="row-end"><span class="mono" style="font-size:12px">30 min</span><span class="row-time">p90 1 h 23</span></span></div>
        <div class="row" style="grid-template-columns:18px minmax(0,1fr) auto">${glyph("yours", "you")}<span class="row-text"><span class="row-title">You</span><span class="row-line">a validation to its decision · 3 open</span></span><span class="row-end"><span class="mono" style="font-size:12px;color:var(--yours)">40 min</span><span class="row-time">p90 2 h 03</span></span></div>
      </div>
      ${band("Quality")}
      <div class="rows">
        <div class="row" style="grid-template-columns:18px minmax(0,1fr) auto">${glyph("done", "green")}<span class="row-text"><span class="row-title">First-pass green</span><span class="row-line">36 of 51</span></span><span class="row-end"><span class="meter" style="--c:var(--done)"><i style="width:71%"></i></span><span class="row-time" style="color:var(--ink-2)">71%</span></span></div>
        <div class="row" style="grid-template-columns:18px minmax(0,1fr) auto">${glyph("fail", "redo")}<span class="row-text"><span class="row-title">New heads after a hand-back</span><span class="row-line">15 tickets</span></span><span class="row-end"><span class="meter" style="--c:var(--fail)"><i style="width:29%"></i></span><span class="row-time" style="color:var(--ink-2)">15</span></span></div>
      </div></section>
  </div>
  <section class="section">${band("Where tickets wait", 10, "the longest waits on someone")}
    <div class="rows">${WAITS.map(
      (w) =>
        `<a class="row" href="#"><span class="dot" style="background:${w.c};justify-self:center"></span><span class="row-id">${w.id}</span><span class="row-text"><span class="row-title">${w.title}</span><span class="row-line">${w.phase} · since ${w.since}</span></span><span class="row-end"><span class="meter hide-sm" style="--c:${w.c}"><i style="width:${(w.m / 195) * 100}%"></i></span><span class="row-time" style="color:var(--ink);min-width:52px">${w.d}</span></span></a>`,
    ).join("")}</div></section>
  <div class="two">
    <section class="section">${band("Profiles", 3, "merged in the range")}<div class="rows">${[
      ["opus", "median 5 h 19 · 0.2 re-plans per ticket", 33],
      ["codex", "median 5 h 40 · 0.5 new heads per ticket", 10],
      ["debug", "median 5 h 08 · 0.3 re-plans per ticket", 8],
    ]
      .map(([n, l, v]) => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span class="row-text"><span class="row-title">${n}</span><span class="row-line">${l}</span></span><span class="row-end"><span class="meter"><i style="width:${(v / 33) * 100}%"></i></span><span class="row-time" style="color:var(--ink-2)">${v}</span></span></div>`)
      .join("")}</div></section>
    <section class="section">${band("Harnesses", 3, "merged in the range")}<div class="rows">${[
      ["conductor", "median 5 h 22 · 0.09 silences per hour", 17],
      ["codex", "median 5 h 15 · 0.05 silences per hour", 17],
      ["claude", "median 5 h 19 · 0.07 silences per hour", 17],
    ]
      .map(([h, l, v]) => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span class="row-text"><span class="row-title" style="display:inline-flex;gap:8px;align-items:center"><span class="dot" style="background:${HARNESS[h].c}"></span>${HARNESS[h].name}</span><span class="row-line">${l}</span></span><span class="row-end"><span class="meter" style="--c:${HARNESS[h].c}"><i style="width:${(v / 17) * 100}%"></i></span><span class="row-time" style="color:var(--ink-2)">${v}</span></span></div>`)
      .join("")}</div></section>
  </div>`;
}

/* "Since you were away" (THE-894): back after more than 30 minutes, the
   overview replays the absence on one strip, then names each part as a link. */
function sinceAway() {
  const x = (m) => `${(m / 200) * 100}%`;
  const marks = AWAY.marks
    .map(([m, k]) =>
      k === "merge"
        ? `<span class="aw-mark" style="left:${x(m)}" title="merged">${ship("var(--done)", 10)}</span>`
        : k === "claim"
          ? `<i class="aw-tick" style="left:${x(m)};--c:var(--flight)" title="started"></i>`
          : k === "silent"
            ? `<i class="aw-tick is-silent" style="left:${x(m)}" title="went silent"></i>`
            : `<i class="aw-dot" style="left:${x(m)}" title="waits for you"></i>`,
    )
    .join("");
  return `<section class="section away" aria-labelledby="away-h">
    <div class="band"><span class="dot" style="background:var(--flight)"></span><h2 id="away-h">Since you were away</h2><span class="count hide-sm">14:20 → now</span>
      <span class="band-side"><a class="hide-sm" href="#/activity">All activity</a><button class="btn is-quiet is-sm" type="button" data-dismiss-away>Dismiss</button></span></div>
    <div class="aw">
      <div class="aw-strip" role="img" aria-label="Between 14:20 and now: 6 merged, 4 started, 1 went silent, 1 waits for you">
        <span class="aw-line"></span>${marks}<span class="aw-now"></span>
        <span class="aw-t" style="left:0">14:20</span><span class="aw-t" style="left:${x(100)}">16:00</span><span class="aw-t is-now" style="right:0">now</span>
      </div>
      <div class="aw-parts">
        <a class="aw-part" href="#/activity">${ship("var(--done)", 11)}<b>6</b> merged</a>
        <a class="aw-part" href="#/activity"><i class="aw-key" style="background:var(--flight)"></i><b>4</b> started</a>
        <a class="aw-part is-yours" href="#/validations"><span class="dot" style="background:var(--yours)"></span><b>4</b> wait for you</a>
        <a class="aw-part" href="#/agents/WID-17"><i class="aw-key" style="background:var(--silent)"></i><b>WID-17</b> silent for 42 min</a>
      </div>
    </div>
  </section>`;
}

/* /activity (THE-894): every event, newest first, one sentence each, on a
   rail; the owner's last visit is a line across it. Reports of one ticket in
   a row fold into one line. Filters are the address (a GET form). */
const FEED_LOOK = {
  merge: ["done", "Merged"],
  claim: ["ship", "Claimed"],
  report: ["report", "Reported"],
  handback: ["merge", "Handed back"],
  question: ["yours", "Asked a question"],
  validation: ["yours", "Asked for your validation"],
  plan: ["yours", "Submitted a plan"],
  decision: ["done", "You decided"],
  silent: ["silent", "Went silent"],
  coord: ["coord", "Coordinator started"],
};
function feedGlyph(k) {
  const g = FEED_LOOK[k][0];
  if (g === "ship") return `<span class="glyph" role="img" aria-label="claimed">${ship("var(--flight)", 12)}</span>`;
  if (g === "report") return `<span class="glyph" role="img" aria-label="report"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="var(--ink-3)"/></svg></span>`;
  return glyph(g, FEED_LOOK[k][1]);
}
function who(w) {
  if (w === "agent" || w === "coordinator") return `<span class="who">${w}</span>`;
  const ini = w
    .split(" ")
    .map((x) => x[0])
    .join("");
  return `<span class="who is-person"><span class="ini">${ini}</span>${w}</span>`;
}
function activity() {
  const head = bar(`<span>Activity</span>`) + topbar("Activity");
  const kinds = [
    ["Everything", true],
    ["Needs you"],
    ["Merges"],
    ["Claims"],
    ["Reports"],
    ["Decisions"],
  ];
  const toolbar = `<form class="toolbar" onsubmit="return false"><span class="seg" role="group" aria-label="Kind">${kinds.map(([k, on]) => `<button type="button" aria-pressed="${!!on}">${k}</button>`).join("")}</span>
    <span class="seg hide-sm"><button type="button" aria-pressed="true">All projects</button>${PROJECTS.map((p) => `<button type="button">${p.name}</button>`).join("")}</span>
    <span class="grow"></span><input class="input mono hide-sm" style="width:120px" placeholder="Ticket" aria-label="Ticket"/><select class="input hide-sm" aria-label="Who"><option>Anyone</option><option>Agents</option><option>Coordinators</option><option>People</option></select></form>`;
  if (state.mode === "loading") return head + skeletonStatus() + toolbar + band("Today", "…") + `<div class="rows">${skeletonRows(9)}</div>`;
  if (state.mode === "empty")
    return `${head}<div class="status"><h1>Nothing happened yet.</h1><p>Claims, reports, questions, decisions and merges appear here as they happen.</p></div>${toolbar}
    <div class="empty">${formationAtRest(104)}<h3>The log starts with the first claim</h3><p>Launch a ready ticket and follow it here from its claim to its merge.</p><div class="actions"><a class="btn is-primary" href="#/projects/armada">See the ready tickets</a></div></div>`;
  const rows = FEED.map(([t, k, id, title, detail, proj, w, n], i) => {
    const divider =
      t < "16:21" && FEED[i - 1] && FEED[i - 1][0] >= "16:21"
        ? `<div class="visit" role="separator"><span>${mark(12)}Your last visit, ${LAST_VISIT}: newer above</span></div>`
        : "";
    const quiet = k === "report";
    const what = k === "report" && n > 1 ? `Reported ${n} times` : FEED_LOOK[k][1];
    return `${divider}<a class="ev ${quiet ? "is-quiet" : ""}" href="${id ? `#/agents/${id}` : `#/projects/${proj}`}">
      <time class="ev-t">${t}</time>${feedGlyph(k)}
      <span class="ev-s"><b>${what}</b>${id ? ` <span class="mono ev-id">${id}</span>` : ""} <span class="ev-title">${esc(title)}</span> <span class="ev-d">${esc(detail)}</span></span>
      <span class="ev-end">${projChip(proj)}${who(w)}</span></a>`;
  }).join("");
  return `${head}${errorAlert()}
  <div class="status"><h1>16 events since you last looked. <span class="then">1 merge, 4 claims, 3 for you.</span></h1><p>Today, newest first, in your time zone. Each line opens its agent, validation or project.</p></div>
  ${toolbar}
  ${band("Today", `${FEED.length} events`, `<span class="mono">Thu 1 Oct</span>`)}
  <div class="feed">${rows}</div>
  <div class="empty-inline" style="justify-content:center"><a class="btn is-sm" href="#/activity">Older</a></div>`;
}

/* The System page: the direction's tokens, with live contrast ratios. */
function lum(hex) {
  const [r, g, b] = hex
    .replace("#", "")
    .match(/../g)
    .map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
function system() {
  const head = bar(`<span>System</span>`) + topbar("System");
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const planes = [
    ["Sky", "--sky", "the page, behind everything"],
    ["Deck", "--deck", "the main panel, lit from its top edge"],
    ["Band", "--band", "a section's header"],
    ["Instrument", "--instrument", "cards, figures, popovers"],
    ["Well", "--well", "inputs, quotes, code"],
  ];
  const inks = [
    ["Ink", "--ink", "titles, values"],
    ["Ink 2", "--ink-2", "body, facts"],
    ["Ink 3", "--ink-3", "lines, meta, times"],
    ["Done, live", "--done", "merged, ready, the live mark"],
    ["Yours", "--yours", "waits for your decision"],
    ["Silent", "--silent", "silent, idle, waits on someone"],
    ["In flight", "--flight", "planning, implementing, CI"],
    ["Failing", "--fail", "red CI, conflict, stopped"],
  ];
  const contrast = inks
    .map(([n, t, use]) => {
      const c = v(t);
      const d = ratio(c, v("--deck"));
      const i = ratio(c, v("--instrument"));
      const ok = Math.min(d, i) >= 4.5;
      return `<tr><td><span class="dot" style="background:${c};margin-right:8px"></span>${n}</td><td><code>${t}</code> <code>${c}</code></td><td>${use}</td><td class="mono">${d.toFixed(1)}:1</td><td class="mono">${i.toFixed(1)}:1</td><td class="${ok ? "pass" : ""}">${ok ? "AA" : "large text only"}</td></tr>`;
    })
    .join("");
  const motion = [
    ["0 ms", "<code>--t-0</code>", "j/k, Enter, Escape, ⌘K, tab switches", "nothing animates: keyboard actions are instant", "same"],
    ["150 ms", "<code>--t-1</code> ease", "hover fills, button press (scale .96), a glyph changing state", "colour and opacity only", "fade only"],
    ["220 ms", "<code>--t-2</code> ease-out", "a row arriving or leaving, a toast, a popover", "opacity + 4–16 px translate, interruptible transitions", "fade only"],
    ["320 ms", "<code>--t-3</code> ease-out", "a page's first load (sections, 40 ms apart), the horizon changing hue", "once per load", "instant"],
    ["600 ms", "ease-in-out", "the merge moment: the ship leaves the formation", "rare, never blocks: the row is already merged", "a check fades in, no flight"],
    ["900 ms", "ease-out", "the live mark's lead ship brightens on each poll (3 s)", "ambient, tiny, opacity only", "static lit ship"],
    ["1.6 s", "ease-out", "a row that just reported glows blue, then fades", "says what changed since the last poll", "kept, it is opacity"],
  ]
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `${head}
  <div class="status"><h1>Night watch. <span class="then">The dashboard is the sky the landing flies in, seen from the bridge.</span></h1>
  <p>Calm and dense like the Agents page, with the landing's light: one lit deck, one meaning per colour, the formation used with restraint. Every value below is a token in styles.css, named after the globals.css token it replaces.</p></div>
  <div class="sys">
    <section><h2>Depth: three planes</h2><p class="lead">The sky stays dark and flat. The deck is the one lit surface: a ring, a highlight on its top edge and the horizon glow. Instruments sit on the deck with a ring, a lit edge and a long, soft drop. Wells sink. Borders only where they mean structure (rows, bands).</p>
      <div class="swatches">${planes.map(([n, t, u]) => `<div class="sw"><div class="c" style="background:var(${t});box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)"></div><div><b style="font-weight:500">${n}</b><code>${t} ${v(t)}</code><span class="ink-3">${u}</span></div></div>`).join("")}</div></section>
    <section><h2>The horizon</h2><p class="lead">The deck's top edge glows with the fleet's state, always beside the page's status sentence, never alone. Blue when calm, orange when something waits for you, red when a session fails and nothing waits for you, green when everything shipped. It changes hue over 320 ms, at most once per poll.</p>
      <div class="demo-row">${[
        ["calm", "--flight", "Calm"],
        ["yours", "--yours", "Yours to decide"],
        ["fail", "--fail", "Failing"],
        ["clear", "--done", "All shipped"],
      ]
        .map(([k, t, n]) => `<button class="tile" data-set-horizon="${k}" style="position:relative;overflow:hidden;border:0;cursor:pointer"><span style="position:absolute;inset:-40px 10% auto;height:80px;background:radial-gradient(50% 50% at 50% 50%,var(${t}),transparent 70%);opacity:.35"></span><span style="position:absolute;top:0;left:20%;right:20%;height:1px;background:var(${t});opacity:.7"></span><b style="color:var(--ink);font-weight:500;position:relative">${n}</b><span style="position:relative">click to preview</span></button>`)
        .join("")}</div></section>
    <section><h2>Colour for meaning, AA everywhere</h2><p class="lead">One meaning per hue, shown on glyphs, figures and the horizon, always paired with a word or a shape. Text stays neutral. Each colour used for text passes 4.5:1 on the deck and on an instrument (computed live below).</p>
      <table class="tbl"><thead><tr><th>Colour</th><th>Token</th><th>Meaning</th><th>On deck</th><th>On instrument</th><th></th></tr></thead><tbody>${contrast}</tbody></table></section>
    <section><h2>Type: five sizes</h2><p class="lead">Geist and Geist Mono, as today. What changes: each page opens with its status in display size, with the landing's tight tracking; figures are mono at 32 px. Everything else stays 13 px, so the lists keep their density.</p>
      <div class="typeset">
        <div><code>display · 28/32 · 600 · −0.035em</code><span style="font-size:28px;font-weight:600;letter-spacing:-.035em;line-height:1.1">11 agents in flight. <span class="ink-3">4 wait for you.</span></span></div>
        <div><code>figure · mono 32 · 500 · −0.04em</code><span class="mono" style="font-size:32px;font-weight:500;letter-spacing:-.04em">5<span class="ink-3" style="font-size:18px">h</span>21</span></div>
        <div><code>body · 13/20 · 400–600</code><span>Add a local Codex harness adapter <span class="ink-3">Mapping Codex session events onto armada report</span></span></div>
        <div><code>small · 12/16</code><span style="font-size:12px" class="ink-2">Why you: a product choice the worker escalated</span></div>
        <div><code>meta · mono 11/16</code><span class="mono ink-3" style="font-size:11px">THE-862 · 31 min</span></div>
      </div></section>
    <section><h2>The formation, with restraint</h2><p class="lead">The mark appears in four places only, and never as decoration.</p>
      <div class="demo-row">
        <div class="tile">${mark(36, "js-beat")}<b style="color:var(--ink);font-weight:500">Live</b>the lead ship brightens on each poll</div>
        <div class="tile">${mark(36, "is-assembling")}<b style="color:var(--ink);font-weight:500">Loading</b>the formation assembles, ship by ship</div>
        <div class="tile">${mark(36, "is-paused")}<b style="color:var(--ink);font-weight:500">Paused</b>a reading failed; the lead ship turns amber</div>
        <div class="tile">${formationAtRest(44)}<b style="color:var(--ink);font-weight:500">At rest</b>empty states: one sentence, one action</div>
        <div class="tile"><span style="display:flex;gap:6px;align-items:center">${glyphSvg("done")}${ship("var(--done)", 14)}</span><b style="color:var(--ink);font-weight:500">Merged</b>the row's ship leaves the formation <button class="btn is-sm" data-play-merge>Play</button></div>
      </div></section>
    <section><h2>Motion</h2><p class="lead">Transform and opacity only, CSS transitions so every state change can be interrupted, nothing on a keyboard action. Reduced motion is calm, not still: crossfades stay, nothing travels, pulses or shimmers.</p>
      <table class="tbl"><thead><tr><th>Duration</th><th>Curve</th><th>What moves</th><th>Rule</th><th>Reduced motion</th></tr></thead><tbody>${motion}</tbody></table></section>
    <section><h2>Data</h2><p class="lead">Thin marks, a hue only where it means something, the previous period as a ghost, a caption with the numbers and a table behind every chart (THE-893's rule). The live timeline draws flight paths: earlier phases as a thin trail, the current phase as a bar, the agent as a ship at now, silences hatched in amber.</p>
      <div class="demo-row">
        <div class="tile">${phases(2, "flight")}<b style="color:var(--ink);font-weight:500">Phase bar</b>six steps, the current one lit</div>
        <div class="tile">${ring(0.89, 44, 3)}<b style="color:var(--ink);font-weight:500">Progress ring</b>a project's done tickets</div>
        <div class="tile"><span style="display:flex;gap:2px;width:120px;height:10px;border-radius:5px;overflow:hidden">${PHASE_TIME.map((p) => `<i style="flex:${p.h};background:${p.c};opacity:${p.op}"></i>`).join("")}</span><b style="color:var(--ink);font-weight:500">Where time goes</b>one stacked bar</div>
      </div></section>
    <section><h2>Density</h2><p class="lead">Compact: 36 px rows, 34 px bands, 13 px titles. Airy: 48 px rows, 40 px bands, 14 px titles. The toggle sits on the Agents page's toolbar, as today; the phone always uses two-line 56 px rows.</p>
      <div class="demo-row"><span class="seg"><button data-density="compact" aria-pressed="${state.density === "compact"}">Compact</button><button data-density="airy" aria-pressed="${state.density === "airy"}">Airy</button></span><a class="btn is-sm" href="#/agents">See it on Agents</a></div></section>
    <section><h2>Within THE-892's budgets</h2><p class="lead">Lighthouse 95 on every page at 4× CPU, CLS 0, LCP under 2.5 s on a phone, first-load JS within 5% of today, interactions under 200 ms. Night watch is CSS: it adds no dependency and almost no JavaScript.</p>
      <table class="tbl"><thead><tr><th>Piece</th><th>Cost</th><th>Rule for THE-899</th></tr></thead><tbody>${[
        ["Status sentence", "text, server-rendered", "It is most pages' LCP element: render it on the server with the page, in Geist's preloaded cut (display: optional), never after a fetch."],
        ["Since you were away", "one section above the fold", "Render it with the overview on the server (the visit is known there), like THE-892's weekly line. Never insert it above content after paint (CLS 0). Dismiss removes it with a fade."],
        ["Horizon", "one pseudo-element, a static radial gradient", "Driven by one data attribute on the main panel; its hue changes with an opacity fade, at most once per poll."],
        ["Depth", "box-shadow rings", "Static shadows only; nothing animates a shadow, a size or a position."],
        ["Backdrop blur", "paint on scroll", "Only on the phone's tab bar and on toasts. The sticky header bar and the phone's top bar are opaque."],
        ["Motion", "compositor only", "Transform and opacity, CSS transitions and keyframes. The merge flight is one Web Animations call; no motion library."],
        ["Live mark", "one 900 ms opacity keyframe every 3 s", "Paused while the tab is hidden, off with reduced motion."],
        ["Timeline ships", "one element per live session", "Server-rendered with the timeline chunk; rows keep a fixed height so content-visibility still skips rows off screen."],
        ["Rows, cards, charts", "CSS only", "Section, Row and Card keep their API and the long prop; rows keep a fixed height per density. Charts stay SVG without a library."],
        ["Kit additions", "server components", "StatusHeader, EmptyState, Skeleton, Alert, Ring and Figure render on the server. Only the merge moment and Dismiss need client code, in the components that already have it."],
      ]
        .map((r) => `<tr>${r.map((c, i) => `<td>${i ? c : `<b style="font-weight:500">${c}</b>`}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></section>
    <section><h2>Building it (THE-899)</h2><p class="lead">No new dependency. styles.css maps onto globals.css token for token; the page kit gains <code class="mono">StatusHeader</code> (the display sentence and its stats), <code class="mono">EmptyState</code>, <code class="mono">Skeleton</code>, <code class="mono">Alert</code>, <code class="mono">Ring</code> and <code class="mono">Figure</code>; <code class="mono">Section</code>, <code class="mono">Row</code>, <code class="mono">Card</code> and <code class="mono">Toolbar</code> keep their API and change only their CSS. The horizon is a pseudo-element on the shell's main panel driven by one data attribute.</p></section>
  </div>`;
}

/* ───────────────────────── Rendering ───────────────────────── */

function horizonFor() {
  if (state.horizon !== "auto") return state.horizon;
  if (state.mode === "error") return "fail";
  if (state.mode === "empty" || state.mode === "loading") return "calm";
  const r = route().split("/");
  if (r[0] === "agents" && r[1]) {
    const a = A[r[1]] || A["THE-862"];
    return { yours: "yours", fail: "fail", silent: "yours", merge: "clear" }[a.state] || "calm";
  }
  if (r[0] === "insights" || r[0] === "system") return "calm";
  return "yours";
}

function render() {
  const r = route();
  const sec = section(r);
  document.documentElement.dataset.density = state.density;
  document.documentElement.dataset.motion = state.motion;
  const deck = document.getElementById("deck");
  deck.dataset.horizon = horizonFor();
  let html;
  if (sec === "agents" && r.split("/")[1]) html = agent(r.split("/")[1]);
  else if (sec === "agents") html = agents();
  else if (sec === "projects" && r.split("/")[1]) html = project(r.split("/")[1]);
  else if (sec === "projects") html = projects();
  else if (sec === "validations") html = validations();
  else if (sec === "insights") html = insights();
  else if (sec === "activity") html = activity();
  else if (sec === "system") html = system();
  else html = overview();
  deck.innerHTML = `<div class="page">${html}</div>`;
  renderSide(r);
  renderTabbar(r);
  renderPanel();
  state.selected = -1;
  bindTimeline();
}

function renderPanel() {
  const el = document.getElementById("dpanel");
  const seg = (key, opts) =>
    `<span class="seg">${opts.map(([v, l]) => `<button data-k="${key}" data-v="${v}" aria-pressed="${state[key] === v}">${l}</button>`).join("")}</span>`;
  el.className = `dpanel ${state.panelOpen ? "" : "is-closed"}`;
  el.innerHTML = `<header data-toggle-panel>${mark(14)}Prototype<span class="grow"></span><span class="ink-3">${state.panelOpen ? "hide" : "show"}</span></header>
    <label>State ${seg("mode", [["live", "Live"], ["loading", "Loading"], ["empty", "Empty"], ["error", "Error"]])}</label>
    <label>Density ${seg("density", [["compact", "Compact"], ["airy", "Airy"]])}</label>
    <label>Motion ${seg("motion", [["full", "Full"], ["reduced", "Reduced"]])}</label>
    <label>Back after 3 h ${seg("away", [["on", "Since you were away"], ["off", "Off"]])}</label>
    <label>Horizon ${seg("horizon", [["auto", "Auto"], ["calm", "Calm"], ["yours", "Yours"], ["fail", "Fail"]])}</label>
    <button class="btn is-sm" data-play-merge>Play a merge (THE-858)</button>`;
}

/* ───────────────────────── Motion and behaviour ───────────────────────── */

const reduced = () => state.motion === "reduced";

// The live poll: every 3 s the lead ship brightens; now and then a row reports.
setInterval(() => {
  if (state.mode !== "live" || document.hidden) return;
  for (const m of document.querySelectorAll(".js-beat")) {
    m.classList.remove("is-beat");
    void m.getBoundingClientRect();
    m.classList.add("is-beat");
  }
}, 3000);
let tick = 0;
setInterval(() => {
  if (state.mode !== "live" || document.hidden || route() !== "agents") return;
  const lines = ["Writing the adapter's tests", "Mapping session events onto armada report", "Running the test suite", "Wiring the adapter into the CLI"];
  const row = document.querySelector('.row[data-id="THE-862"]');
  if (!row) return;
  row.querySelector(".row-line").textContent = lines[tick++ % lines.length];
  row.querySelector(".row-time").textContent = "now";
  row.classList.remove("is-new");
  row.querySelector(".flash")?.remove();
  void row.offsetWidth;
  row.classList.add("is-new");
  row.insertAdjacentHTML("afterbegin", '<span class="flash" aria-hidden="true"></span>');
}, 9000);

function toast(html) {
  const host = document.getElementById("toasts");
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = html;
  host.append(t);
  setTimeout(() => {
    t.classList.add("is-leaving");
    setTimeout(() => t.remove(), 240);
  }, 3600);
}

// The merge moment: the glyph turns to a check, a ship leaves, the row goes,
// the rows below close the gap (FLIP, transform only).
async function playMerge() {
  if (route() !== "agents") {
    location.hash = "#/agents";
    await new Promise((r) => setTimeout(r, 120));
  }
  if (state.merged.has("THE-858")) {
    state.merged.delete("THE-858");
    render();
    await new Promise((r) => setTimeout(r, 300));
  }
  const row = document.querySelector('.row[data-id="THE-858"]');
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  await new Promise((r) => setTimeout(r, 450));
  const g = row.querySelector(".glyph");
  const old = g.querySelector("svg");
  g.insertAdjacentHTML("beforeend", glyphSvg("done"));
  const next = g.lastElementChild;
  next.classList.add("out");
  requestAnimationFrame(() => {
    old.classList.add("out");
    next.classList.remove("out");
  });
  if (!reduced()) {
    const r = g.getBoundingClientRect();
    const deckR = document.getElementById("deck").getBoundingClientRect();
    const f = document.createElement("span");
    f.className = "fly";
    f.innerHTML = ship("var(--done)", 14);
    f.style.left = `${r.left - deckR.left + 18}px`;
    f.style.top = `${r.top - deckR.top + document.getElementById("deck").scrollTop + 1}px`;
    document.getElementById("deck").append(f);
    f.animate(
      [
        { transform: "translate(0,0)", opacity: 1 },
        { transform: "translate(140px,-26px)", opacity: 1, offset: 0.7 },
        { transform: "translate(200px,-38px)", opacity: 0 },
      ],
      { duration: 600, easing: "cubic-bezier(0.77, 0, 0.175, 1)", fill: "forwards" },
    ).onfinish = () => f.remove();
  }
  await new Promise((r) => setTimeout(r, 650));
  const below = [];
  let n = row.nextElementSibling;
  const all = [...document.querySelectorAll(".row, .band")];
  const idx = all.indexOf(row);
  for (const el of all.slice(idx + 1)) below.push([el, el.getBoundingClientRect().top]);
  row.classList.add("is-leaving");
  await new Promise((r) => setTimeout(r, 220));
  row.remove();
  state.merged.add("THE-858");
  const band = document.querySelector("#merge .count");
  if (band) band.textContent = "1";
  if (!reduced())
    for (const [el, top] of below) {
      const d = top - el.getBoundingClientRect().top;
      if (d) el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    }
  n = null;
  toast(`${glyphSvg("done")}<span><b>THE-858 merged.</b> <span class="ink-3">PR #317 is on main; the coordinator closed the ticket.</span></span>`);
}

function bindTimeline() {
  const tl = document.getElementById("tl");
  const cross = document.getElementById("tl-cross");
  if (!tl || !cross) return;
  tl.addEventListener("pointermove", (e) => {
    const r = tl.getBoundingClientRect();
    const name = parseFloat(getComputedStyle(tl).getPropertyValue("--name")) + 24;
    const end = parseFloat(getComputedStyle(tl).getPropertyValue("--end")) || 0;
    const x = e.clientX - r.left;
    if (x < name || x > r.width - end) {
      cross.style.opacity = "0";
      return;
    }
    cross.style.opacity = "";
    cross.style.left = `${x}px`;
    const mins = Math.round(((x - name) / (r.width - name - end)) * WINDOW);
    const t = 14 * 60 + 40 + mins;
    cross.firstElementChild.textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-k],[data-density],[data-play-merge],[data-toggle-panel],[data-set-horizon],[data-dismiss-away]");
  if (!t) return;
  if (t.hasAttribute("data-dismiss-away")) {
    // Dismissed: the section leaves (220 ms), the status sentence returns to the fleet.
    const sec = t.closest(".away");
    sec.classList.add("is-leaving");
    setTimeout(() => {
      state.away = "off";
      render();
    }, reduced() ? 0 : 220);
  } else if (t.dataset.k) {
    state[t.dataset.k] = t.dataset.v;
    render();
  } else if (t.dataset.density) {
    state.density = t.dataset.density;
    render();
  } else if (t.hasAttribute("data-play-merge")) {
    playMerge();
  } else if (t.hasAttribute("data-toggle-panel")) {
    state.panelOpen = !state.panelOpen;
    renderPanel();
  } else if (t.dataset.setHorizon) {
    state.horizon = t.dataset.setHorizon;
    document.getElementById("deck").dataset.horizon = state.horizon;
    renderPanel();
  }
});

// j/k moves through rows, Enter opens, Escape goes back: instant, never animated.
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,textarea") || e.metaKey || e.ctrlKey) return;
  const rows = [...document.querySelectorAll("a.row[data-row], a.row.coord")];
  if (e.key === "j" || e.key === "k") {
    if (!rows.length) return;
    state.selected = Math.max(0, Math.min(rows.length - 1, state.selected + (e.key === "j" ? 1 : -1)));
    rows.forEach((r, i) => r.setAttribute("aria-selected", String(i === state.selected)));
    rows[state.selected].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && state.selected >= 0 && rows[state.selected]) {
    location.hash = rows[state.selected].getAttribute("href");
  } else if (e.key === "Escape" && route().includes("/")) {
    location.hash = `#/${section(route())}`;
  }
});

window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});
render();
