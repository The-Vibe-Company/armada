// Test support: a fake `fetch` that replays recorded Linear and GitHub
// responses (no network), and a builder for normalized issues.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { GITHUB_GRAPHQL } from "../src/github.ts";
import { agentLabels, type Fetch, LINEAR_ENDPOINT, normalizeComment, parsePullRequestUrl } from "../src/linear.ts";
import type { LinearWriter, Ticket, TicketChange, TicketLabel, WorkflowState } from "../src/linear-write.ts";
import { type Db, openTurso } from "../src/turso.ts";
import { type Comment, type Issue, LABEL_PHASES } from "../src/types.ts";
import githubPulls from "./fixtures/github-pulls.json";
import linearProgram from "./fixtures/linear-program.json";

export const NOW = new Date("2026-03-04T10:00:00.000Z");

export const DEMO_TOML = `
[project]
name = "Widgets"
slug = "widgets"

[tracker]
program_root = "DEMO-1"

[github]
repository = "acme/widgets"
`;

export const demoConfig = () => parseConfig(DEMO_TOML);

export interface Call {
  url: string;
  operation: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

/** Replays the recorded responses in order, per GraphQL operation name. */
export function recordedFetch(
  overrides: { github?: unknown; linear?: (recorded: typeof linearProgram) => void } = {},
): { fetch: Fetch; calls: Call[] } {
  const recorded = structuredClone(linearProgram);
  overrides.linear?.(recorded);
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(recorded).map(([op, responses]) => [op, [...responses]]),
  );
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = body.query.match(/query\s+(\w+)/)?.[1] ?? "?";
    const authorization = new Headers(init.headers).get("Authorization");
    calls.push({ url, operation, variables: body.variables, authorization });
    if (url === GITHUB_GRAPHQL) return Response.json(overrides.github ?? githubPulls);
    if (url !== LINEAR_ENDPOINT) throw new Error(`unexpected URL ${url}`);
    const next = queues[operation]?.shift();
    if (!next) throw new Error(`no recorded response left for ${operation}`);
    return Response.json(next);
  };
  return { fetch, calls };
}

let seq = 0;
export function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    uuid: `uuid-${++seq}`,
    title: id,
    url: `https://linear.app/acme/issue/${id}`,
    status: "Backlog",
    statusType: "backlog",
    assignee: null,
    delegate: null,
    labels: [],
    parentId: null,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
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

const tempDirs: string[] = [];
const openDbs: Db[] = [];

export function trackDb(db: Db): Db {
  openDbs.push(db);
  return db;
}

/** A fresh local libSQL file: the same client and SQL as a remote Turso database. */
export async function tempTurso(): Promise<{ url: string; db: Db }> {
  const dir = await mkdtemp(join(tmpdir(), "armada-turso-"));
  tempDirs.push(dir);
  const url = `file:${join(dir, "armada.db")}`;
  return { url, db: trackDb(await openTurso({ url })) };
}

/** Closes every database opened by the helpers above and removes their files. */
export async function closeTempTurso(): Promise<void> {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ fake Linear writer

export const LABELS: TicketLabel[] = [
  ...LABEL_PHASES.map((name) => ({ id: `phase-${name}`, name, group: "Agent phase" })),
  { id: "rt-conductor", name: "Conductor", group: "Agent runtime" },
  { id: "rt-claude", name: "Claude Code", group: "Agent runtime" },
  { id: "ready", name: "ready-for-agent", group: null },
];

export const STATES: WorkflowState[] = [
  { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-progress", name: "In Progress", type: "started", position: 2 },
  { id: "st-done", name: "Done", type: "completed", position: 3 },
];

/**
 * In-memory Linear for the write commands: one ticket per id, label and state
 * catalogs above, comments stamped by an injected clock. Records every write.
 */
export class FakeLinear implements LinearWriter {
  readonly tickets = new Map<string, Ticket>();
  readonly writes: string[] = [];
  /** Full body of every comment posted through the writer, in order. */
  readonly bodies: string[] = [];
  private seq = 0;
  /** Called after a comment is posted, before it is returned (to simulate a race). */
  afterComment: ((ticket: Ticket) => void) | null = null;

  constructor(private readonly clock: () => Date = () => NOW) {}

  add(id: string, over: Partial<Ticket> = {}): Ticket {
    const t: Ticket = {
      id,
      uuid: `uuid-${id}`,
      title: `Ticket ${id}`,
      url: `https://linear.app/acme/issue/${id}`,
      branchName: `feature/${id.toLowerCase()}-do-the-thing`,
      statusType: "backlog",
      stateId: "st-backlog",
      teamId: "team-1",
      assigneeId: null,
      labels: [],
      agentPhase: null,
      agentRuntime: null,
      states: STATES,
      comments: [],
      prs: [],
      commentsTruncated: false,
      warnings: [],
      ...over,
    };
    this.tickets.set(id, t);
    return t;
  }

  /** Adds a comment as if another agent had posted it at `at`. */
  post(id: string, body: string, at: string, author = "Other Worker"): Comment {
    const t = this.get(id);
    const c = normalizeComment(
      { id: `c-${String(++this.seq).padStart(4, "0")}`, createdAt: at, body, user: { name: author } },
      id,
    );
    t.comments = [c, ...t.comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c;
  }

  get(id: string): Ticket {
    const t = this.tickets.get(id) ?? [...this.tickets.values()].find((x) => x.uuid === id);
    if (!t) throw new Error(`no fake ticket ${id}`);
    return t;
  }

  async viewer() {
    return { id: "user-owner", name: "Owner" };
  }

  async readTicket(id: string) {
    const t = this.tickets.get(id);
    if (!t) return null;
    const labels = t.labels.map((l) => ({ name: l.name, group: l.group }));
    return structuredClone({
      ...t,
      ...agentLabels(labels, { phaseGroup: "Agent phase", runtimeGroup: "Agent runtime" }),
    });
  }

  async groupLabels(group: string) {
    return LABELS.filter((l) => l.group === group);
  }

  async updateTicket(uuid: string, change: TicketChange) {
    const t = this.get(uuid);
    this.writes.push(`update ${t.id} ${JSON.stringify(change)}`);
    if (change.stateId) {
      const s = STATES.find((x) => x.id === change.stateId);
      if (!s) throw new Error(`unknown state ${change.stateId}`);
      t.stateId = s.id;
      t.statusType = s.type;
    }
    if (change.assigneeId) t.assigneeId = change.assigneeId;
    t.labels = t.labels.filter((l) => !change.removeLabelIds?.includes(l.id));
    for (const id of change.addLabelIds ?? []) {
      const l = LABELS.find((x) => x.id === id);
      if (!l) throw new Error(`unknown label ${id}`);
      t.labels.push(l);
    }
  }

  async comment(uuid: string, body: string) {
    const t = this.get(uuid);
    this.writes.push(`comment ${t.id} ${body.split("\n")[0]}`);
    this.bodies.push(body);
    const c = this.post(t.id, body, this.clock().toISOString(), "Owner");
    this.afterComment?.(t);
    return { id: c.id };
  }

  async deleteComment(id: string) {
    for (const t of this.tickets.values()) t.comments = t.comments.filter((c) => c.id !== id);
    this.writes.push(`delete comment ${id}`);
  }

  async linkUrl(uuid: string, url: string, title: string) {
    const t = this.get(uuid);
    this.writes.push(`link ${t.id} ${url}`);
    const pr = parsePullRequestUrl(url, title);
    if (pr) t.prs.push(pr);
  }
}

/** A GitHub GraphQL answer for one pull request with the given head and checks. */
export function pullResponse(o: {
  number: number;
  headSha: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  checks: { name: string; conclusion: string | null; status?: string }[];
  repo?: string;
}) {
  const repo = o.repo ?? "acme/widgets";
  return {
    data: {
      repository: {
        pullRequest: {
          number: o.number,
          title: `Pull request ${o.number}`,
          url: `https://github.com/${repo}/pull/${o.number}`,
          state: o.state ?? "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefName: "feature/x",
          headRefOid: o.headSha,
          createdAt: "2026-03-04T08:00:00Z",
          updatedAt: "2026-03-04T09:00:00Z",
          mergedAt: null,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: "SUCCESS",
                    contexts: {
                      nodes: o.checks.map((c) => ({
                        __typename: "CheckRun",
                        name: c.name,
                        status: c.status ?? "COMPLETED",
                        conclusion: c.conclusion,
                      })),
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

export interface FakeLabel {
  id: string;
  name: string;
  isGroup: boolean;
  /** null for a workspace label. */
  teamId: string | null;
  parentId: string | null;
}

export const DEMO_TEAM = { id: "team-demo", key: "DEMO" };

/**
 * A Linear that answers the label query and the label mutation from an
 * in-memory list, so label tests never touch a real workspace.
 */
export function fakeLinearLabels(labels: FakeLabel[] = []) {
  const created: Record<string, unknown>[] = [];
  const fetch: Fetch = async (url, init) => {
    if (url !== LINEAR_ENDPOINT) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const vars = body.variables as {
      root?: string;
      filter?: { or: { name: { eqIgnoreCase: string } }[] };
      input?: { name: string; teamId?: string; parentId?: string; isGroup?: boolean };
    };
    if (/mutation CreateLabel/.test(body.query) && vars.input) {
      const input = vars.input;
      created.push(input);
      const id = `label-${labels.length + 1}`;
      labels.push({
        id,
        name: input.name,
        isGroup: Boolean(input.isGroup),
        teamId: input.teamId ?? null,
        parentId: input.parentId ?? null,
      });
      return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: { id } } } });
    }
    if (/query Labels/.test(body.query)) {
      const names = (vars.filter?.or ?? []).map((o) => o.name.eqIgnoreCase.toLowerCase());
      const nodes = labels
        .filter((l) => names.includes(l.name.toLowerCase()))
        .map((l) => ({
          id: l.id,
          name: l.name,
          isGroup: l.isGroup,
          team: l.teamId ? { id: l.teamId } : null,
          children: { nodes: labels.filter((c) => c.parentId === l.id).map((c) => ({ name: c.name })) },
        }));
      const issue = vars.root?.startsWith("DEMO-") ? { team: DEMO_TEAM } : null;
      return Response.json({ data: { issue, issueLabels: { nodes } } });
    }
    throw new Error("unexpected Linear request");
  };
  return { fetch, labels, created };
}
