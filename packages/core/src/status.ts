// `armada status`: one JSON-serializable reading of the fleet, shared by the
// CLI and, later, the dashboard.
import type { ArmadaConfig } from "./config.ts";
import { frontier, inFlight, type LaneFlag, waitingPullRequests } from "./fleet.ts";
import { attachPullRequests, fetchForge } from "./github.ts";
import { type Fetch, fetchProgram } from "./linear.ts";
import { buildModel } from "./model.ts";
import type { AgentPhase, CiState, ForgeData, ProgramData } from "./types.ts";

export const STATUS_SCHEMA_VERSION = 1;

export interface TicketRef {
  id: string;
  title: string;
  url: string;
  spec: string | null;
}

export interface PrRef {
  number: number;
  url: string;
  title: string;
  draft: boolean | null;
  /** null when the forge was not read. */
  ci: CiState | null;
  mergeable: string | null;
}

export interface InFlightTicket extends TicketRef {
  phase: AgentPhase;
  phaseSource: "label" | "status-line" | "inferred";
  runtime: string | null;
  agent: string | null;
  since: string;
  lastUpdate: string;
  /** Latest report by the worker (Turso event, status comment or claim); null if it never reported. */
  lastReport: string | null;
  silent: boolean;
  statusLine: { summary: string; at: string; url: string } | null;
  pr: PrRef | null;
  openBlockers: string[];
  flags: LaneFlag[];
}

export interface FrontierTicket extends TicketRef {
  readyForAgent: boolean;
  onCriticalPath: boolean;
  unlocks: string[];
}

export interface WaitingPullRequest extends PrRef {
  headSha: string | null;
  updatedAt: string | null;
  failingChecks: string[];
  ticket: { id: string; phase: AgentPhase | null } | null;
}

export interface StatusReport {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  generatedAt: string;
  project: { name: string; slug: string; repository: string };
  programRoot: { id: string; title: string; url: string };
  sources: {
    linear: { fetchedAt: string };
    github: { fetchedAt: string | null; error: string | null };
  };
  silentAfterMinutes: number;
  inFlight: InFlightTicket[];
  /** Ready to start: the frontier, ranked. `readyForAgent` marks tickets that carry the ready label. */
  frontier: FrontierTicket[];
  /** Open pull requests of the repository; null when GitHub could not be read. */
  pullRequests: WaitingPullRequest[] | null;
  /** Reads cut short by a cap; the lists above may be incomplete where these say. */
  warnings: string[];
}

export interface BuildStatusInput {
  config: ArmadaConfig;
  program: ProgramData;
  forge: ForgeData | null;
  forgeError?: string | null;
  /** Newest Turso event per ticket id; absent when Turso was not read. */
  lastEvents?: Record<string, string>;
  /** Problems met on optional sources (Turso), added to the report warnings. */
  extraWarnings?: string[];
  now: Date;
}

export function buildStatus({
  config,
  program,
  forge,
  forgeError = null,
  lastEvents,
  extraWarnings = [],
  now,
}: BuildStatusInput): StatusReport {
  const issues = attachPullRequests(program, forge);
  const m = buildModel(issues, program.rootId);
  const lanes = inFlight(m, program.comments, {
    now: now.getTime(),
    silentAfterMinutes: config.policy.silentAfterMinutes,
    ...(lastEvents ? { lastEvents } : {}),
  });
  const phaseOf = new Map(lanes.map((l) => [l.issue.id, l.phase]));
  const prRef = (p: {
    number: number;
    url: string;
    title: string;
    draft?: boolean;
    ci?: CiState;
    mergeable?: string;
  }): PrRef => ({
    number: p.number,
    url: p.url,
    title: p.title,
    draft: p.draft ?? null,
    ci: p.ci ?? null,
    mergeable: p.mergeable ?? null,
  });

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    project: { name: config.project.name, slug: config.project.slug, repository: config.github.repository },
    programRoot: { id: m.root.id, title: m.root.title, url: m.root.url },
    sources: {
      linear: { fetchedAt: program.fetchedAt },
      github: { fetchedAt: forge?.fetchedAt ?? null, error: forge ? null : (forgeError ?? "not read") },
    },
    silentAfterMinutes: config.policy.silentAfterMinutes,
    inFlight: lanes.map((l) => ({
      id: l.issue.id,
      title: l.issue.title,
      url: l.issue.url,
      spec: l.spec,
      phase: l.phase,
      phaseSource: l.phaseSource,
      runtime: l.runtime,
      agent: l.agent,
      since: l.since,
      lastUpdate: l.lastUpdate,
      lastReport: l.lastReport,
      silent: l.flags.includes("silent"),
      statusLine: l.statusLine ? { summary: l.statusLine.summary, at: l.statusLine.at, url: l.statusLine.url } : null,
      pr: l.pr ? prRef(l.pr) : null,
      openBlockers: l.openBlockers,
      flags: l.flags,
    })),
    frontier: frontier(m, config.tracker.readyLabel).map((c) => ({
      id: c.issue.id,
      title: c.issue.title,
      url: c.issue.url,
      spec: c.spec,
      readyForAgent: c.readyForAgent,
      onCriticalPath: c.onCriticalPath,
      unlocks: c.unlocksAll,
    })),
    pullRequests: forge
      ? waitingPullRequests(m, forge.prs).map(({ pr, ticket }) => ({
          ...prRef(pr),
          headSha: pr.headSha ?? null,
          updatedAt: pr.updatedAt ?? null,
          failingChecks: (pr.checks ?? []).filter((c) => c.state === "failure").map((c) => c.name),
          ticket: ticket ? { id: ticket.id, phase: phaseOf.get(ticket.id) ?? ticket.agentPhase } : null,
        }))
      : null,
    warnings: [...program.warnings, ...(forge?.warnings ?? []), ...extraWarnings],
  };
}

export interface LoadStatusOptions {
  linearApiKey: string;
  /** Without a token the report still lists tickets; pull requests are null. */
  githubToken: string | null;
  /** Newest Turso event time per ticket, read by the caller when Turso is configured. */
  lastEvents?: () => Promise<Record<string, string>>;
  fetch?: Fetch;
  now?: () => Date;
}

/** Reads Linear and GitHub for the project in `config` and builds the report. */
export async function loadStatus(config: ArmadaConfig, opts: LoadStatusOptions): Promise<StatusReport> {
  const now = opts.now ?? (() => new Date());
  const programP = fetchProgram({
    apiKey: opts.linearApiKey,
    rootId: config.tracker.programRoot,
    labels: config.tracker.labels,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    now,
  });
  const forgeP: Promise<{ forge: ForgeData | null; error: string | null }> = opts.githubToken
    ? fetchForge({
        token: opts.githubToken,
        repository: config.github.repository,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        now,
      }).then(
        (forge) => ({ forge, error: null }),
        (err: unknown) => ({ forge: null, error: err instanceof Error ? err.message : String(err) }),
      )
    : Promise.resolve({ forge: null, error: "no GitHub token (set GITHUB_TOKEN or run gh auth login)" });
  const eventsP: Promise<{ events?: Record<string, string>; warning?: string }> = opts.lastEvents
    ? opts.lastEvents().then(
        (events) => ({ events }),
        (err: unknown) => ({
          warning: `Turso could not be read (${err instanceof Error ? err.message : String(err)}); silence is measured from Linear only`,
        }),
      )
    : Promise.resolve({});
  const [program, { forge, error }, events] = await Promise.all([programP, forgeP, eventsP]);
  return buildStatus({
    config,
    program,
    forge,
    forgeError: error,
    ...(events.events ? { lastEvents: events.events } : {}),
    extraWarnings: events.warning ? [events.warning] : [],
    now: now(),
  });
}
