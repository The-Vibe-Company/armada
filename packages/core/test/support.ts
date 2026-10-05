// Test support: a fake `fetch` that replays recorded Linear and GitHub
// responses (no network), a builder for normalized issues, a fake Linear
// writer, and a fake Armada API with the fleet's live data in memory.

import cliPackage from "../../cli/package.json" with { type: "json" };
import {
  type ArmadaIdentity,
  type ArmadaSignIn,
  armadaApi,
  CLI_LATEST_HEADER,
  CLI_MINIMUM_HEADER,
  CLI_VERSION_HEADER,
  type ServerCli,
} from "../src/armada-api.ts";
import { NPM_REGISTRY_URL } from "../src/brief.ts";
import { type ArmadaConfig, parseConfig } from "../src/config.ts";
import { type FleetCaller, fleetClient, parseProject, serveFleet } from "../src/fleet-api.ts";
import { GITHUB_GRAPHQL } from "../src/github.ts";
import { agentLabels, type Fetch, LINEAR_ENDPOINT, normalizeComment, parsePullRequestUrl } from "../src/linear.ts";
import type { LinearWriter, Ticket, TicketChange, TicketLabel, WorkflowState } from "../src/linear-write.ts";
import type { Fleet, FleetStore, ProjectInput } from "../src/live.ts";
import { type Comment, type Issue, LABEL_PHASES } from "../src/types.ts";
import githubPulls from "./fixtures/github-pulls.json";
import linearProgram from "./fixtures/linear-program.json";
import { memoryFleet } from "./memory-fleet.ts";

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
  overrides: { github?: unknown; linear?: (recorded: typeof linearProgram) => void; npm?: unknown } = {},
): { fetch: Fetch; calls: Call[] } {
  const recorded = structuredClone(linearProgram);
  overrides.linear?.(recorded);
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(recorded).map(([op, responses]) => [op, [...responses]]),
  );
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    // npm serves the CLI's own version, unless a test says otherwise.
    if (url === NPM_REGISTRY_URL)
      return Response.json(
        overrides.npm ?? {
          versions: {
            [cliPackage.version]: {
              dist: {
                tarball: `https://registry.npmjs.org/@the-vibe-company/armada/-/armada-${cliPackage.version}.tgz`,
              },
            },
          },
        },
      );
    if (
      url === `https://registry.npmjs.org/@the-vibe-company/armada/-/armada-${cliPackage.version}.tgz` &&
      init.method === "HEAD"
    )
      return new Response(null, { status: 200 });
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

// ------------------------------------------------------------------ the fleet behind a fake Armada

/** A clock that starts at NOW and moves only when something sleeps on it. */
export function fakeClock(start: Date = NOW) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

/**
 * Answers `POST fleet/<op>` the way the app does: registers the project the
 * request names, then runs `serveFleet` on `store` with `clock`.
 */
export async function answerFleet(
  store: FleetStore,
  clock: Pick<Clock, "now" | "sleep">,
  op: string,
  body: unknown,
  caller: FleetCaller & { project?: string },
  cliVersion: string | null = null,
): Promise<Response> {
  const b = (body ?? {}) as { project?: unknown; input?: unknown };
  const project = parseProject(b.project);
  if (!project)
    return Response.json({ error: "a fleet request names its project", next: "update the CLI" }, { status: 400 });
  if (caller.kind === "worker" && caller.project !== project.slug)
    return Response.json(
      { error: `this worker session is for the project ${caller.project}`, next: "the coordinator does it" },
      { status: 403 },
    );
  await store.ensureProject(project, clock.now());
  const answer = await serveFleet(
    store,
    { op, project, caller, input: b.input },
    { now: clock.now, cliVersion, appUrl: ARMADA_URL },
  );
  if (answer.status === 304) return new Response(null, { status: 304 });
  return Response.json(answer.body, { status: answer.status });
}

/** The project of the demo armada.toml, as every fleet request names it. */
export const DEMO_PROJECT: ProjectInput = {
  slug: "widgets",
  name: "Widgets",
  repository: "acme/widgets",
  programRoot: "DEMO-1",
};

export const projectInputOf = (config: ArmadaConfig): ProjectInput => ({
  slug: config.project.slug,
  name: config.project.name,
  repository: config.github.repository,
  programRoot: config.tracker.programRoot,
});

/**
 * The fleet's live data in memory, behind the fake Armada API: `store` to
 * look at, `fleet` the client a command gets (signed in for the whole
 * organization unless `caller` is a worker), `clock` the server's clock.
 */
export function tempFleet(
  o: {
    project?: ProjectInput;
    caller?: FleetCaller;
    clock?: Clock;
    store?: ReturnType<typeof memoryFleet>;
    /** Answers an operation in Armada's place: a response (a 503), a thrown error (the network), or null to let it through. */
    fail?: (op: string) => Response | Error | null;
  } = {},
) {
  const store = o.store ?? memoryFleet();
  const clock = o.clock ?? fakeClock();
  const project = o.project ?? DEMO_PROJECT;
  const calls: string[] = [];
  /** The HTTP status of each answer, in order: 304 for an unchanged inbox. */
  const statuses: number[] = [];
  const caller = o.caller ?? { kind: "organization" };
  const fetch: Fetch = async (url, init) => {
    const op = url.slice(`${ARMADA_URL}/api/cli/fleet/`.length);
    calls.push(op);
    const failure = o.fail?.(op) ?? null;
    if (failure instanceof Error) throw failure;
    if (failure) {
      statuses.push(failure.status);
      return failure;
    }
    const res = await answerFleet(store, clock, op, JSON.parse(String(init.body)), {
      ...caller,
      project: project.slug,
    });
    statuses.push(res.status);
    return res;
  };
  const signIn: ArmadaSignIn = { kind: "api-key", key: "armada_key_TEST" };
  const fleet: Fleet = fleetClient({ api: armadaApi({ url: ARMADA_URL, fetch }), signIn, project });
  return { store, fleet, clock, calls, statuses };
}

// ------------------------------------------------------------------ fake Linear writer

export const LABELS: TicketLabel[] = [
  ...LABEL_PHASES.map((name) => ({ id: `phase-${name}`, name, group: "Agent phase" })),
  { id: "rt-conductor", name: "Conductor", group: "Agent runtime" },
  { id: "rt-claude", name: "Claude Code", group: "Agent runtime" },
  { id: "rt-herdr", name: "Herdr", group: "Agent runtime" },
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
      labelsTruncated: false,
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

// ------------------------------------------------------------ a fake Armada API

export const ARMADA_URL = "https://armada.example.test";

/** A synthetic person in a synthetic organization, as whoami answers for a session. */
export const PERSON: ArmadaIdentity = {
  schemaVersion: 1,
  via: "session",
  user: { id: "user-1", name: "Ada Example", email: "ada@example.test" },
  organization: { id: "org-1", name: "Acme", slug: "acme", role: "owner" },
  apiKey: null,
  expiresAt: "2026-04-03T10:00:00.000Z",
};

export interface ArmadaCall {
  method: string;
  path: string;
  authorization: string | null;
  apiKey: string | null;
  /** The CLI version the call said it came from. */
  version: string | null;
  body: unknown;
}

/**
 * The organization's keys the fake Armada hands out on `POST credentials`.
 * `off` plays an Armada without a vault (503).
 */
export interface FakeVault {
  off?: boolean;
  linear: { apiKey: string; scope: "own" | "organization" } | null;
  /** The projects that keep their own Linear key (THE-859), by slug. */
  projects?: Record<string, string>;
  now: () => Date;
  warnings?: string[];
}

/**
 * Plays the Armada API of /api/cli: `polls` lists what each poll of the
 * device code answers: "approve", or an RFC 8628 error ("slow_down",
 * "access_denied", "expired_token"; "pending" stands for
 * "authorization_pending"). An approval issues `token`. `keys` are the valid API keys;
 * `accounts: false` plays a deployment still on the shared password. Launch
 * tokens and worker sessions are numbered canaries (`armada_launch_CANARY_1`,
 * `armada_worker_CANARY_1`); `end(ticket, why)` plays a revocation from the
 * dashboard. `secrets` holds the secrets for workers, per project ("" for the
 * organization's), as `secrets/*` sets and releases them.
 */
export function fakeArmada(
  o: {
    polls?: string[];
    token?: string;
    keys?: Record<string, string>;
    accounts?: boolean;
    vault?: FakeVault;
    /** The fleet's live data behind `fleet/*`; a fresh one by default. */
    store?: FleetStore;
    clock?: Clock;
    /** The CLIs this Armada serves, sent on every answer the way the app does; none by default (an older server). */
    cli?: ServerCli;
    /** Secrets for workers, by project slug ("" for the organization's), then name. */
    secrets?: Record<string, Record<string, string>>;
  } = {},
) {
  const store = o.store ?? memoryFleet();
  const clock = o.clock ?? fakeClock();
  const token = o.token ?? "session-token-1";
  const polls = [...(o.polls ?? ["pending", "approve"])];
  const sessions = new Set<string>();
  const keys = new Map(Object.entries(o.keys ?? {}));
  const calls: ArmadaCall[] = [];
  const launches = new Map<string, { project: string; ticket: string; used: boolean }>();
  const workers = new Map<
    string,
    { project: string; ticket: string; ended: string | null; createdAt: string; id: string }
  >();
  const secrets = new Map(Object.entries(o.secrets ?? {}).map(([p, v]) => [p, new Map(Object.entries(v))]));
  const end = (ticket: string, why: string) => {
    for (const w of workers.values()) if (w.ticket === ticket && !w.ended) w.ended = why;
  };
  const fetch: Fetch = async (url, init) => {
    const res = await answer(url, init);
    if (o.cli) {
      res.headers.set(CLI_MINIMUM_HEADER, o.cli.minimum);
      if (o.cli.latest) res.headers.set(CLI_LATEST_HEADER, o.cli.latest);
    }
    return res;
  };
  const answer: Fetch = async (url, init) => {
    if (!url.startsWith(`${ARMADA_URL}/api/cli/`)) throw new Error(`unexpected URL ${url}`);
    const headers = new Headers(init.headers);
    const call: ArmadaCall = {
      method: init.method ?? "GET",
      path: url.slice(`${ARMADA_URL}/api/cli/`.length),
      authorization: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
      version: headers.get(CLI_VERSION_HEADER),
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    if (o.accounts === false)
      return Response.json(
        { error: "this Armada has no accounts yet", next: "ask its owner to set up accounts" },
        { status: 503 },
      );
    const route = `${call.method} ${call.path}`;
    if (route === "POST device/code")
      return Response.json({
        device_code: "device-code-1",
        user_code: "WDJBMJHT",
        verification_uri: `${ARMADA_URL}/device`,
        verification_uri_complete: `${ARMADA_URL}/device?user_code=WDJBMJHT`,
        expires_in: 900,
        interval: 5,
      });
    if (route === "POST device/token") {
      const next = polls.shift() ?? "expired_token";
      const error = next === "pending" ? "authorization_pending" : next;
      if (next !== "approve") return Response.json({ error, error_description: error }, { status: 400 });
      sessions.add(token);
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 2592000, scope: "" });
    }
    const bearer = call.authorization?.replace(/^Bearer /, "") ?? null;
    const body = (call.body ?? {}) as Record<string, unknown>;
    const worker = bearer ? workers.get(bearer) : undefined;
    if (worker?.ended)
      return Response.json({ error: worker.ended, next: "report it to the coordinator" }, { status: 401 });
    const person = (bearer && sessions.has(bearer)) || (call.apiKey && keys.has(call.apiKey));
    if (call.method === "POST" && call.path.startsWith("fleet/")) {
      if (!person && !worker)
        return Response.json({ error: "not signed in to Armada", next: "armada login" }, { status: 401 });
      return answerFleet(
        store,
        clock,
        call.path.slice("fleet/".length),
        call.body,
        worker
          ? { kind: "worker", ticket: worker.ticket, project: worker.project, sessionId: worker.id }
          : { kind: "organization" },
        call.version,
      );
    }
    if (call.method === "POST" && call.path.startsWith("secrets/")) {
      if (!person && !worker)
        return Response.json({ error: "not signed in to Armada", next: "armada login" }, { status: 401 });
      const op = call.path.slice("secrets/".length);
      const slug = String((body.project as { slug?: string } | undefined)?.slug ?? "");
      if (worker && (op === "set" || op === "unset"))
        return Response.json(
          { error: "a worker session sets no secret", next: "the coordinator does it" },
          { status: 403 },
        );
      if (worker && slug !== worker.project)
        return Response.json(
          {
            error: `this worker session is for the project ${worker.project}, not ${slug}`,
            next: "the coordinator does it",
          },
          { status: 403 },
        );
      const scoped = (p: string) => {
        const m = secrets.get(p) ?? new Map<string, string>();
        secrets.set(p, m);
        return m;
      };
      const effective = new Map([...scoped(""), ...scoped(slug)]);
      if (op === "list")
        return Response.json({
          schemaVersion: 1,
          project: slug,
          secrets: [
            ...[...scoped(slug).keys()].map((name) => ({ name, scope: "project", overridden: false })),
            ...[...scoped("").keys()].map((name) => ({
              name,
              scope: "organization",
              overridden: scoped(slug).has(name),
            })),
          ]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((x) => ({ ...x, setBy: "Ada Example", setAt: "2026-03-05T10:00:00.000Z" })),
        });
      if (op === "release") {
        const names = Array.isArray(body.names) ? (body.names as string[]) : null;
        const picked = [...effective]
          .filter(([n]) => !names || names.includes(n))
          .sort(([a], [b]) => a.localeCompare(b));
        return Response.json({
          schemaVersion: 1,
          project: slug,
          secrets: picked.map(([name, value]) => ({
            name,
            value,
            scope: scoped(slug).has(name) ? "project" : "organization",
          })),
          missing: (names ?? []).filter((n) => !effective.has(n)),
          warnings: [],
        });
      }
      const where = scoped(body.scope === "organization" ? "" : slug);
      if (op === "set") where.set(String(body.name), String(body.value));
      const deleted = op === "unset" ? where.delete(String(body.name)) : false;
      return Response.json({ schemaVersion: 1, name: body.name, scope: body.scope, project: slug, deleted });
    }
    if (route === "GET projects") {
      if (!person) return Response.json({ error: "not signed in to Armada", next: "armada login" }, { status: 401 });
      const own = o.vault?.projects ?? {};
      return Response.json({
        projects: (await store.listProjects()).map((p) => ({ ...p, ownLinearKey: p.slug in own })),
      });
    }
    if (route === "POST launch-tokens") {
      if (!person) return Response.json({ error: "not signed in to Armada", next: "armada login" }, { status: 401 });
      if (o.vault?.off || !o.vault)
        return Response.json({ error: "this Armada keeps no keys", next: "armada auth login" }, { status: 503 });
      const t = `armada_launch_CANARY_${launches.size + 1}`;
      launches.set(t, { project: String(body.project), ticket: String(body.ticket), used: false });
      return Response.json({
        schemaVersion: 1,
        token: t,
        expiresAt: new Date(o.vault.now().getTime() + 3_600_000).toISOString(),
        worker: { id: `wk-${launches.size}`, project: body.project, ticket: body.ticket },
        organization: { id: "org-1", name: "Acme", slug: "acme" },
      });
    }
    if (route === "POST launch-tokens/exchange") {
      const launch = launches.get(String(body.token));
      if (!launch || launch.used)
        return Response.json(
          {
            error: launch ? "this launch token was already used" : "this launch token is not valid",
            next: "a new launch",
          },
          { status: 401 },
        );
      launch.used = true;
      const t = `armada_worker_CANARY_${workers.size + 1}`;
      workers.set(t, {
        project: launch.project,
        ticket: launch.ticket,
        ended: null,
        createdAt: clock.now().toISOString(),
        id: `wk-${workers.size + 1}`,
      });
      return Response.json({
        schemaVersion: 1,
        token: t,
        worker: { id: `wk-${workers.size}`, project: launch.project, ticket: launch.ticket, launchedBy: "Ada Example" },
        organization: { id: "org-1", name: "Acme", slug: "acme" },
        expiresAt: "2026-03-07T10:00:00.000Z",
      });
    }
    if (route === "POST workers/end") {
      if (!person) return Response.json({ error: "not signed in to Armada", next: "armada login" }, { status: 401 });
      let ended = 0;
      for (const w of workers.values()) {
        if (
          w.project !== body.project ||
          w.ticket !== body.ticket ||
          w.ended ||
          (typeof body.claimedAt === "string" && Date.parse(w.createdAt) > Date.parse(body.claimedAt))
        )
          continue;
        w.ended = `the ticket was ${String(body.reason)}`;
        ended++;
      }
      return Response.json({ ended });
    }
    if (worker && route === "GET session")
      return Response.json({
        ...PERSON,
        via: "worker",
        user: null,
        organization: { ...PERSON.organization, role: null },
        worker: { id: "wk-1", project: worker.project, ticket: worker.ticket, launchedBy: "Ada Example" },
      });
    if (worker && route === "DELETE session") {
      worker.ended = "the ticket was released";
      return Response.json({ signedOut: true });
    }
    if (worker && route === "POST credentials") {
      const p = body.purpose as { command?: string; project?: string; ticket?: string } | undefined;
      if (p?.ticket !== worker.ticket || p?.project !== worker.project)
        return Response.json(
          {
            error: `this worker session acts on ${worker.ticket} only, not ${p?.ticket}`,
            next: "the coordinator does it",
          },
          { status: 403 },
        );
    }
    if (route === "GET session") {
      if (call.apiKey && keys.has(call.apiKey))
        return Response.json({
          ...PERSON,
          via: "api-key",
          user: null,
          organization: { ...PERSON.organization, role: null },
          apiKey: { id: "key-1", name: keys.get(call.apiKey), start: call.apiKey.slice(0, 6) },
        });
      if (bearer && sessions.has(bearer)) return Response.json(PERSON);
      const error = call.apiKey
        ? "this Armada API key is not valid: it was revoked, or never existed"
        : "the Armada sign-in of this terminal has expired or was revoked";
      return Response.json({ error, next: "armada login" }, { status: 401 });
    }
    if (route === "POST credentials") {
      const v = o.vault;
      if (!v || v.off)
        return Response.json({ error: "this Armada keeps no keys", next: "armada auth login" }, { status: 503 });
      if (!person && !worker)
        return Response.json({ error: "not signed in to Armada", next: "armada login" }, { status: 401 });
      const project = (body.purpose as { project?: string } | undefined)?.project;
      const own = project ? v.projects?.[project] : undefined;
      return Response.json({
        schemaVersion: 1,
        organization: { id: "org-1", name: "Acme", slug: "acme" },
        linear: own ? { apiKey: own, scope: "project" } : v.linear,
        warnings: v.warnings ?? [],
      });
    }
    if (route === "DELETE session") {
      if (bearer) sessions.delete(bearer);
      return Response.json({ signedOut: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { fetch, calls, sessions, keys, launches, workers, end, store, clock, secrets };
}
