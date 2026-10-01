// A synthetic fleet for local trials and screenshots: the dashboard v4
// mockup's Acme world (design/dashboard-v4), three projects with ten sessions
// in every state, their Linear programs and pull requests, and the live
// activity to seed. Times are relative to `now`, so the view always looks current.
import type {
  CiState,
  Comment,
  CoordinatorFacts,
  ForgeData,
  InboxKind,
  Issue,
  LabelPhase,
  ProgramData,
  ProjectInput,
  PullRequest,
} from "@armada/core/read";

export const DEMO_PROJECTS: ProjectInput[] = [
  { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" },
  { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GAD-1" },
  { slug: "armada", name: "Armada", repository: "The-Vibe-Company/armada", programRoot: "THE-812" },
];

/**
 * What THE-865 records about a project and its coordinator: `demo:seed` writes
 * the owner and the coordinator's inbox reads with its facts. Minutes are minutes ago.
 */
export interface DemoProjectFacts {
  /** Who registered the project. */
  owner: string;
  /** Tickets done under the root. */
  done: number;
  coordinator: {
    harness: "Conductor Cloud" | "Claude Code" | "Codex" | "terminal";
    /** The workspace/session for Conductor, the machine and tty for a local run. */
    where: string;
    profile: string;
    model: string | null;
    /** First command after 30 min of silence. */
    since: number;
    /** Its inbox reads, every 15 seconds as `armada watch` reads since it started, the last one `seen` minutes ago. */
    seen: number;
    /** Minutes ago between which it did not read its inbox, for an idle stretch on the timeline. */
    pause?: [number, number];
  };
}

export const DEMO_PROJECT_FACTS: Record<string, DemoProjectFacts> = {
  widgets: {
    owner: "Léa Martin",
    done: 14,
    coordinator: {
      harness: "Conductor Cloud",
      where: "ws-0c01/coord",
      profile: "opus",
      model: "opus-5-5-1m",
      since: 420,
      seen: 2,
      pause: [250, 205],
    },
  },
  gadgets: {
    owner: "Hugo Bernard",
    done: 6,
    coordinator: {
      harness: "Claude Code",
      where: "hugo-mbp/ttys004",
      profile: "opus",
      model: "opus-5-5-1m",
      since: 300,
      seen: 24,
    },
  },
  armada: {
    owner: "Camille Roux",
    done: 31,
    coordinator: {
      harness: "Codex",
      where: "camille-mbp/ttys011",
      profile: "codex",
      model: "gpt-6.1-sol",
      since: 190,
      seen: 1,
    },
  },
};

const HARNESS_FACT = {
  "Conductor Cloud": "conductor-cloud",
  "Claude Code": "claude-code",
  Codex: "codex",
  terminal: "terminal",
} as const satisfies Record<DemoProjectFacts["coordinator"]["harness"], CoordinatorFacts["harness"]>;

/** What a demo coordinator's commands tell Armada about it, as `armada inbox` records it. */
export function demoCoordinatorFacts(project: string): CoordinatorFacts | null {
  const c = DEMO_PROJECT_FACTS[project]?.coordinator;
  if (!c) return null;
  return { harness: HARNESS_FACT[c.harness], handle: c.where, model: c.model, cliVersion: null };
}

/** The minutes ago of a coordinator's inbox reads, newest first: every 15 seconds since it started, but in its pause. */
export function demoInboxReads(project: string): number[] {
  const c = DEMO_PROJECT_FACTS[project]?.coordinator;
  if (!c) return [];
  const reads: number[] = [];
  const paused = (m: number) => !!c.pause && m < c.pause[0] && m > c.pause[1];
  for (let m = c.seen; m < c.since; m += 0.25) if (!paused(m)) reads.push(m);
  return reads;
}

/** A changed file of a pull request, as THE-865's forge read gives it. */
export interface DemoFile {
  path: string;
  additions: number;
  deletions: number;
}

interface DemoTicket {
  id: string;
  project: string;
  title: string;
  phase: LabelPhase;
  runtime: string;
  agent: string;
  handle: string;
  /** The Conductor profile of armada.toml's template: opus, codex or debug. */
  profile: "opus" | "codex" | "debug";
  /** Minutes ago. */
  claimed: number;
  phaseSince: number;
  lastReport: number;
  summary: string;
  files: DemoFile[];
  pr?: { number: number; ci: CiState; mergeable?: "MERGEABLE" | "CONFLICTING"; opened: number };
  /** Minutes ago between which the worker did not report, for a past silence on the timeline. */
  quiet?: [number, number];
  /**
   * Minutes ago of status lines other agents left on the ticket before its
   * claim (input for it, not a claim): they are not part of this session.
   */
  notes?: number[];
  /** Minutes between two reports while it works; 12 by default. */
  every?: number;
}

const f = (path: string, additions: number, deletions: number): DemoFile => ({ path, additions, deletions });

const TICKETS: DemoTicket[] = [
  {
    id: "WID-15",
    project: "widgets",
    title: "Sign in with a magic link",
    phase: "blocked",
    runtime: "Conductor",
    agent: "Worker A",
    handle: "ws-4f2a/ses-91",
    profile: "opus",
    claimed: 95,
    phaseSince: 12,
    lastReport: 12,
    summary: "Asked how long a sign-in link stays valid",
    files: [
      f("src/auth/magic-link.ts", 142, 0),
      f("src/auth/routes.ts", 38, 6),
      f("src/mail/templates/sign-in.tsx", 64, 0),
      f("test/auth/magic-link.test.ts", 97, 0),
    ],
  },
  {
    id: "WID-18",
    project: "widgets",
    title: "Add a dark theme to the settings page",
    phase: "ready-to-merge",
    runtime: "Claude Code",
    agent: "Worker B",
    handle: "ws-77c0/ses-12",
    profile: "opus",
    claimed: 210,
    phaseSince: 6,
    lastReport: 6,
    summary: "Handed back: CI green on the final head",
    files: [
      f("src/settings/theme.css", 88, 12),
      f("src/settings/ThemeToggle.tsx", 54, 0),
      f("src/settings/page.tsx", 9, 3),
    ],
    pr: { number: 44, ci: "success", opened: 70 },
  },
  {
    id: "WID-14",
    project: "widgets",
    title: "Show the invoice total on the order page",
    phase: "shipping",
    runtime: "Conductor",
    agent: "Worker C",
    handle: "ws-1b9e/ses-40",
    profile: "opus",
    claimed: 160,
    phaseSince: 38,
    lastReport: 4,
    summary: "Fixing the rounding test that fails in CI",
    files: [
      f("src/orders/total.ts", 22, 9),
      f("src/orders/OrderPage.tsx", 31, 4),
      f("test/orders/total.test.ts", 40, 2),
    ],
    pr: { number: 41, ci: "failure", opened: 38 },
  },
  {
    id: "WID-12",
    project: "widgets",
    title: "Let users export a report as CSV",
    phase: "implementing",
    runtime: "Claude Code",
    agent: "Worker D",
    handle: "ws-c3d1/ses-08",
    profile: "opus",
    claimed: 75,
    phaseSince: 52,
    lastReport: 3,
    summary: "Streaming rows instead of building the file in memory",
    files: [
      f("src/reports/export-csv.ts", 118, 0),
      f("src/reports/routes.ts", 14, 1),
      f("test/reports/export-csv.test.ts", 76, 0),
    ],
  },
  {
    id: "WID-17",
    project: "widgets",
    title: "Retry failed webhook deliveries",
    phase: "implementing",
    runtime: "Codex",
    agent: "Worker E",
    handle: "ws-90aa/ses-33",
    profile: "codex",
    claimed: 130,
    phaseSince: 100,
    lastReport: 42,
    summary: "Backoff schedule written, wiring the queue",
    files: [f("src/webhooks/retry.ts", 67, 0), f("src/webhooks/queue.ts", 21, 8)],
  },
  {
    id: "GAD-5",
    project: "gadgets",
    title: "Speed up the product search page",
    phase: "shipping",
    runtime: "Conductor",
    agent: "Worker F",
    handle: "ws-5e61/ses-02",
    profile: "codex",
    claimed: 240,
    phaseSince: 25,
    lastReport: 2,
    summary: "Rebasing on main after the catalogue change",
    files: [f("src/search/query.ts", 45, 61), f("src/search/index.ts", 12, 3), f("src/catalogue/schema.sql", 4, 1)],
    pr: { number: 12, ci: "pending", mergeable: "CONFLICTING", opened: 25 },
    quiet: [95, 45],
  },
  {
    id: "GAD-3",
    project: "gadgets",
    title: "Import products from a spreadsheet",
    phase: "awaiting-approval",
    runtime: "Claude Code",
    agent: "Worker G",
    handle: "ws-d810/ses-17",
    profile: "opus",
    claimed: 44,
    phaseSince: 18,
    lastReport: 18,
    summary: "Plan posted: parse, validate, then import in one transaction",
    files: [f("docs/plans/gad-3.md", 48, 0)],
  },
  {
    id: "GAD-6",
    project: "gadgets",
    title: "Send a weekly digest email",
    phase: "planning",
    runtime: "Codex",
    agent: "Worker H",
    handle: "ws-2c47/ses-55",
    profile: "codex",
    claimed: 6,
    phaseSince: 6,
    lastReport: 4,
    summary: "Reading the spec and the mailer code",
    files: [],
  },
  {
    id: "THE-862",
    project: "armada",
    title: "Add a local Codex harness adapter",
    phase: "implementing",
    runtime: "Conductor",
    agent: "Worker I",
    handle: "ws-a1c4/ses-03",
    profile: "opus",
    claimed: 58,
    phaseSince: 31,
    lastReport: 1,
    summary: "Mapping Codex session events onto armada report",
    notes: [1650, 1340],
    files: [
      f("packages/core/src/harness/codex-local.ts", 156, 0),
      f("packages/core/src/harness/index.ts", 8, 2),
      f("packages/core/test/codex-local.test.ts", 88, 0),
    ],
  },
  {
    id: "THE-858",
    project: "armada",
    title: "Show the harness on every session",
    phase: "ready-to-merge",
    runtime: "Conductor",
    agent: "Worker J",
    handle: "ws-b20e/ses-77",
    profile: "opus",
    claimed: 180,
    phaseSince: 9,
    lastReport: 9,
    summary: "Handed back: PR #317 green, head 7c1e0a4",
    files: [f("packages/dashboard/components/Fleet.tsx", 36, 4), f("packages/core/src/live.ts", 19, 2)],
    pr: { number: 317, ci: "success", opened: 52 },
  },
];

/** The model and effort each profile of armada.toml's template runs. */
export const DEMO_PROFILES = {
  opus: { agent: "claude", model: "opus-5-5-1m", effort: "high" },
  codex: { agent: "codex", model: "gpt-6.1-sol", effort: "high" },
  debug: { agent: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
} as const;

/** The changed files of a demo ticket's work, for THE-865's per-PR facts. */
export const demoFiles = (ticket: string): DemoFile[] => TICKETS.find((t) => t.id === ticket)?.files ?? [];

/** Tickets ready to start: on the frontier, their labels routed by the armada.toml template (web, api, Bug). */
const READY: { id: string; project: string; title: string; labels: string[]; blockedBy?: string }[] = [
  {
    id: "WID-20",
    project: "widgets",
    title: "Let users change their email address",
    labels: ["ready-for-agent", "web"],
  },
  { id: "WID-21", project: "widgets", title: "Rate-limit the public API", labels: ["ready-for-agent", "api"] },
  {
    id: "WID-22",
    project: "widgets",
    title: "Fix: refunds round the total the wrong way",
    labels: ["ready-for-agent", "Bug"],
  },
  { id: "WID-23", project: "widgets", title: "Archive invoices older than a year", labels: [] },
  {
    id: "WID-24",
    project: "widgets",
    title: "Email the invoice as a PDF",
    labels: ["ready-for-agent"],
    blockedBy: "WID-14",
  },
  { id: "GAD-8", project: "gadgets", title: "Filter the catalogue by size", labels: ["ready-for-agent", "web"] },
  { id: "THE-864", project: "armada", title: "Spike a boat.dev harness", labels: ["ready-for-agent"] },
  { id: "THE-866", project: "armada", title: "Filter the fleet by harness", labels: ["ready-for-agent", "web"] },
];

export interface DemoInbox {
  project: string;
  ticket: string;
  kind: InboxKind;
  author: string;
  body: string;
  /** Minutes ago. */
  ago: number;
}

export const DEMO_INBOX: DemoInbox[] = [
  {
    project: "widgets",
    ticket: "WID-15",
    kind: "question",
    author: "Worker A",
    body: "How long should a sign-in link stay valid?\nShorter is safer; longer survives a slow mail server.\n\nOptions:\n1. 15 minutes (recommended)\n2. 30 minutes",
    ago: 12,
  },
  {
    project: "gadgets",
    ticket: "GAD-3",
    kind: "plan",
    author: "Worker G",
    body: "Parse the sheet, validate every row, then import in one transaction.\nRows that fail validation are listed back to the user; nothing is written until all pass.",
    ago: 18,
  },
  {
    project: "widgets",
    ticket: "WID-18",
    kind: "hand-back",
    author: "Worker B",
    body: "PR #44 is ready: head a3f9c2e, CI green.",
    ago: 6,
  },
  {
    project: "armada",
    ticket: "THE-858",
    kind: "hand-back",
    author: "Worker J",
    body: "PR #317 is ready: head 7c1e0a4, CI green.",
    ago: 9,
  },
];

/** Minutes ago the coordinator of each project last read its inbox; absent = never. */
export const DEMO_COORDINATOR_SEEN: Record<string, number> = Object.fromEntries(
  Object.entries(DEMO_PROJECT_FACTS).map(([slug, p]) => [slug, p.coordinator.seen]),
);

/**
 * `fleet` is the mockup's world; `busy` adds twenty sessions that ran the
 * whole day, a report every 2 minutes, to try the live timeline at 30
 * sessions over 24 hours (THE-880); `empty` has none.
 */
export type Scenario = "fleet" | "busy" | "empty";

const BUSY: DemoTicket[] = Array.from({ length: 20 }, (_, k) => {
  const project = DEMO_PROJECTS[k % DEMO_PROJECTS.length] as ProjectInput;
  const prefix = project.programRoot.split("-")[0];
  return {
    id: `${prefix}-${300 + k}`,
    project: project.slug,
    title: `Busy session ${k + 1}`,
    phase: "implementing",
    runtime: ["Conductor", "Claude Code", "Codex"][k % 3] as string,
    agent: `Busy worker ${k + 1}`,
    handle: `ws-busy/ses-${k + 1}`,
    profile: "opus",
    claimed: 1440 - k * 7,
    phaseSince: 1300 - k * 7,
    lastReport: 1 + (k % 3),
    summary: "Working through the day",
    files: [],
    every: 2,
  };
});

export const demoTickets = (scenario: Scenario) =>
  scenario === "empty" ? [] : scenario === "busy" ? [...TICKETS, ...BUSY] : TICKETS;

/** The scenario a mode names (`ARMADA_DASHBOARD_DEMO`, `demo:seed`); the mockup's world by default. */
export const scenarioOf = (mode: string | undefined): Scenario =>
  mode === "empty" || mode === "busy" ? mode : "fleet";

const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

function issue(id: string, over: Partial<Issue>): Issue {
  return {
    id,
    uuid: `demo-${id}`,
    title: id,
    url: `https://linear.app/acme/issue/${id}`,
    status: "Backlog",
    statusType: "backlog",
    assignee: null,
    delegate: null,
    labels: [],
    parentId: null,
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-05T09:00:00.000Z",
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    agentPhase: null,
    agentRuntime: null,
    blockedBy: [],
    prs: [],
    ...over,
  };
}

function pullRequest(t: DemoTicket, repo: string, now: Date): PullRequest | null {
  if (!t.pr) return null;
  const checks = ["Lint, typecheck and test", "Build"].map((name, k) => ({
    name,
    state: t.pr?.ci === "failure" && k === 0 ? ("failure" as const) : (t.pr?.ci ?? "none"),
  }));
  return {
    url: `https://github.com/${repo}/pull/${t.pr.number}`,
    number: t.pr.number,
    repo,
    title: t.title,
    state: "open",
    draft: false,
    ci: t.pr.ci,
    checks,
    mergeable: t.pr.mergeable ?? "MERGEABLE",
    headRef: `feature/${t.id.toLowerCase()}`,
    headSha: "a3f9c2e1d4b5a6978877665544332211ffeeddcc",
    files: t.files,
    additions: t.files.reduce((n, f) => n + f.additions, 0),
    deletions: t.files.reduce((n, f) => n + f.deletions, 0),
    filesComplete: true,
    createdAt: ago(now, t.pr.opened),
    updatedAt: ago(now, Math.min(t.lastReport, t.pr.opened)),
    mergedAt: null,
  };
}

/** The phases a demo ticket went through before its current one. */
const BEFORE: Record<LabelPhase, LabelPhase[]> = {
  planning: [],
  "awaiting-approval": ["planning"],
  implementing: ["planning", "awaiting-approval"],
  shipping: ["planning", "awaiting-approval", "implementing"],
  "ready-to-merge": ["planning", "awaiting-approval", "implementing", "shipping"],
  blocked: ["planning", "awaiting-approval", "implementing"],
  "awaiting-validation": ["planning", "awaiting-approval", "implementing"],
};

const AT_WORK: Record<LabelPhase, string> = {
  planning: "Reading the ticket and the code",
  "awaiting-approval": "Plan posted for approval",
  implementing: "Writing the change and its tests",
  shipping: "Pull request open, waiting for CI",
  "ready-to-merge": "Handed back",
  blocked: "Waiting for an answer",
  "awaiting-validation": "Design submitted for the owner's validation",
};

/** A report of a demo ticket: minutes ago, oldest first. */
export interface DemoReport {
  ago: number;
  phase: LabelPhase;
  summary: string;
}

/**
 * The reports behind a demo ticket's timeline: its earlier phases between the
 * claim and its current phase (shipping from its pull request), a report every
 * 12 minutes while the worker works (one for a plan or a question), none while
 * it is quiet, then its last report.
 */
export function demoReports(t: DemoTicket): DemoReport[] {
  const past = BEFORE[t.phase];
  const opened = t.pr?.opened;
  const shipFrom = past.includes("shipping") && opened !== undefined ? opened : null;
  const early = past.filter((p) => p !== "shipping" || shipFrom === null);
  const span = (t.claimed - (shipFrom ?? t.phaseSince)) / Math.max(1, early.length);
  const phases: { phase: LabelPhase; from: number; to: number }[] = early.map((phase, k) => ({
    phase,
    from: Math.round(t.claimed - k * span),
    to: Math.round(t.claimed - (k + 1) * span),
  }));
  if (shipFrom !== null) phases.push({ phase: "shipping", from: shipFrom, to: t.phaseSince });
  phases.push({ phase: t.phase, from: t.phaseSince, to: t.lastReport });
  const reports: DemoReport[] = [];
  const quiet = (m: number) => !!t.quiet && m < t.quiet[0] && m > t.quiet[1];
  for (const p of phases) {
    const once = p.phase === "awaiting-approval" || p.phase === "awaiting-validation" || p.phase === "blocked" || p.phase === "ready-to-merge";
    for (let m = p.from; m > p.to; m -= once ? Number.POSITIVE_INFINITY : (t.every ?? 12))
      if (!quiet(m) && m !== t.claimed) reports.push({ ago: m, phase: p.phase, summary: AT_WORK[p.phase] });
  }
  const last = reports.at(-1);
  if (last?.ago === t.lastReport) last.summary = t.summary;
  else reports.push({ ago: t.lastReport, phase: t.phase, summary: t.summary });
  return reports;
}

/** The Linear program and GitHub pull requests of a demo project, as core reads them. */
export function demoSnapshot(
  project: ProjectInput,
  scenario: Scenario,
  now: Date,
): { program: ProgramData; forge: ForgeData } {
  const prefix = project.programRoot.split("-")[0] ?? "X";
  const specId = `${prefix}-2`;
  const tickets = demoTickets(scenario).filter((t) => t.project === project.slug);
  const issues: Issue[] = [
    issue(project.programRoot, { title: `${project.name} roadmap`, statusType: "started" }),
    issue(specId, {
      title: "Spec 1/1 — Checkout customers trust",
      parentId: project.programRoot,
      statusType: "started",
    }),
  ];
  // The tickets already done under the root, so the project's progress reads as in the mockup.
  const done = scenario !== "empty" ? (DEMO_PROJECT_FACTS[project.slug]?.done ?? 1) : 1;
  for (let k = 0; k < done; k++)
    issues.push(
      issue(`${prefix}-${100 + k}`, {
        title: k === 0 ? "Keep the cart when a session expires" : `Shipped change ${k + 1}`,
        parentId: specId,
        statusType: "completed",
        completedAt: ago(now, 600 + k * 90),
      }),
    );
  if (scenario !== "empty")
    for (const r of READY.filter((t) => t.project === project.slug))
      issues.push(
        issue(r.id, {
          title: r.title,
          parentId: specId,
          labels: r.labels,
          blockedBy: r.blockedBy ? [{ id: r.blockedBy, statusType: "started" }] : [],
        }),
      );
  const comments: Comment[] = [];
  const prs: PullRequest[] = [];
  for (const t of tickets) {
    const pr = pullRequest(t, project.repository, now);
    if (pr) prs.push(pr);
    issues.push(
      issue(t.id, {
        title: t.title,
        parentId: specId,
        status: "In Progress",
        statusType: "started",
        assignee: t.agent,
        labels: [t.phase, t.runtime],
        agentPhase: t.phase,
        agentRuntime: t.runtime,
        startedAt: ago(now, t.claimed),
        updatedAt: ago(now, t.lastReport),
        prs: pr ? [pr] : [],
      }),
    );
    const base = { issueId: t.id, author: t.agent, excerpt: "" };
    for (const [k, m] of (t.notes ?? []).entries())
      comments.push({
        ...base,
        id: `${t.id}-note-${k}`,
        author: "Another worker",
        createdAt: ago(now, m),
        status: { phase: "planning", summary: "input for this ticket from another campaign (not a claim)" },
        claim: null,
      });
    comments.push({
      ...base,
      id: `${t.id}-claim`,
      createdAt: ago(now, t.claimed),
      status: { phase: "planning", summary: "claimed, reading the ticket" },
      claim: {
        runtime: t.runtime,
        session: t.handle,
        branch: `feature/${t.id.toLowerCase()}`,
        startedAt: ago(now, t.claimed),
        at: ago(now, t.claimed),
        author: t.agent,
      },
    });
    for (const [k, r] of demoReports(t).entries())
      comments.push({
        ...base,
        id: `${t.id}-report-${k}`,
        createdAt: ago(now, r.ago),
        status: { phase: r.phase, summary: r.summary },
        claim: null,
      });
  }
  return {
    program: {
      rootId: project.programRoot,
      fetchedAt: now.toISOString(),
      issues,
      comments: comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      warnings: [],
    },
    forge: { repo: project.repository, fetchedAt: now.toISOString(), prs, warnings: [] },
  };
}

/** The live activity behind the demo tickets: claims, reports and runtime handles. */
export function demoEvents(scenario: Scenario) {
  return demoTickets(scenario).map((t) => ({
    project: t.project,
    ticket: t.id,
    runtime: t.runtime,
    handle: t.handle,
    profile: t.profile,
    claimed: t.claimed,
    phase: t.phase,
    summary: t.summary,
    lastReport: t.lastReport,
  }));
}

/** The demo project a ticket id belongs to. */
export const projectOfTicket = (ticket: string) =>
  DEMO_PROJECTS.find((p) => ticket.toUpperCase().startsWith(`${p.programRoot.split("-")[0]}-`)) ?? null;
