// A synthetic fleet for local trials and screenshots: two invented projects,
// their Linear programs and pull requests, and the live activity to seed.
// Times are relative to `now`, so the view always looks current.
import type {
  CiState,
  Comment,
  ForgeData,
  InboxKind,
  Issue,
  LabelPhase,
  ProgramData,
  ProjectInput,
  PullRequest,
} from "@armada/core/read";

export const DEMO_PROJECTS: ProjectInput[] = [
  { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GAD-1" },
  { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" },
];

interface DemoTicket {
  id: string;
  project: string;
  title: string;
  phase: LabelPhase;
  runtime: string;
  agent: string;
  handle: string;
  /** Minutes ago. */
  claimed: number;
  phaseSince: number;
  lastReport: number;
  summary: string;
  pr?: { number: number; ci: CiState; mergeable?: "MERGEABLE" | "CONFLICTING"; opened: number };
}

const TICKETS: DemoTicket[] = [
  {
    id: "WID-15",
    project: "widgets",
    title: "Sign in with a magic link",
    phase: "blocked",
    runtime: "Conductor",
    agent: "Worker A",
    handle: "ws-4f2a/ses-91",
    claimed: 95,
    phaseSince: 12,
    lastReport: 12,
    summary: "Asked how long a sign-in link stays valid",
  },
  {
    id: "WID-18",
    project: "widgets",
    title: "Add a dark theme to the settings page",
    phase: "ready-to-merge",
    runtime: "Claude Code",
    agent: "Worker B",
    handle: "ws-77c0/ses-12",
    claimed: 210,
    phaseSince: 6,
    lastReport: 6,
    summary: "Handed back: CI green on the final head",
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
    claimed: 160,
    phaseSince: 38,
    lastReport: 4,
    summary: "Fixing the rounding test that fails in CI",
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
    claimed: 75,
    phaseSince: 52,
    lastReport: 3,
    summary: "Streaming rows instead of building the file in memory",
  },
  {
    id: "WID-17",
    project: "widgets",
    title: "Retry failed webhook deliveries",
    phase: "implementing",
    runtime: "Codex",
    agent: "Worker E",
    handle: "ws-90aa/ses-33",
    claimed: 130,
    phaseSince: 100,
    lastReport: 42,
    summary: "Backoff schedule written, wiring the queue",
  },
  {
    id: "GAD-5",
    project: "gadgets",
    title: "Speed up the product search page",
    phase: "shipping",
    runtime: "Conductor",
    agent: "Worker F",
    handle: "ws-5e61/ses-02",
    claimed: 240,
    phaseSince: 25,
    lastReport: 2,
    summary: "Rebasing on main after the catalogue change",
    pr: { number: 12, ci: "pending", mergeable: "CONFLICTING", opened: 25 },
  },
  {
    id: "GAD-3",
    project: "gadgets",
    title: "Import products from a spreadsheet",
    phase: "awaiting-approval",
    runtime: "Claude Code",
    agent: "Worker G",
    handle: "ws-d810/ses-17",
    claimed: 44,
    phaseSince: 18,
    lastReport: 18,
    summary: "Plan posted: parse, validate, then import in one transaction",
  },
  {
    id: "GAD-6",
    project: "gadgets",
    title: "Send a weekly digest email",
    phase: "planning",
    runtime: "Codex",
    agent: "Worker H",
    handle: "ws-2c47/ses-55",
    claimed: 6,
    phaseSince: 6,
    lastReport: 4,
    summary: "Reading the spec and the mailer code",
  },
];

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
    project: "widgets",
    ticket: "WID-18",
    kind: "hand-back",
    author: "Worker B",
    body: "PR #44 ready: head a3f9c2e, CI green",
    ago: 6,
  },
];

/** Minutes ago the coordinator of each project last read its inbox; absent = never. */
export const DEMO_COORDINATOR_SEEN: Record<string, number> = { widgets: 2 };

export type Scenario = "fleet" | "empty";

export const demoTickets = (scenario: Scenario) => (scenario === "empty" ? [] : TICKETS);

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
    createdAt: ago(now, t.pr.opened),
    updatedAt: ago(now, Math.min(t.lastReport, t.pr.opened)),
    mergedAt: null,
  };
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
    issue(`${prefix}-4`, {
      title: "Keep the cart when a session expires",
      parentId: specId,
      statusType: "completed",
      completedAt: ago(now, 600),
    }),
  ];
  if (scenario === "fleet")
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
    comments.push({
      ...base,
      id: `${t.id}-phase`,
      createdAt: ago(now, t.phaseSince),
      status: { phase: t.phase, summary: t.phaseSince === t.lastReport ? t.summary : "phase started" },
      claim: null,
    });
    if (t.lastReport !== t.phaseSince)
      comments.push({
        ...base,
        id: `${t.id}-report`,
        createdAt: ago(now, t.lastReport),
        status: { phase: t.phase, summary: t.summary },
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
    claimed: t.claimed,
    phase: t.phase,
    summary: t.summary,
    lastReport: t.lastReport,
  }));
}

/** The demo project a ticket id belongs to. */
export const projectOfTicket = (ticket: string) =>
  DEMO_PROJECTS.find((p) => ticket.toUpperCase().startsWith(`${p.programRoot.split("-")[0]}-`)) ?? null;
