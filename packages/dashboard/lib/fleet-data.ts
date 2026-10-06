// The dashboard's reading of the fleet (THE-853: instant and cheap). A page
// or a poll reads Postgres only: each project's last reading of Linear and
// GitHub (`snapshots.ts`) and the fleet's live data (a few SQL reads, next to
// the function: THE-849). It never waits for Linear or GitHub: a reading that
// is missing, older than the snapshot period or marked by a webhook is
// refreshed in the background (`after()`), and shows on a next poll. A
// refresh reads only what changed (Linear's changes since the last reading,
// GitHub's pull requests), and Linear whole every `fullMs` at most. Every
// poll rebuilds the overview through core, so a worker's report shows as
// soon as it is recorded. This module only orchestrates I/O; every fleet
// rule lives in core.
import {
  type ActivityEntry,
  type ArmadaConfig,
  type Attachment,
  agentActivity,
  buildInsights,
  buildOverview,
  buildStatus,
  CONFIG_DEFAULTS,
  type CoordinatorPresence,
  type FeedCursor,
  type FeedEntry,
  type FleetInsights,
  type FleetOverview,
  type HistoryEvent,
  type InboxItem,
  type InboxReadEvent,
  type InsightRange,
  isClosed,
  type Job,
  LAUNCH_WINDOW_MS,
  type LatestEvent,
  type OwnerValidation,
  type PendingLaunch,
  type ProjectConfigReading,
  type ProjectInsightRecords,
  type ProjectReading,
  type ProjectRecord,
  RANGE_DAYS,
  type RuntimeHandle,
  type SessionRecord,
  type SinceSummary,
  type SourcesRefresh,
  type StatusReport,
  type StatusSources,
  sinceSummary,
  TIMELINE_HOURS,
  VALIDATION_LIMITS,
  type Validation,
} from "@armada/core/read";
import { type ActivityShow, SHOWS } from "./activity-view";
import { LATEST_CLI_VERSION } from "./cli-version";
import { type Database, redactDatabase } from "./db";
import type { LiveStore } from "./fleet-store";
import { DONE_SEARCH_DAYS, indexOfReading, type SearchIndex } from "./search";
import {
  type ClaimOptions,
  dbSnapshots,
  type MemorySnapshots,
  memorySnapshots,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotHead,
  type SnapshotStore,
} from "./snapshots";

/** A project to show: a registry record, or only a repository when the registry could not be read. */
export type ProjectRef = Pick<ProjectRecord, "repository"> & Partial<Omit<ProjectRecord, "repository">>;

export interface Sources {
  /** The fleet's live data (the app's database); null when none is configured. Throws when it is unreachable. */
  live(): Promise<LiveStore | null>;
  /** The app's database, where the readings are kept; null when none is configured (they stay in memory). */
  database?(): Promise<Database | null>;
  /** Repositories to show when the registry cannot be read (ARMADA_REPOSITORIES). */
  fallbackProjects(): ProjectRef[];
  readConfig(p: ProjectRef): Promise<ProjectConfigReading>;
  /** Linear whole and GitHub's pull requests. */
  readSnapshot(config: ArmadaConfig): Promise<StatusSources>;
  /** Brings a reading up to date with what changed; without it every refresh reads whole. */
  readChanges?(config: ArmadaConfig, previous: StatusSources, ask: SourcesRefresh): Promise<StatusSources>;
}

/** Server memory kept between polls. One per server process. */
export interface FleetCache {
  /** The readings this process holds (the database's bodies, or the only copy without one). */
  snapshots: MemorySnapshots;
  /** The last project list read from the registry, used while the database is unreachable. */
  projects: ProjectRef[] | null;
  /** Each project's Insights records per range, kept `INSIGHTS_CACHE_MS` (THE-893). */
  insights: Map<string, { at: number; records: ProjectInsightRecords }>;
}

export const newCache = (): FleetCache => ({ snapshots: memorySnapshots(), projects: null, insights: new Map() });

/**
 * Whose fleet a request reads: the viewer's organization, and the deployment's
 * first organization, which owns every project registered without one. Null
 * under the shared-password gate (THE-834), which has no organizations: every
 * project is shown and none is assigned.
 */
export interface Scope {
  organization: string;
  /** Null until the first organization exists. */
  home: string | null;
}

/**
 * A project is shown to its organization's members only. One without an
 * organization (the registry could not assign it yet, or it only comes from
 * ARMADA_REPOSITORIES) belongs to the first organization.
 */
export const inScope = (p: ProjectRef, scope: Scope | null): boolean =>
  !scope ||
  (p.organization ? p.organization === scope.organization : scope.home !== null && scope.organization === scope.home);

/** Live events older than this are not read on each poll: they no longer change what a row shows. */
const LIVE_WINDOW_MS = 7 * 24 * 3_600_000;
/** The events of the timeline's history (each row's step): its longest span, and an hour before it for the gap that crosses its start. */
const HISTORY_MS = (TIMELINE_HOURS + 1) * 3_600_000;
/** How long an ended job stays beside its ticket (THE-1128). */
export const ENDED_JOBS_SHOWN_MS = 24 * 3_600_000;

export interface LoadOptions {
  /** Read snapshots only, without scheduling a refresh (owner delivery ticks). */
  refresh?: boolean;
  sources: Sources;
  cache: FleetCache;
  now: () => Date;
  /** How long a reading of Linear and GitHub stays fresh; a view after that refreshes it in the background. */
  snapshotMs: number;
  /** The same for a reading both webhooks marked within the last day: they keep it fresh. Default 10 minutes. */
  hookedSnapshotMs?: number;
  /** How often Linear is read whole rather than for its changes only. Default 30 minutes. */
  fullMs?: number;
  /** How long a refresh holds a project's lease. Default 2 minutes. */
  leaseMs?: number;
  /** Live reads slower than this count as unreachable. */
  liveTimeoutMs?: number;
  /** Keeps a background refresh alive after the response (Next's `after`); without it the refresh runs unawaited. */
  background?: (work: Promise<unknown>) => void;
}

/** A Linear or GitHub error, safe for the browser: a token in a URL is masked. */
const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/((?:auth)?token=)[^&\s"']+/gi, "$1***");

/**
 * Why the live data could not be read, for the browser: a time limit of ours,
 * else a generic reason. The driver's message (it may name the database host
 * or role) stays in the server log.
 */
function liveError(err: unknown): string {
  const detail = redactDatabase(err);
  console.error(`armada dashboard: live data unavailable: ${detail}`);
  return /took more than \d+(\.\d+)? s$/.test(detail) ? detail : "see the server log";
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const FULL_MS = 30 * 60_000;
const LEASE_MS = 2 * 60_000;
const HOOKED_SNAPSHOT_MS = 10 * 60_000;
/** A reading counts as kept fresh by a webhook that marked it within this. */
const HOOKED_WITHIN_MS = 24 * 3_600_000;
/** A reading a webhook marked is refreshed at most this often: a burst of deliveries (a CI run) makes one read. */
export const MARK_GAP_MS = 10_000;
/** Linear's changes are read from a little before the last read started: clocks differ. */
const OVERLAP_MS = 2 * 60_000;
/** Passes of one refresh when webhooks keep marking the project while it reads. */
const MAX_PASSES = 3;

/** The key a project's reading is kept under: its slug, else its repository. */
export const keyOf = (p: ProjectRef) => p.slug ?? p.repository;

/**
 * How long a reading stays fresh: the snapshot period, or a longer one when
 * both webhooks marked it within the last day, so they are known to reach it.
 */
function periodOf(
  head: SnapshotHead | undefined,
  opts: Pick<LoadOptions, "snapshotMs" | "hookedSnapshotMs">,
  now: number,
) {
  const recent = (d: Date | null | undefined) => !!d && now - d.getTime() < HOOKED_WITHIN_MS;
  return head && recent(head.hooks.linear) && recent(head.hooks.github)
    ? Math.max(opts.snapshotMs, opts.hookedSnapshotMs ?? HOOKED_SNAPSHOT_MS)
    : opts.snapshotMs;
}

/**
 * Refreshes one project's reading, unless another refresh holds it: Linear
 * whole when there is no reading, it is `fullMs` old, a webhook asked or the
 * program root changed; otherwise Linear's changes since the last read (when
 * a webhook said Linear changed, or the reading is stale) and GitHub's pull
 * requests and armada.toml (when a webhook said GitHub changed, or it is
 * stale). A failure keeps the previous reading and records why; the
 * webhooks' marks stay for the next refresh. Never throws.
 */
export async function refreshProject(
  p: ProjectRef,
  store: SnapshotStore,
  opts: Pick<LoadOptions, "sources" | "now" | "snapshotMs" | "hookedSnapshotMs" | "fullMs" | "leaseMs">,
  /** When the first pass has nothing to do (see `ClaimOptions`). */
  first: ClaimOptions = {},
): Promise<void> {
  const key = keyOf(p);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const claim = await store
      // A later pass keeps the burst gap: marks arriving faster than it wait for the next view or delivery.
      .claim(key, opts.now(), opts.leaseMs ?? LEASE_MS, pass === 0 ? first : { gapMs: first.gapMs })
      .catch((err: unknown) => {
        console.error(`armada dashboard: ${key}: refresh not started: ${redactDatabase(err)}`);
        return null;
      });
    if (!claim) return;
    const started = opts.now();
    const prev = claim.entry.snapshot;
    try {
      const fullAge = claim.entry.fullAt ? started.getTime() - claim.entry.fullAt.getTime() : Number.POSITIVE_INFINITY;
      const stale =
        !claim.entry.readAt ||
        started.getTime() - claim.entry.readAt.getTime() >= periodOf(claim.entry, opts, started.getTime());
      let full = !prev || claim.full || fullAge >= (opts.fullMs ?? FULL_MS) || !opts.sources.readChanges;
      const github = stale || claim.forge;
      const reading = full || github ? await opts.sources.readConfig(p) : null;
      const config = reading?.config ?? (prev as Snapshot).config;
      // armada.toml now names another program: its reading starts over.
      if (prev && config.tracker.programRoot !== prev.config.tracker.programRoot) full = true;
      const sources =
        full || !prev || !opts.sources.readChanges
          ? await opts.sources.readSnapshot(config)
          : await opts.sources.readChanges(config, prev.sources, {
              linearSince:
                stale || claim.linear || claim.touched.length
                  ? new Date(prev.startedAt.getTime() - OVERLAP_MS).toISOString()
                  : null,
              touched: claim.touched,
              forge: github,
            });
      const snapshot: Snapshot = {
        startedAt: started,
        config,
        configWarning: reading ? reading.warning : (prev?.configWarning ?? null),
        sources,
      };
      // Not saved: the lease ran out and another refresh took over; its reading stands.
      const { saved, dirty } = await store.save(key, snapshot, claim, { full, now: opts.now() });
      if (!saved || !dirty) return;
    } catch (err) {
      await store.fail(key, message(err), claim).catch((e: unknown) => {
        console.error(`armada dashboard: ${key}: refresh failure not recorded: ${redactDatabase(e)}`);
      });
      return;
    }
  }
}

/**
 * Starts a background refresh of a project when its reading is missing, older
 * than its period, or marked by a webhook (at most every `MARK_GAP_MS`), and
 * no refresh holds it. A failed refresh is not retried before the period
 * ends, so a Linear outage does not turn every poll into a read.
 */
function revalidate(p: ProjectRef, entry: SnapshotEntry | undefined, store: SnapshotStore, opts: LoadOptions): boolean {
  if (opts.refresh === false) return false;
  const now = opts.now().getTime();
  if (entry?.refreshingUntil && entry.refreshingUntil.getTime() > now) return true;
  const since = entry?.attemptedAt ? now - entry.attemptedAt.getTime() : Number.POSITIVE_INFINITY;
  const due = since >= periodOf(entry, opts, now) || (entry?.dirty === true && !entry.error && since >= MARK_GAP_MS);
  if (!due) return false;
  const work = refreshProject(p, store, opts, { seen: entry?.version ?? 0 });
  if (opts.background) opts.background(work);
  else void work;
  return true;
}

interface LiveProject {
  coordinator: CoordinatorPresence | null;
  inboxReads: InboxReadEvent[];
  sessions: SessionRecord[];
  events: Record<string, LatestEvent>;
  /** Every worker event of the timeline's span, oldest first. */
  history: HistoryEvent[];
  handles: RuntimeHandle[];
  launches: PendingLaunch[];
  /** The open long jobs, and those of the tickets in flight ended lately. */
  jobs: Job[];
  inbox: InboxItem[];
  coordinatorSeenAt: string | null;
  /** The CLI version the coordinator ran at its last inbox read; null when unknown. */
  coordinatorCliVersion: string | null;
  /** What the owner validates: the open ones and those decided in the last week, with their galleries. */
  validations: OwnerValidation[];
}

/** How long a decided validation stays on the Validations page. */
export const DECIDED_SHOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * The attachments a validation shows: those it names (of its own ticket, in
 * its order), else a small sample of its newest images, such as a pull request's
 * screenshots.
 */
export function galleryOf(
  v: Validation,
  attachments: readonly Attachment[],
  limit = VALIDATION_LIMITS.images,
): { gallery: Attachment[]; more: number } {
  const own = attachments.filter((a) => a.project === v.project && a.ticket === v.ticket);
  if (v.attachments.length) return { gallery: v.attachments.flatMap((id) => own.filter((a) => a.id === id)), more: 0 };
  const images = own
    .filter((a) => a.kind === "image")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  // Fallback images and explicit text excerpts share the same sample allowance.
  const cap = Math.min(limit, Math.max(VALIDATION_LIMITS.samples, limit) - (v.excerpts?.length ?? 0));
  return { gallery: images.slice(0, cap), more: Math.max(0, images.length - cap) };
}

async function readValidations(store: LiveStore, project: string, now: Date, limit: number) {
  const validations = await store.listValidations({
    project,
    decidedSince: new Date(now.getTime() - DECIDED_SHOWN_MS),
  });
  const attachments = await store.ticketsAttachments(project, [...new Set(validations.map((v) => v.ticket))]);
  return validations.map((v): OwnerValidation => {
    const { gallery, more } = galleryOf(v, attachments, limit);
    return { ...v, title: null, url: null, gallery, galleryMore: more };
  });
}

async function readLive(
  store: LiveStore,
  project: string,
  now: Date,
  tickets: readonly string[] = [],
  limit = VALIDATION_LIMITS.images,
): Promise<LiveProject> {
  const [events, history, handles, launches, jobs, inbox, coordinator, inboxReads, sessions, validations] =
    await Promise.all([
      Promise.all([
        store.latestEvents(project, { since: new Date(now.getTime() - LIVE_WINDOW_MS) }),
        tickets.length ? store.latestEvents(project, { since: new Date(0), tickets }) : Promise.resolve({}),
      ]).then(([recent, held]) => ({ ...recent, ...held })),
      store.recentEvents(project, new Date(now.getTime() - HISTORY_MS)),
      store.openRuntimeHandles(project),
      store.pendingLaunches(project, new Date(now.getTime() - LAUNCH_WINDOW_MS)),
      store.shownJobs(project, tickets, new Date(now.getTime() - ENDED_JOBS_SHOWN_MS)),
      store.openInboxItems({ project, recipient: "coordinator" }),
      store.getCoordinatorPresence(project),
      store.inboxReads(project, now),
      store.listSessions(project, { since: new Date(now.getTime() - LIVE_WINDOW_MS) }),
      readValidations(store, project, now, limit),
    ]);
  return {
    validations,
    events,
    history,
    handles,
    launches,
    jobs,
    inbox,
    coordinatorSeenAt: coordinator?.seenAt ?? null,
    coordinatorCliVersion: coordinator?.cliVersion ?? null,
    coordinator,
    inboxReads,
    sessions,
  };
}

/**
 * The registry, with every project that has no organization given to the
 * first one: the projects registered before accounts, and those a terminal
 * registers without an organization (THE-839).
 */
async function readRegistry(store: LiveStore, scope: Scope | null, now: Date): Promise<ProjectRef[]> {
  const projects = await store.listProjects();
  if (!scope?.home || projects.every((p) => p.organization)) return projects;
  await store.assignUnownedProjects(scope.home, now);
  return store.listProjects();
}

interface Opened {
  store: LiveStore | null;
  state: FleetOverview["live"];
  /** Where the readings are: the database's, or this process's memory without one. */
  snapshots: SnapshotStore;
}

async function openLive(opts: LoadOptions, scope: Scope | null): Promise<Opened> {
  const timeout = opts.liveTimeoutMs ?? 4000;
  const memory = opts.cache.snapshots;
  try {
    const store = await withTimeout(opts.sources.live(), timeout, "opening the database");
    if (!store) return { store: null, state: { state: "off", error: null }, snapshots: memory };
    const projects = await withTimeout(readRegistry(store, scope, opts.now()), timeout, "reading the project registry");
    opts.cache.projects = projects;
    const db = (await opts.sources.database?.()) ?? null;
    return { store, state: { state: "ok", error: null }, snapshots: db ? dbSnapshots(db, memory) : memory };
  } catch (err) {
    return { store: null, state: { state: "unreachable", error: liveError(err) }, snapshots: memory };
  }
}

/**
 * The readings of `keys`: the database's, else, when it fails, the last ones
 * this process holds; `failed` says why, for the banner.
 */
async function readEntries(
  opened: Opened,
  opts: LoadOptions,
  keys: string[],
): Promise<{ entries: Map<string, SnapshotEntry>; store: SnapshotStore; failed: string | null }> {
  try {
    const entries = await withTimeout(
      opened.snapshots.entries(keys),
      opts.liveTimeoutMs ?? 4000,
      "reading the projects' readings",
    );
    return { entries, store: opened.snapshots, failed: null };
  } catch (err) {
    const memory = opts.cache.snapshots;
    return { entries: await memory.entries(keys), store: memory, failed: liveError(err) };
  }
}

/** The project's status: the Linear and GitHub snapshot with the live events newer than it on top. */
function statusOf(snap: Snapshot, l: LiveProject | null, now: Date): StatusReport {
  return buildStatus({
    config: snap.config,
    ...snap.sources,
    ...(l
      ? {
          lastEvents: Object.fromEntries(Object.entries(l.events).map(([t, e]) => [t, e.at])),
          live: {
            after: snap.startedAt.toISOString(),
            events: l.events,
            handles: Object.fromEntries(l.handles.map((h) => [h.ticket, h])),
          },
          launches: l.launches,
          jobs: l.jobs,
        }
      : {}),
    now,
  });
}

/** One project as the Fleet view shows it, for a request to act on. */
export interface ProjectState {
  /** Null when the database is not configured or unreachable: requests cannot be written then. */
  store: LiveStore | null;
  config: ArmadaConfig;
  report: StatusReport;
}

/** The projects the scope may see: the registry, or ARMADA_REPOSITORIES while it was never read. */
const projectsOf = (opts: LoadOptions, scope: Scope | null) =>
  (opts.cache.projects ?? opts.sources.fallbackProjects()).filter((p) => inScope(p, scope));

/**
 * Reads one project the way `loadOverview` does (its last reading, live data
 * read now), so a request is checked against what the viewer sees, plus every
 * claim recorded since. Null when no such project is shown to the scope's
 * organization, or it has no reading yet.
 */
export async function loadProject(opts: LoadOptions, slug: string, scope: Scope | null): Promise<ProjectState | null> {
  const found = await readingOf(opts, slug, scope);
  if (!found) return null;
  const { store, snap } = found;
  const l = store
    ? await withTimeout(
        readLive(
          store,
          slug,
          opts.now(),
          snap.sources.program.issues.filter((i) => !isClosed(i)).map((i) => i.id),
          snap.config.policy.validationSamples,
        ),
        opts.liveTimeoutMs ?? 4000,
        "reading live data",
      ).catch(() => null)
    : null;
  return { store: l ? store : null, config: snap.config, report: statusOf(snap, l, opts.now()) };
}

/** The last reading of a project the scope may see, and the live data's store; null when there is none. */
async function readingOf(
  opts: LoadOptions,
  slug: string,
  scope: Scope | null,
): Promise<{ store: LiveStore | null; snap: Snapshot } | null> {
  const opened = await openLive(opts, scope);
  const projects = projectsOf(opts, scope);
  // Registry projects are keyed by slug; a repository-only project by the slug its armada.toml gives.
  const candidates = [...projects.filter((p) => p.slug === slug), ...projects.filter((p) => !p.slug)];
  const { entries } = await readEntries(opened, opts, candidates.map(keyOf));
  for (const p of candidates) {
    const snap = entries.get(keyOf(p))?.snapshot;
    if (snap && snap.config.project.slug === slug) return { store: opened.store, snap };
  }
  return null;
}

/** One ticket's history, as an agent's page shows it. */
export interface AgentActivity {
  project: string;
  ticket: string;
  /** False when the live data could not be read: the activity is Linear's and GitHub's only. */
  live: boolean;
  entries: ActivityEntry[];
}

/** An agent's activity and its tag, rendered with its page so nothing moves when it arrives (THE-892). */
export interface TaggedActivity {
  activity: AgentActivity;
  tag: string;
}

/**
 * What happened on one ticket (THE-869): its Linear comments and pull
 * requests from the project's last reading, its events, inbox items and
 * launches from the app's database. Never reads Linear or GitHub. Null when
 * the scope may not see the project, or it has no reading yet.
 */
export async function loadAgentActivity(
  opts: LoadOptions,
  scope: Scope | null,
  slug: string,
  ticket: string,
): Promise<AgentActivity | null> {
  const found = await readingOf(opts, slug, scope);
  if (!found) return null;
  const { store, snap } = found;
  const history = store
    ? await withTimeout(store.ticketHistory(slug, ticket), opts.liveTimeoutMs ?? 4000, "reading live data").catch(
        (err) => {
          liveError(err);
          return null;
        },
      )
    : null;
  const { program, forge } = snap.sources;
  const issue = program.issues.find((i) => i.id === ticket);
  const created = new Map((forge?.prs ?? []).map((p) => [p.number, p.createdAt ?? null]));
  const entries = agentActivity({
    comments: program.comments.filter((c) => c.issueId === ticket),
    events: history?.events ?? [],
    inbox: history?.inbox ?? [],
    launches: history?.launches ?? [],
    prs: (issue?.prs ?? []).map((p) => ({ number: p.number, createdAt: p.createdAt ?? created.get(p.number) ?? null })),
  });
  return { project: slug, ticket, live: history !== null, entries };
}

/** Reads every project of the scope's organization and builds the overview the Fleet view renders. */
export async function loadOverview(opts: LoadOptions, scope: Scope | null): Promise<FleetOverview> {
  const opened = await openLive(opts, scope);
  const { store } = opened;
  const projects = projectsOf(opts, scope);
  let live = opened.state;

  const read = await readEntries(opened, opts, projects.map(keyOf));
  if (read.failed) live = { state: "unreachable", error: read.failed };
  const entries = projects.map((p) => {
    const entry = read.entries.get(keyOf(p));
    return { p, key: keyOf(p), entry, refreshing: revalidate(p, entry, read.store, opts) };
  });
  // Live data is read by the slug armada.toml gives, but only when the
  // registry agrees: a repository naming another project's slug must not show
  // that project's inbox and events, which may belong to another organization.
  const liveSlug = (p: ProjectRef, snap: Snapshot | null | undefined) =>
    snap ? (!p.slug || p.slug === snap.config.project.slug ? snap.config.project.slug : null) : (p.slug ?? null);

  // Live data for every project, or for none: the database failing midway must
  // not show some rows live under the "unreachable" banner.
  let liveData = new Map<string, LiveProject>();
  if (store && !read.failed) {
    try {
      const slugs = entries.flatMap((e) => liveSlug(e.p, e.entry?.snapshot) ?? []);
      const rows = await withTimeout(
        Promise.all(
          slugs.map(async (slug) => {
            const snap = entries.find((e) => liveSlug(e.p, e.entry?.snapshot) === slug)?.entry?.snapshot;
            const tickets = snap?.sources.program.issues.filter((i) => !isClosed(i)).map((i) => i.id) ?? [];
            return [
              slug,
              await readLive(store, slug, opts.now(), tickets, snap?.config.policy.validationSamples),
            ] as const;
          }),
        ),
        opts.liveTimeoutMs ?? 4000,
        "reading live data",
      );
      liveData = new Map(rows);
    } catch (err) {
      live = { state: "unreachable", error: liveError(err) };
    }
  }

  const readings = entries.map(({ p, key, entry, refreshing }): ProjectReading => {
    const snap = entry?.snapshot;
    const base = {
      slug: snap?.config.project.slug ?? p.slug ?? key,
      name: snap?.config.project.name ?? p.name ?? key,
      owner: p.owner ?? null,
    };
    const slug = liveSlug(p, snap);
    const l = slug ? (liveData.get(slug) ?? null) : null;
    if (!snap) {
      // Never read yet: the first reading is under way, unless the last attempt failed.
      const error = entry?.error ?? null;
      return {
        ...base,
        repository: p.repository,
        report: null,
        error: error ?? (refreshing ? null : "not read"),
        reading: error === null && refreshing,
        live: l,
      };
    }
    const warnings = [
      ...(snap.configWarning ? [snap.configWarning] : []),
      ...(entry?.error ? [`Linear or GitHub could not be read again (${entry.error}); showing the last reading`] : []),
    ];
    return {
      ...base,
      repository: snap.config.github.repository,
      report: statusOf(snap, l, opts.now()),
      error: null,
      warnings,
      live: l
        ? {
            inbox: l.inbox,
            coordinatorSeenAt: l.coordinatorSeenAt,
            coordinatorCliVersion: l.coordinatorCliVersion,
            coordinator: l.coordinator,
            inboxReads: l.inboxReads,
            sessions: l.sessions,
            validations: l.validations.map((v) => {
              const issue = snap.sources.program.issues.find((i) => i.id === v.ticket);
              return { ...v, title: issue?.title ?? null, url: issue?.url ?? null };
            }),
          }
        : null,
      profiles: snap.config.conductor.profiles,
      history: { comments: snap.sources.program.comments, events: l?.history ?? [] },
    };
  });

  return buildOverview({ projects: readings, live, now: opts.now(), latestCli: LATEST_CLI_VERSION });
}

// ------------------------------------------------------------------ insights (THE-893)

/** How long a project's Insights records are kept in this process: the page and the overview's line share them. */
export const INSIGHTS_CACHE_MS = 60_000;

/** The Insights page's reading: the numbers of every project shown together, then of each. */
export interface InsightsReading {
  insights: FleetInsights;
  range: InsightRange;
  /** The project filter; null for every project. */
  project: string | null;
  projects: { slug: string; name: string }[];
  /** The same numbers for each project shown, in the registry's order, when asked (`perProject`: the page's "By project" table, THE-1021). */
  byProject: { slug: string; name: string; insights: FleetInsights }[];
  /** False when the live data could not be read: the numbers are empty, not zero. */
  live: boolean;
}

/**
 * The Insights of the scope's projects, or of one: Postgres only (each
 * project's records, kept a minute per range, and its last reading of Linear
 * for the titles and its silence threshold). Null when `project` is not one
 * the scope may see.
 */
export async function loadInsights(
  opts: LoadOptions,
  scope: Scope | null,
  q: { range: InsightRange; project: string | null; perProject?: boolean },
): Promise<InsightsReading | null> {
  const now = opts.now();
  const { store, shown } = await shownProjects(opts, scope);
  if (q.project !== null && !shown.some((p) => p.slug === q.project)) return null;
  const chosen = shown.filter((p) => q.project === null || p.slug === q.project);
  const since = new Date(now.getTime() - 2 * RANGE_DAYS[q.range] * 24 * 3_600_000);
  const cache = opts.cache.insights;
  let live = store !== null;
  const records: ProjectInsightRecords[] = [];
  if (store) {
    try {
      records.push(
        ...(await withTimeout(
          Promise.all(
            chosen.map(async (p) => {
              const silentAfterMinutes = p.snap?.config.policy.silentAfterMinutes ?? CONFIG_DEFAULTS.silentAfterMinutes;
              const key = `${p.slug}:${q.range}:${silentAfterMinutes}`;
              const held = cache.get(key);
              if (held && now.getTime() - held.at < INSIGHTS_CACHE_MS) return held.records;
              const r: ProjectInsightRecords = {
                project: p.slug,
                silentAfterMinutes,
                ...(await store.insightRecords(p.slug, since, silentAfterMinutes)),
              };
              cache.set(key, { at: now.getTime(), records: r });
              return r;
            }),
          ),
          opts.liveTimeoutMs ?? 4000,
          "reading the insights",
        )),
      );
    } catch (err) {
      liveError(err);
      live = false;
      records.length = 0;
    }
  }
  const insights = buildInsights({ records, range: q.range, now });
  // Each project's own numbers, for the page's table (THE-1021); the JSON summary needs none.
  const byProject = (q.perProject ? chosen : []).map((p) => ({
    slug: p.slug,
    name: p.name,
    insights: buildInsights({ records: records.filter((r) => r.project === p.slug), range: q.range, now }),
  }));
  return {
    insights,
    range: q.range,
    project: q.project,
    projects: shown.map((p) => ({ slug: p.slug, name: p.name })),
    byProject,
    live,
  };
}

// ------------------------------------------------------------------ since the owner last looked (THE-894)

/** The projects the scope sees, by the registry's slug, with their last reading of Linear when there is one. */
async function shownProjects(opts: LoadOptions, scope: Scope | null) {
  const opened = await openLive(opts, scope);
  const read = await readEntries(opened, opts, projectsOf(opts, scope).map(keyOf));
  const shown = projectsOf(opts, scope).flatMap((p) => {
    const snap = read.entries.get(keyOf(p))?.snapshot;
    // As the overview: live data is read by the registry's slug, never by one only armada.toml names.
    const slug = snap ? (!p.slug || p.slug === snap.config.project.slug ? snap.config.project.slug : null) : p.slug;
    return slug ? [{ slug, name: snap?.config.project.name ?? p.name ?? slug, snap: snap ?? null }] : [];
  });
  return { store: read.failed ? null : opened.store, shown };
}

/** How many entries a page of the Activity feed shows. */
export const FEED_PAGE = 100;

/** What the Activity page's address asks for: its chip, and where an older page starts. */
export interface ActivityQuery {
  show: ActivityShow;
  before: FeedCursor | null;
}

export interface ActivityReading {
  entries: FeedEntry[];
  /** Where the next, older page starts; null on the last one. */
  next: FeedCursor | null;
  projects: { slug: string; name: string }[];
  /** Each ticket's title from the project's last reading of Linear, by `<project>/<ticket>`. */
  titles: Record<string, string>;
  /** False when the live data could not be read: the feed is unknown, not empty. */
  live: boolean;
}

/** One page of the Activity feed of the scope's projects: Postgres only. */
export async function loadActivity(
  opts: LoadOptions,
  scope: Scope | null,
  q: ActivityQuery,
  limit = FEED_PAGE,
): Promise<ActivityReading> {
  const now = opts.now();
  const { store, shown } = await shownProjects(opts, scope);
  const reading: ActivityReading = {
    entries: [],
    next: null,
    projects: shown.map((p) => ({ slug: p.slug, name: p.name })),
    titles: {},
    live: store !== null,
  };
  if (!store) return reading;
  try {
    const entries = await withTimeout(
      store.feedPage({
        projects: shown.map((p) => p.slug),
        before: q.before,
        ...SHOWS[q.show],
        limit: limit + 1,
        now,
      }),
      opts.liveTimeoutMs ?? 4000,
      "reading the activity",
    );
    reading.entries = entries.slice(0, limit);
    const last = reading.entries.at(-1);
    reading.next = entries.length > limit && last ? { at: last.at, key: last.key } : null;
  } catch (err) {
    liveError(err);
    reading.live = false;
    return reading;
  }
  for (const p of shown) {
    const wanted = new Set(reading.entries.filter((e) => e.project === p.slug && e.ticket).map((e) => e.ticket));
    for (const i of p.snap?.sources.program.issues ?? [])
      if (wanted.has(i.id)) reading.titles[`${p.slug}/${i.id}`] = i.title;
  }
  return reading;
}

/**
 * What happened in the scope's projects since `since`, for the overview's
 * "since you were away": from the end of their previous visit to when they
 * came back. Postgres only. Null when the live data cannot be read.
 */
export async function loadCatchup(
  opts: LoadOptions,
  scope: Scope | null,
  window: { since: Date; until: Date },
): Promise<SinceSummary | null> {
  const now = opts.now();
  const { store, shown } = await shownProjects(opts, scope);
  if (!store) return null;
  try {
    const records = await withTimeout(
      Promise.all(
        shown.map((p) =>
          store.catchupRecords(
            p.slug,
            window,
            p.snap?.config.policy.silentAfterMinutes ?? CONFIG_DEFAULTS.silentAfterMinutes,
            now,
          ),
        ),
      ),
      opts.liveTimeoutMs ?? 4000,
      "reading what happened",
    );
    return sinceSummary({ since: window.since.toISOString(), until: window.until.toISOString(), now, records });
  } catch (err) {
    liveError(err);
    return null;
  }
}

// ------------------------------------------------------------------ search (THE-895)

/**
 * ⌘K's search index for the scope's projects, what the polled overview does
 * not carry: every ticket of each project's last reading (done ones of the
 * last 30 days), the pull requests GitHub gave, and the captions of the
 * attachments of the last 30 days. Postgres only; without the live data, the
 * readings' part alone.
 */
export async function loadSearchIndex(opts: LoadOptions, scope: Scope | null): Promise<SearchIndex> {
  const now = opts.now();
  const { store, shown } = await shownProjects(opts, scope);
  const index: SearchIndex = { tickets: [], prs: [], attachments: [] };
  for (const { slug, snap } of shown) {
    if (!snap) continue;
    const part = indexOfReading(slug, snap.sources, now);
    index.tickets.push(...part.tickets);
    index.prs.push(...part.prs);
  }
  if (store) {
    const since = new Date(now.getTime() - DONE_SEARCH_DAYS * 24 * 3_600_000);
    try {
      const found = await withTimeout(
        Promise.all(shown.map(({ slug }) => store.captionedAttachments(slug, since))),
        opts.liveTimeoutMs ?? 4000,
        "reading the attachments",
      );
      for (const a of found.flat())
        if (a.caption)
          index.attachments.push({
            project: a.project,
            id: a.id,
            ticket: a.ticket,
            caption: a.caption,
            kind: a.kind,
            url: a.url,
            createdAt: a.createdAt,
          });
    } catch (err) {
      liveError(err);
    }
  }
  return index;
}
