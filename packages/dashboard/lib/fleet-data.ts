// The dashboard's reading of the fleet. Two speeds: Linear and GitHub are read
// at most once per snapshot period per project (they are slow and rate
// limited), Turso on every poll (a few SQL reads). Every poll rebuilds the
// overview through core, so a worker's report shows as soon as it lands in
// Turso. This module only orchestrates I/O; every fleet rule lives in core.
import {
  type ArmadaConfig,
  buildOverview,
  buildStatus,
  type Db,
  type FleetOverview,
  type InboxItem,
  lastCoordinatorSeen,
  latestEvents,
  listProjects,
  openInboxItems,
  openRuntimeHandles,
  type ProjectConfigReading,
  type ProjectReading,
  type ProjectRecord,
  redact,
  type StatusSources,
} from "@armada/core/read";

/** A project to show: a registry record, or only a repository when the registry could not be read. */
export type ProjectRef = Pick<ProjectRecord, "repository"> & Partial<Omit<ProjectRecord, "repository">>;

export interface Sources {
  /** The Turso database; null when none is configured. Throws when it is unreachable. */
  openLive(): Promise<Db | null>;
  /** Repositories to show when the registry cannot be read (ARMADA_REPOSITORIES). */
  fallbackProjects(): ProjectRef[];
  readConfig(p: ProjectRef): Promise<ProjectConfigReading>;
  readSnapshot(config: ArmadaConfig): Promise<StatusSources>;
}

interface Snapshot {
  /** When the read started: Turso events after this are newer than what it says. */
  startedAt: Date;
  config: ArmadaConfig;
  configWarning: string | null;
  sources: StatusSources;
}

interface Entry {
  snapshot: Snapshot | null;
  error: string | null;
  /** When the last read started, successful or not: reads are spaced by the snapshot period. */
  attemptedAt: number | null;
  refreshing: Promise<void> | null;
}

/** Server memory kept between polls. One per server process. */
export interface FleetCache {
  snapshots: Map<string, Entry>;
  /** The last project list read from the registry, used while Turso is unreachable. */
  projects: ProjectRef[] | null;
  db: Db | null;
  /** The client being opened, shared by concurrent requests. */
  opening: Promise<Db | null> | null;
}

export const newCache = (): FleetCache => ({ snapshots: new Map(), projects: null, db: null, opening: null });

/** Turso events older than this are not read on each poll: they no longer change what a row shows. */
const LIVE_WINDOW_MS = 7 * 24 * 3_600_000;

export interface LoadOptions {
  sources: Sources;
  cache: FleetCache;
  now: () => Date;
  /** How long a Linear and GitHub read stays fresh. */
  snapshotMs: number;
  /** Turso reads slower than this count as unreachable. */
  liveTimeoutMs?: number;
  /** Keeps a background refresh alive after the response (Next's `after`). */
  background?: (work: Promise<unknown>) => void;
}

/** An error message safe for the browser: a Turso URL's `authToken=` is masked. */
const message = (err: unknown) => redact(err);

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function readSnapshot(p: ProjectRef, opts: LoadOptions): Promise<Snapshot> {
  const startedAt = opts.now();
  const { config, warning } = await opts.sources.readConfig(p);
  return { startedAt, config, configWarning: warning, sources: await opts.sources.readSnapshot(config) };
}

/**
 * The project's snapshot: read it when there is none, serve it while fresh,
 * and refresh it in the background once stale. A failed read keeps the
 * previous snapshot, reports the error next to it and is not retried before
 * the next period, so a Linear outage does not turn every poll into a read.
 */
async function snapshotOf(p: ProjectRef, key: string, opts: LoadOptions): Promise<Entry> {
  const { snapshots } = opts.cache;
  let entry = snapshots.get(key);
  if (!entry) {
    entry = { snapshot: null, error: null, attemptedAt: null, refreshing: null };
    snapshots.set(key, entry);
  }
  const current = entry;
  const now = opts.now().getTime();
  const refresh = () => {
    if (!current.refreshing) {
      current.attemptedAt = now;
      current.refreshing = readSnapshot(p, opts)
        .then(
          (snapshot) => {
            current.snapshot = snapshot;
            current.error = null;
          },
          (err: unknown) => {
            current.error = message(err);
          },
        )
        .finally(() => {
          current.refreshing = null;
        });
    }
    return current.refreshing;
  };
  const due = current.attemptedAt === null || now - current.attemptedAt >= opts.snapshotMs;
  if (!current.snapshot) {
    if (due || current.refreshing) await refresh();
  } else if (due) opts.background?.(refresh());
  return current;
}

interface LiveProject {
  events: Awaited<ReturnType<typeof latestEvents>>;
  handles: Awaited<ReturnType<typeof openRuntimeHandles>>;
  inbox: InboxItem[];
  coordinatorSeenAt: string | null;
}

async function readLive(db: Db, project: string, now: Date): Promise<LiveProject> {
  const [events, handles, inbox, coordinatorSeenAt] = await Promise.all([
    latestEvents(db, project, { since: new Date(now.getTime() - LIVE_WINDOW_MS) }),
    openRuntimeHandles(db, project),
    openInboxItems(db, { project, recipient: "coordinator" }),
    lastCoordinatorSeen(db, project),
  ]);
  return { events, handles, inbox, coordinatorSeenAt };
}

function liveClient(opts: LoadOptions): Promise<Db | null> {
  if (opts.cache.db) return Promise.resolve(opts.cache.db);
  // One open at a time; a slow open still lands in the cache for the next poll.
  opts.cache.opening ??= opts.sources
    .openLive()
    .then((db) => {
      opts.cache.db = db;
      return db;
    })
    .finally(() => {
      opts.cache.opening = null;
    });
  return opts.cache.opening;
}

async function openLive(opts: LoadOptions): Promise<{ db: Db | null; state: FleetOverview["live"] }> {
  const timeout = opts.liveTimeoutMs ?? 4000;
  try {
    const db = await withTimeout(liveClient(opts), timeout, "opening Turso");
    if (!db) return { db: null, state: { state: "off", error: null } };
    const projects = await withTimeout(listProjects(db), timeout, "reading the project registry");
    opts.cache.projects = projects;
    return { db, state: { state: "ok", error: null } };
  } catch (err) {
    dropClient(opts);
    return { db: null, state: { state: "unreachable", error: message(err) } };
  }
}

/** Reopen on the next poll: the client may be stuck on a dead connection. */
function dropClient(opts: LoadOptions) {
  opts.cache.db?.close();
  opts.cache.db = null;
}

/** Reads every project and builds the overview the Fleet view renders. */
export async function loadOverview(opts: LoadOptions): Promise<FleetOverview> {
  const { db, state } = await openLive(opts);
  const projects = opts.cache.projects ?? opts.sources.fallbackProjects();
  let live = state;

  const entries = await Promise.all(
    projects.map(async (p) => {
      const key = p.slug ?? p.repository;
      return { p, key, entry: await snapshotOf(p, key, opts) };
    }),
  );

  // Live data for every project, or for none: Turso failing midway must not
  // show some rows live under the "unreachable" banner.
  let liveData = new Map<string, LiveProject>();
  if (db) {
    try {
      const slugs = entries.flatMap((e) => (e.entry.snapshot ? [e.entry.snapshot.config.project.slug] : []));
      const read = await withTimeout(
        Promise.all(slugs.map(async (slug) => [slug, await readLive(db, slug, opts.now())] as const)),
        opts.liveTimeoutMs ?? 4000,
        "reading Turso",
      );
      liveData = new Map(read);
    } catch (err) {
      dropClient(opts);
      live = { state: "unreachable", error: message(err) };
    }
  }

  const readings = entries.map(({ p, key, entry }): ProjectReading => {
    const snap = entry.snapshot;
    const base = { slug: snap?.config.project.slug ?? key, name: snap?.config.project.name ?? p.name ?? key };
    if (!snap) return { ...base, repository: p.repository, report: null, error: entry.error ?? "not read", live: null };
    const l = liveData.get(snap.config.project.slug) ?? null;
    const warnings = [
      ...(snap.configWarning ? [snap.configWarning] : []),
      ...(entry.error ? [`Linear or GitHub could not be read again (${entry.error}); showing the last reading`] : []),
    ];
    const report = buildStatus({
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
          }
        : {}),
      now: opts.now(),
    });
    return {
      ...base,
      repository: snap.config.github.repository,
      report,
      error: null,
      warnings,
      live: l ? { inbox: l.inbox, coordinatorSeenAt: l.coordinatorSeenAt } : null,
    };
  });

  return buildOverview({ projects: readings, live, now: opts.now() });
}
