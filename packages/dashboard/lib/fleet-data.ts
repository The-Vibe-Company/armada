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
  type ArmadaConfig,
  buildOverview,
  buildStatus,
  type FleetOverview,
  type InboxItem,
  LAUNCH_WINDOW_MS,
  type LatestEvent,
  type PendingLaunch,
  type ProjectConfigReading,
  type ProjectReading,
  type ProjectRecord,
  type RuntimeHandle,
  type SourcesRefresh,
  type StatusReport,
  type StatusSources,
} from "@armada/core/read";
import { type Database, redactDatabase } from "./db";
import type { LiveStore } from "./fleet-store";
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
}

export const newCache = (): FleetCache => ({ snapshots: memorySnapshots(), projects: null });

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

export interface LoadOptions {
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
  events: Record<string, LatestEvent>;
  handles: RuntimeHandle[];
  launches: PendingLaunch[];
  inbox: InboxItem[];
  coordinatorSeenAt: string | null;
}

async function readLive(store: LiveStore, project: string, now: Date): Promise<LiveProject> {
  const [events, handles, launches, inbox, coordinatorSeenAt] = await Promise.all([
    store.latestEvents(project, { since: new Date(now.getTime() - LIVE_WINDOW_MS) }),
    store.openRuntimeHandles(project),
    store.pendingLaunches(project, new Date(now.getTime() - LAUNCH_WINDOW_MS)),
    store.openInboxItems({ project, recipient: "coordinator" }),
    store.lastCoordinatorSeen(project),
  ]);
  return { events, handles, launches, inbox, coordinatorSeenAt };
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
  const opened = await openLive(opts, scope);
  const projects = projectsOf(opts, scope);
  // Registry projects are keyed by slug; a repository-only project by the slug its armada.toml gives.
  const candidates = [...projects.filter((p) => p.slug === slug), ...projects.filter((p) => !p.slug)];
  const { entries } = await readEntries(opened, opts, candidates.map(keyOf));
  for (const p of candidates) {
    const snap = entries.get(keyOf(p))?.snapshot;
    if (!snap || snap.config.project.slug !== slug) continue;
    const { store } = opened;
    const l = store
      ? await withTimeout(readLive(store, slug, opts.now()), opts.liveTimeoutMs ?? 4000, "reading live data").catch(
          () => null,
        )
      : null;
    return { store: l ? store : null, config: snap.config, report: statusOf(snap, l, opts.now()) };
  }
  return null;
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
    snap && (!p.slug || p.slug === snap.config.project.slug) ? snap.config.project.slug : null;

  // Live data for every project, or for none: the database failing midway must
  // not show some rows live under the "unreachable" banner.
  let liveData = new Map<string, LiveProject>();
  if (store && !read.failed) {
    try {
      const slugs = entries.flatMap((e) => liveSlug(e.p, e.entry?.snapshot) ?? []);
      const rows = await withTimeout(
        Promise.all(slugs.map(async (slug) => [slug, await readLive(store, slug, opts.now())] as const)),
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
    const base = { slug: snap?.config.project.slug ?? p.slug ?? key, name: snap?.config.project.name ?? p.name ?? key };
    if (!snap) {
      // Never read yet: the first reading is under way, unless the last attempt failed.
      const error = entry?.error ?? null;
      return {
        ...base,
        repository: p.repository,
        report: null,
        error: error ?? (refreshing ? null : "not read"),
        reading: error === null && refreshing,
        live: null,
      };
    }
    const slug = liveSlug(p, snap);
    const l = slug ? (liveData.get(slug) ?? null) : null;
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
      live: l ? { inbox: l.inbox, coordinatorSeenAt: l.coordinatorSeenAt } : null,
      profiles: snap.config.conductor.profiles,
    };
  });

  return buildOverview({ projects: readings, live, now: opts.now() });
}
