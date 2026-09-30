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
  refreshing: Promise<void> | null;
}

/** Server memory kept between polls. One per server process. */
export interface FleetCache {
  snapshots: Map<string, Entry>;
  /** The last project list read from the registry, used while Turso is unreachable. */
  projects: ProjectRef[] | null;
  db: Db | null;
}

export const newCache = (): FleetCache => ({ snapshots: new Map(), projects: null, db: null });

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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
 * and refresh it in the background once stale. A failed refresh keeps the
 * previous snapshot and reports the error next to it.
 */
async function snapshotOf(p: ProjectRef, key: string, opts: LoadOptions): Promise<Entry> {
  const { snapshots } = opts.cache;
  let entry = snapshots.get(key);
  if (!entry) {
    entry = { snapshot: null, error: null, refreshing: null };
    snapshots.set(key, entry);
  }
  const current = entry;
  const refresh = () => {
    current.refreshing ??= readSnapshot(p, opts)
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
    return current.refreshing;
  };
  if (!current.snapshot) await refresh();
  else if (opts.now().getTime() - current.snapshot.startedAt.getTime() >= opts.snapshotMs) {
    const work = refresh();
    opts.background?.(work);
  }
  return current;
}

interface LiveProject {
  events: Awaited<ReturnType<typeof latestEvents>>;
  handles: Awaited<ReturnType<typeof openRuntimeHandles>>;
  inbox: InboxItem[];
  coordinatorSeenAt: string | null;
}

async function readLive(db: Db, project: string): Promise<LiveProject> {
  const [events, handles, inbox, coordinatorSeenAt] = await Promise.all([
    latestEvents(db, project),
    openRuntimeHandles(db, project),
    openInboxItems(db, { project, recipient: "coordinator" }),
    lastCoordinatorSeen(db, project),
  ]);
  return { events, handles, inbox, coordinatorSeenAt };
}

async function openLive(opts: LoadOptions): Promise<{ db: Db | null; state: FleetOverview["live"] }> {
  const timeout = opts.liveTimeoutMs ?? 4000;
  try {
    opts.cache.db ??= await withTimeout(opts.sources.openLive(), timeout, "opening Turso");
    const db = opts.cache.db;
    if (!db) return { db: null, state: { state: "off", error: null } };
    const projects = await withTimeout(listProjects(db), timeout, "reading the project registry");
    opts.cache.projects = projects;
    return { db, state: { state: "ok", error: null } };
  } catch (err) {
    // Reopen on the next poll: the client may be stuck on a dead connection.
    opts.cache.db?.close();
    opts.cache.db = null;
    return { db: null, state: { state: "unreachable", error: message(err) } };
  }
}

/** Reads every project and builds the overview the Fleet view renders. */
export async function loadOverview(opts: LoadOptions): Promise<FleetOverview> {
  const { db, state } = await openLive(opts);
  const projects = opts.cache.projects ?? opts.sources.fallbackProjects();
  let live = state;

  const readings = await Promise.all(
    projects.map(async (p): Promise<ProjectReading> => {
      const key = p.slug ?? p.repository;
      const entry = await snapshotOf(p, key, opts);
      const snap = entry.snapshot;
      const base = { slug: snap?.config.project.slug ?? key, name: snap?.config.project.name ?? p.name ?? key };
      if (!snap)
        return { ...base, repository: p.repository, report: null, error: entry.error ?? "not read", live: null };

      let liveData: LiveProject | null = null;
      if (db) {
        try {
          liveData = await withTimeout(readLive(db, snap.config.project.slug), opts.liveTimeoutMs ?? 4000, "Turso");
        } catch (err) {
          live = { state: "unreachable", error: message(err) };
        }
      }
      const warnings = [
        ...(snap.configWarning ? [snap.configWarning] : []),
        ...(entry.error ? [`Linear or GitHub could not be read again (${entry.error}); showing the last reading`] : []),
      ];
      const report = buildStatus({
        config: snap.config,
        ...snap.sources,
        ...(liveData
          ? {
              lastEvents: Object.fromEntries(Object.entries(liveData.events).map(([t, e]) => [t, e.at])),
              live: {
                after: snap.startedAt.toISOString(),
                events: liveData.events,
                handles: Object.fromEntries(liveData.handles.map((h) => [h.ticket, h])),
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
        live: liveData ? { inbox: liveData.inbox, coordinatorSeenAt: liveData.coordinatorSeenAt } : null,
      };
    }),
  );

  // Turso failing midway must not show half the projects as live.
  const liveReadings = live.state === "ok" ? readings : readings.map((r) => ({ ...r, live: null }));
  return buildOverview({ projects: liveReadings, live, now: opts.now() });
}
