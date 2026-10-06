// `armada status`: one JSON-serializable reading of the fleet, shared by the
// CLI and, later, the dashboard.
import { type ArmadaConfig, CONFIG_DEFAULTS } from "./config.ts";
import {
  freshEvent,
  frontier,
  inFlight,
  type LaneFlag,
  type LaneOptions,
  mainHealth,
  waitingPullRequests,
} from "./fleet.ts";
import { attachPullRequests, fetchForge } from "./github.ts";
import { herdrHarnessLabel } from "./herdr-profile.ts";
import type { HttpRetryOptions } from "./http.ts";
import { type Job, type JobSummary, jobOverdue } from "./jobs.ts";
import { type Fetch, fetchProgram, fetchProgramChanges } from "./linear.ts";
import {
  followedLaunches,
  freshRuntimeState,
  type LatestEvent,
  notStartedBody,
  notStartedLaunches,
  type PendingLaunch,
  type RuntimeHandle,
  type RuntimeState,
} from "./live.ts";
import { buildModel, isDone, type Model } from "./model.ts";
import { describeRoute, routeProfile } from "./routing.ts";
import type { AgentPhase, CiState, ForgeData, MainHealth, ProgramData, PullRequest, ShippingStage } from "./types.ts";

export const STATUS_SCHEMA_VERSION = 1;

export interface TicketRef {
  id: string;
  title: string;
  url: string;
  spec: string | null;
}

/** A ticket out of flight whose pull request merged, with when (THE-988). */
export interface MergedTicket extends TicketRef {
  mergedAt: string;
  pr: { number: number; url: string };
}

/** How many merged tickets a report keeps: the board's Merged column. */
export const MERGED_SHOWN = 10;

export interface PrRef {
  files?: PullRequest["files"];
  additions?: number | null;
  deletions?: number | null;
  filesComplete?: boolean;
  checksComplete?: boolean;
  mergeability?: PullRequest["mergeability"];
  failingChecks?: string[];
  number: number;
  url: string;
  title: string;
  draft: boolean | null;
  /** null when the forge was not read. */
  ci: CiState | null;
  mergeable: string | null;
  /** When the pull request opened; null when the forge did not say. */
  createdAt?: string | null;
}

export interface InFlightTicket extends TicketRef {
  phase: AgentPhase;
  shippingStage?: ShippingStage | null;
  phaseSource: "label" | "status-line" | "inferred" | "live";
  runtime: string | null;
  /** The worker's runtime session (workspace/session id), when known. */
  handle: string | null;
  /** The Conductor profile its claim named (live runtime handle, else the claim comment); null when none. */
  profile: string | null;
  profileReason?: string | null;
  /** Selected local harness, explicitly naming its fallback when applicable. */
  harness?: string;
  agent: string | null;
  since: string;
  lastUpdate: string;
  /** Latest report by the worker (live event, status comment or claim); null if it never reported. */
  lastReport: string | null;
  runtimeState?: RuntimeState | null;
  lastHeartbeat?: string | null;
  silent: boolean;
  /** `plan`: the comment at `url` carries the worker's full plan. */
  statusLine: { summary: string; at: string; url: string; plan: boolean } | null;
  pr: PrRef | null;
  openBlockers: string[];
  flags: LaneFlag[];
}

export interface FrontierTicket extends TicketRef {
  readyForAgent: boolean;
  onCriticalPath: boolean;
  unlocks: string[];
  /** The profile `[[conductor.routing]]` gives it from its labels, and why; null when armada.toml declares none. */
  route: { profile: string; why: string } | null;
  /** Its labels, without the ready label. */
  labels: string[];
}

export interface WaitingPullRequest extends PrRef {
  headSha: string | null;
  updatedAt: string | null;
  failingChecks: string[];
  /** The head branch; null when GitHub did not give it. */
  branch: string | null;
  ticket: { id: string; phase: AgentPhase | null; shippingStage?: ShippingStage | null } | null;
}

/** A worker launched on a ticket that has not claimed it after `policy.not_started_minutes`. */
export interface NotStartedLaunch extends PendingLaunch {
  /** The ticket's title and link, when the program holds it. */
  title: string | null;
  url: string | null;
  /** Why it shows, and what to do (the inbox entry's text). */
  detail: string;
}

export interface StatusReport {
  /** Open long jobs from Armada; absent when their optional live read was unavailable. */
  jobs?: JobSummary[];
  /** Default-branch CI; absent in older reports, null when unavailable. */
  main?: MainHealth | null;
  progress?: { done: number; total: number };
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  generatedAt: string;
  project: { name: string; slug: string; repository: string };
  programRoot: { id: string; title: string; url: string };
  sources: {
    linear: { fetchedAt: string };
    github: { fetchedAt: string | null; error: string | null };
  };
  silentAfterMinutes: number;
  /** `policy.coordinator_minutes`: an inbox item open longer than this waits for the coordinator. */
  coordinatorMinutes: number;
  inFlight: InFlightTicket[];
  /** Workers launched that have not claimed their ticket; empty when Armada's live data was not read. */
  notStarted: NotStartedLaunch[];
  pendingLaunches?: PendingLaunch[];
  /**
   * Ready to start: the frontier, ranked, without the tickets parked on purpose.
   * `readyForAgent` marks tickets that carry the ready label.
   */
  frontier: FrontierTicket[];
  /** Open pull requests of the repository; null when GitHub could not be read. */
  pullRequests: WaitingPullRequest[] | null;
  /** The last tickets merged (THE-988), newest first; absent from a report built before it existed. */
  merged?: MergedTicket[];
  /** Reads cut short by a cap; the lists above may be incomplete where these say. */
  warnings: string[];
}

export interface BuildStatusInput {
  jobs?: Job[];
  config: ArmadaConfig;
  program: ProgramData;
  forge: ForgeData | null;
  forgeError?: string | null;
  /** Newest live event per ticket id; absent when the live data was not read. */
  lastEvents?: Record<string, string>;
  heartbeats?: Record<string, string>;
  /** Live events newer than the tracker read, and open runtime handles (the dashboard's live layer). */
  live?: LaneOptions["live"];
  /** Launches no claim followed, from Armada's live data. */
  launches?: PendingLaunch[];
  /** Problems met on optional sources (the live data), added to the report warnings. */
  extraWarnings?: string[];
  now: Date;
}

function routeOf(config: ArmadaConfig, labels: string[]): FrontierTicket["route"] {
  const route = routeProfile(config, labels);
  return route ? { profile: route.name, why: describeRoute(route, config) } : null;
}

export function buildStatus({
  config,
  program,
  forge,
  forgeError = null,
  lastEvents,
  heartbeats,
  live,
  jobs,
  launches = [],
  extraWarnings = [],
  now,
}: BuildStatusInput): StatusReport {
  const issues = attachPullRequests(program, forge);
  const m = buildModel(issues, program.rootId);
  const lanes = inFlight(m, program.comments, {
    now: now.getTime(),
    silentAfterMinutes: config.policy.silentAfterMinutes,
    ...(lastEvents ? { lastEvents } : {}),
    ...(heartbeats ? { heartbeats } : {}),
    ...(live ? { live } : {}),
  });
  const stageOf = new Map(lanes.map((l) => [l.issue.id, l.shippingStage ?? null]));
  const phaseOf = new Map(lanes.map((l) => [l.issue.id, l.phase]));
  const prRef = (
    p: PullRequest & {
      number: number;
      url: string;
      title: string;
      draft?: boolean;
      ci?: CiState;
      mergeable?: string;
    },
  ): PrRef => ({
    files: p.files ?? null,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    filesComplete: p.filesComplete ?? false,
    checksComplete: p.checksComplete ?? false,
    mergeability: p.mergeability ?? "unknown",
    failingChecks: (p.checks ?? []).filter((check) => check.state === "failure").map((check) => check.name),
    number: p.number,
    url: p.url,
    title: p.title,
    draft: p.draft ?? null,
    ci: p.ci ?? null,
    mergeable: p.mergeable ?? null,
    createdAt: p.createdAt ?? null,
  });

  return {
    ...(jobs
      ? {
          jobs: jobs.map((job) => ({
            ...job,
            overdue: jobOverdue(job, config.jobs?.[job.name]?.maxHours, now),
            ticketDone: issues.some((i) => i.id === job.ticket && i.statusType === "completed"),
          })),
        }
      : {}),
    schemaVersion: STATUS_SCHEMA_VERSION,
    main: forge?.main ? mainHealth(forge.main, config.gates.requiredChecks, forge.mainComplete) : null,
    progress: {
      done: m.program.filter((ticket) => m.isLeaf(ticket) && isDone(ticket)).length,
      total: m.program.filter(m.isLeaf).length,
    },
    generatedAt: now.toISOString(),
    project: { name: config.project.name, slug: config.project.slug, repository: config.github.repository },
    programRoot: { id: m.root.id, title: m.root.title, url: m.root.url },
    sources: {
      linear: { fetchedAt: program.fetchedAt },
      github: { fetchedAt: forge?.fetchedAt ?? null, error: forge ? null : (forgeError ?? "not read") },
    },
    silentAfterMinutes: config.policy.silentAfterMinutes,
    coordinatorMinutes: config.policy.coordinatorMinutes,
    inFlight: lanes.map((l) => {
      const profileName = live?.handles?.[l.issue.id]?.profile ?? l.claim?.profile ?? null;
      const profile = profileName && l.runtime?.toLowerCase() === "herdr" ? config.herdr.profiles[profileName] : null;
      return {
        id: l.issue.id,
        title: l.issue.title,
        url: l.issue.url,
        spec: l.spec,
        phase: l.phase,
        shippingStage: l.shippingStage ?? null,
        phaseSource: l.phaseSource,
        runtime: l.runtime,
        handle: l.handle,
        profile: profileName,
        profileReason: l.claim?.profileReason ?? null,
        ...(profile ? { harness: herdrHarnessLabel(profile.harness) } : {}),
        agent: l.agent,
        since: l.since,
        lastUpdate: l.lastUpdate,
        lastReport: l.lastReport,
        lastHeartbeat: l.lastHeartbeat,
        runtimeState: freshRuntimeState(
          live?.handles?.[l.issue.id]?.runtimeState,
          now,
          config.policy.silentAfterMinutes,
          live?.handles?.[l.issue.id]?.claimedAt,
        ),
        silent: l.flags.includes("silent"),
        statusLine: l.statusLine
          ? { summary: l.statusLine.summary, at: l.statusLine.at, url: l.statusLine.url, plan: l.statusLine.plan }
          : null,
        pr: l.pr ? prRef(l.pr) : null,
        openBlockers: l.openBlockers,
        flags: l.flags,
      };
    }),
    pendingLaunches: followedLaunches(launches, now),
    notStarted: notStartedLaunches(launches, now, config.policy.notStartedMinutes).map((l) => {
      const issue = issues.find((i) => i.id === l.ticket);
      return { ...l, title: issue?.title ?? null, url: issue?.url ?? null, detail: notStartedBody(l, now) };
    }),
    // The dashboard keeps whole configs in its snapshots, so a body written
    // before this field existed has none: fall back rather than park nothing.
    frontier: frontier(m, {
      ready: config.tracker.readyLabel,
      parked: config.tracker.parkedLabel ?? CONFIG_DEFAULTS.parkedLabel,
    })
      .filter((c) => !phaseOf.has(c.issue.id))
      .map((c) => ({
        id: c.issue.id,
        title: c.issue.title,
        url: c.issue.url,
        spec: c.spec,
        readyForAgent: c.readyForAgent,
        onCriticalPath: c.onCriticalPath,
        unlocks: c.unlocksAll,
        route: routeOf(config, c.issue.labels),
        labels: c.issue.labels.filter((l) => l !== config.tracker.readyLabel),
      })),
    pullRequests: forge
      ? waitingPullRequests(m, forge.prs).map(({ pr, ticket }) => ({
          ...prRef(pr),
          headSha: pr.headSha ?? null,
          updatedAt: pr.updatedAt ?? null,
          failingChecks: (pr.checks ?? []).filter((c) => c.state === "failure").map((c) => c.name),
          branch: pr.headRef ?? null,
          ticket: ticket
            ? {
                id: ticket.id,
                phase: phaseOf.get(ticket.id) ?? ticket.agentPhase,
                shippingStage: stageOf.get(ticket.id) ?? null,
              }
            : null,
        }))
      : null,
    merged: mergedTickets(m, phaseOf, live),
    warnings: [...program.warnings, ...(forge?.warnings ?? []), ...extraWarnings],
  };
}

/**
 * The last `MERGED_SHOWN` tickets merged, newest first: Done leaves out of
 * flight with a pull request GitHub read as merged, at its merge time (else
 * when the ticket closed), and those Armada saw merged since the reading, at
 * that time. A Done ticket without a merged pull request is left out, and so
 * is one whose pull request GitHub's reading no longer holds (it keeps the 30
 * pull requests closed last, `github.ts`): a busy repository may list fewer.
 */
export function mergedTickets(
  m: Model,
  inFlight: ReadonlyMap<string, unknown>,
  live?: LaneOptions["live"],
): MergedTicket[] {
  const out: MergedTicket[] = [];
  for (const issue of m.program) {
    if (!m.isLeaf(issue) || inFlight.has(issue.id)) continue;
    const event = freshEvent(issue.id, { live });
    const fresh = event?.kind === "merge" ? event : null;
    const merged = issue.prs
      .filter((p) => p.state === "merged")
      .sort(byMergeTime)
      .at(-1);
    const pr = merged ?? (fresh ? issue.prs.at(-1) : undefined);
    if (!pr || !(isDone(issue) || fresh)) continue;
    const mergedAt = fresh?.at ?? merged?.mergedAt ?? issue.completedAt;
    if (!mergedAt) continue;
    const spec = m.specOf(issue.id);
    out.push({
      id: issue.id,
      title: issue.title,
      url: issue.url,
      spec: spec ? `Spec ${spec.ordinal}` : null,
      mergedAt,
      pr: { number: pr.number, url: pr.url },
    });
  }
  return out
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.id.localeCompare(a.id, "en", { numeric: true }))
    .slice(0, MERGED_SHOWN);
}

const byMergeTime = (a: PullRequest, b: PullRequest) =>
  (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || a.number - b.number;

export interface LoadStatusOptions extends HttpRetryOptions {
  jobs?: () => Promise<Job[]>;
  linearApiKey: string;
  /** Without a token the report still lists tickets; pull requests are null. */
  githubToken: string | null;
  /** Newest live event time per ticket, read by the caller through Armada when signed in. */
  lastEvents?: () => Promise<Record<string, string>>;
  latestEvents?: () => Promise<Record<string, LatestEvent>>;
  heartbeats?: () => Promise<Record<string, string>>;
  runtimeHandles?: () => Promise<RuntimeHandle[]>;
  /** Launches no claim followed, read by the caller through Armada when signed in. */
  launches?: () => Promise<PendingLaunch[]>;
  fetch?: Fetch;
  now?: () => Date;
}

export interface StatusSources {
  program: ProgramData;
  forge: ForgeData | null;
  /** Why GitHub was not read, when `forge` is null. */
  forgeError: string | null;
}

/** Reads the project's program from Linear and its pull requests from GitHub. A GitHub failure is kept, not thrown. */
export async function readStatusSources(
  config: ArmadaConfig,
  opts: Pick<LoadStatusOptions, "linearApiKey" | "githubToken" | "fetch" | "now" | "sleep" | "random" | "onRetry">,
): Promise<StatusSources> {
  const now = opts.now ?? (() => new Date());
  const programP = fetchProgram({
    apiKey: opts.linearApiKey,
    rootId: config.tracker.programRoot,
    labels: config.tracker.labels,
    ...opts,
    now,
  });
  const [program, forge] = await Promise.all([programP, readForge(config, opts, now)]);
  return { program, ...forge };
}

/** The repository's pull requests; a failure is kept as the reason, not thrown. */
function readForge(
  config: ArmadaConfig,
  opts: Pick<LoadStatusOptions, "githubToken" | "fetch">,
  now: () => Date,
): Promise<{ forge: ForgeData | null; forgeError: string | null }> {
  if (!opts.githubToken)
    return Promise.resolve({ forge: null, forgeError: "no GitHub token (set GITHUB_TOKEN or run gh auth login)" });
  return fetchForge({
    token: opts.githubToken,
    repository: config.github.repository,
    ...opts,
    now,
  }).then(
    (forge) => ({ forge, forgeError: null }),
    (err: unknown) => ({ forge: null, forgeError: err instanceof Error ? err.message : String(err) }),
  );
}

/** What a refresh of a reading reads again; what it leaves out is kept as read. */
export interface SourcesRefresh {
  /** Linear's changes since this instant (ISO, with some overlap); null keeps the program as read. */
  linearSince: string | null;
  /** Linear ids of tickets to read again whatever their update time (named by a webhook). */
  touched?: string[];
  /** The repository's pull requests, read again whole (one request). */
  forge: boolean;
}

/** Brings a reading up to date with a few requests: Linear's changes only, and GitHub's pull requests if asked. */
export async function refreshStatusSources(
  config: ArmadaConfig,
  previous: StatusSources,
  ask: SourcesRefresh,
  opts: Pick<LoadStatusOptions, "linearApiKey" | "githubToken" | "fetch" | "now" | "sleep" | "random" | "onRetry">,
): Promise<StatusSources> {
  const now = opts.now ?? (() => new Date());
  const programP =
    ask.linearSince === null
      ? Promise.resolve(previous.program)
      : fetchProgramChanges({
          apiKey: opts.linearApiKey,
          rootId: config.tracker.programRoot,
          labels: config.tracker.labels,
          previous: previous.program,
          since: ask.linearSince,
          ...(ask.touched ? { touched: ask.touched } : {}),
          ...opts,
          now,
        });
  const forgeP = ask.forge
    ? readForge(config, opts, now)
    : Promise.resolve({ forge: previous.forge, forgeError: previous.forgeError });
  const [program, forge] = await Promise.all([programP, forgeP]);
  return { program, ...forge };
}

/** Reads Linear and GitHub for the project in `config` and builds the report. */
export async function loadStatus(config: ArmadaConfig, opts: LoadStatusOptions): Promise<StatusReport> {
  const now = opts.now ?? (() => new Date());
  const eventsP: Promise<{ events?: Record<string, string>; warning?: string }> = opts.lastEvents
    ? opts.lastEvents().then(
        (events) => ({ events }),
        (err: unknown) => ({
          warning: `Armada's live data could not be read (${err instanceof Error ? err.message : String(err)}); silence is measured from Linear only`,
        }),
      )
    : Promise.resolve({});
  const launchesP: Promise<{ launches?: PendingLaunch[]; warning?: string }> = opts.launches
    ? opts.launches().then(
        (launches) => ({ launches }),
        (err: unknown) => ({
          warning: `Armada's launches could not be read (${err instanceof Error ? err.message : String(err)}); workers launched that never started are not listed`,
        }),
      )
    : Promise.resolve({});
  const jobsP: Promise<{ jobs?: Job[]; warning?: string }> = opts.jobs
    ? opts.jobs().then(
        (jobs) => ({ jobs }),
        (err) => ({ warning: `Armada's jobs could not be read (${err instanceof Error ? err.message : String(err)})` }),
      )
    : Promise.resolve({});
  const [{ program, forge, forgeError }, events, launches, heartbeats, runtimeHandles, latestEvents, jobs] =
    await Promise.all([
      readStatusSources(config, opts),
      eventsP,
      launchesP,
      opts.heartbeats?.().catch(() => undefined),
      opts.runtimeHandles?.().catch(() => undefined),
      opts.latestEvents?.().catch(() => undefined),
      jobsP,
    ]);
  return buildStatus({
    config,
    program,
    forge,
    forgeError,
    ...(events.events ? { lastEvents: events.events } : {}),
    ...(heartbeats ? { heartbeats } : {}),
    ...(runtimeHandles || latestEvents
      ? {
          live: {
            after: program.fetchedAt,
            events: latestEvents ?? {},
            handles: Object.fromEntries((runtimeHandles ?? []).map((h) => [h.ticket, h])),
          },
        }
      : {}),
    ...(launches.launches ? { launches: launches.launches } : {}),
    ...(jobs.jobs ? { jobs: jobs.jobs } : {}),
    extraWarnings: [events.warning, launches.warning, jobs.warning].filter((w): w is string => !!w),
    now: now(),
  });
}
