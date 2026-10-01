// Where each project's reading of Linear and GitHub is kept (THE-853): in the
// app's database, so a new server answers its first request from Postgres
// instead of reading Linear and GitHub, and every server shows the same
// reading. Each server keeps the bodies it already read, by version, and only
// asks Postgres for the small heads on a poll. Without a database, or while
// it is unreachable, the same rules run on this process's memory, seeded with
// the last bodies the database gave.
//
// A refresh first takes the project's lease (one statement under a row lock):
// one refresh per project at a time across servers. It takes over the marks
// the webhooks left (`markIssues`, `markRepository`, `markEveryProject`), and
// gives them back if it fails, so nothing a webhook said is lost.
import type { ArmadaConfig, StatusSources } from "@armada/core/read";
import { type Database, iso, type Queryable, transaction } from "./db";

/** One reading of a project: its armada.toml and what Linear and GitHub said. */
export interface Snapshot {
  /** When the read started: live events after this are newer than what it says. */
  startedAt: Date;
  config: ArmadaConfig;
  configWarning: string | null;
  sources: StatusSources;
}

/** What a server knows of a project's reading without its body. */
export interface SnapshotHead {
  /** Grows with each reading written. */
  version: number;
  /** When the reading was written; null before the first one. */
  readAt: Date | null;
  /** When the last full Linear read started. */
  fullAt: Date | null;
  /** When the last refresh started, successful or not: refreshes are spaced by the snapshot period. */
  attemptedAt: Date | null;
  /** Why the last refresh failed; null after a success. */
  error: string | null;
  /** A webhook said something changed since the reading. */
  dirty: boolean;
  /** A refresh holds the lease until then. */
  refreshingUntil: Date | null;
}

export interface SnapshotEntry extends SnapshotHead {
  snapshot: Snapshot | null;
}

/** What a refresh took over: the webhooks' marks, and the reading it starts from. */
export interface RefreshClaim {
  entry: SnapshotEntry;
  /** Linear changed (a webhook): read its changes. */
  linear: boolean;
  /** A pull request or its checks changed: read GitHub again. */
  forge: boolean;
  /** Read Linear whole (a label renamed, a ticket deleted). */
  full: boolean;
  /** Linear ids a webhook named. */
  touched: string[];
}

export interface SnapshotStore {
  /** The entries of `keys` that exist, bodies included. */
  entries(keys: string[]): Promise<Map<string, SnapshotEntry>>;
  /**
   * Takes the lease until `now + leaseMs`; null when another refresh holds it,
   * or when the reading is no longer the `seen` version and no webhook marked
   * it since (another refresh just wrote a newer one).
   */
  claim(key: string, now: Date, leaseMs: number, seen?: number): Promise<RefreshClaim | null>;
  /** Writes a new reading and frees the lease; `dirty` when a webhook marked it meanwhile. */
  save(key: string, snapshot: Snapshot, o: { full: boolean; now: Date }): Promise<{ dirty: boolean }>;
  /** Records a failed refresh, frees the lease and gives the marks back. */
  fail(key: string, error: string, claim: RefreshClaim): Promise<void>;
}

// ------------------------------------------------------------ in memory

interface MemoryRow extends SnapshotEntry {
  /** Where the version comes from: a database version is only trusted against the database. */
  source: "db" | "memory";
  linear: boolean;
  forge: boolean;
  full: boolean;
  touched: string[];
}

/** The readings this process holds: the database's body cache, and the store when there is no database. */
export interface MemorySnapshots extends SnapshotStore {
  rows: Map<string, MemoryRow>;
}

const blank = (): MemoryRow => ({
  version: 0,
  readAt: null,
  fullAt: null,
  attemptedAt: null,
  error: null,
  dirty: false,
  refreshingUntil: null,
  snapshot: null,
  source: "memory",
  linear: false,
  forge: false,
  full: false,
  touched: [],
});

const entryOf = (r: MemoryRow): SnapshotEntry => ({
  version: r.version,
  readAt: r.readAt,
  fullAt: r.fullAt,
  attemptedAt: r.attemptedAt,
  error: r.error,
  dirty: r.linear || r.forge || r.full,
  refreshingUntil: r.refreshingUntil,
  snapshot: r.snapshot,
});

export function memorySnapshots(): MemorySnapshots {
  const rows = new Map<string, MemoryRow>();
  return {
    rows,
    async entries(keys) {
      const found = new Map<string, SnapshotEntry>();
      for (const key of keys) {
        const r = rows.get(key);
        if (r) found.set(key, entryOf(r));
      }
      return found;
    },
    async claim(key, now, leaseMs, seen) {
      const r = rows.get(key) ?? blank();
      rows.set(key, r);
      if (r.refreshingUntil && r.refreshingUntil > now) return null;
      if (seen !== undefined && r.version !== seen && !(r.linear || r.forge || r.full)) return null;
      const claim = { entry: entryOf(r), linear: r.linear, forge: r.forge, full: r.full, touched: r.touched };
      Object.assign(r, {
        attemptedAt: now,
        refreshingUntil: new Date(now.getTime() + leaseMs),
        linear: false,
        forge: false,
        full: false,
        touched: [],
      });
      return claim;
    },
    async save(key, snapshot, { full, now }) {
      const r = rows.get(key) ?? blank();
      rows.set(key, r);
      Object.assign(r, {
        version: r.version + 1,
        source: "memory",
        snapshot,
        readAt: now,
        fullAt: full ? snapshot.startedAt : r.fullAt,
        error: null,
        refreshingUntil: null,
      });
      return { dirty: r.linear || r.forge || r.full };
    },
    async fail(key, error, claim) {
      const r = rows.get(key) ?? blank();
      rows.set(key, r);
      Object.assign(r, {
        error,
        refreshingUntil: null,
        linear: r.linear || claim.linear,
        forge: r.forge || claim.forge,
        full: r.full || claim.full,
        touched: [...new Set([...r.touched, ...claim.touched])],
      });
    },
  };
}

// ------------------------------------------------------------ in Postgres

const date = (v: unknown): Date | null => {
  const s = iso(v);
  return s ? new Date(s) : null;
};

const headOf = (r: Record<string, unknown>): SnapshotHead => ({
  version: Number(r.version),
  readAt: date(r.read_at),
  fullAt: date(r.full_at),
  attemptedAt: date(r.attempted_at),
  error: r.error === null || r.error === undefined ? null : String(r.error),
  dirty: r.dirty === true,
  refreshingUntil: date(r.refreshing_until),
});

interface Body {
  config: ArmadaConfig;
  configWarning: string | null;
  sources: StatusSources;
}

const bodyOf = (v: unknown): Body => (typeof v === "string" ? JSON.parse(v) : v) as Body;

const head = (t: string) => `${t}.version, ${t}.read_at, ${t}.full_at, ${t}.attempted_at, ${t}.error,
  ${t}.refreshing_until, (${t}.linear_dirty OR ${t}.forge_dirty OR ${t}.full_due) AS dirty`;
const HEAD = head("fleet_snapshots");

/** The readings in the app's database, with `memory` as the cache of bodies this process already read. */
export function dbSnapshots(db: Database, memory: MemorySnapshots): SnapshotStore {
  /** Keeps a body the database gave; a later poll at the same version does not read it again. */
  const keep = (key: string, head: SnapshotHead, snapshot: Snapshot | null) => {
    const r = memory.rows.get(key) ?? blank();
    memory.rows.set(key, Object.assign(r, head, { snapshot, source: "db" as const }));
    return { ...head, snapshot };
  };
  const cached = (key: string, version: number) => {
    const r = memory.rows.get(key);
    return r?.source === "db" && r.version === version ? r : null;
  };

  async function entries(keys: string[]): Promise<Map<string, SnapshotEntry>> {
    if (!keys.length) return new Map();
    const known = keys.flatMap((k) => {
      const r = memory.rows.get(k);
      return r?.source === "db" && r.snapshot ? [[k, r.version] as const] : [];
    });
    // One round trip: every head, and a body only where this server lacks that version.
    const rs = await db.query(
      `SELECT s.key, s.started_at, ${head("s")},
         CASE WHEN k.version IS NOT DISTINCT FROM s.version THEN NULL ELSE s.body END AS body
       FROM fleet_snapshots s
       LEFT JOIN unnest($2::text[], $3::bigint[]) AS k(key, version) ON k.key = s.key
       WHERE s.key = ANY($1::text[])`,
      [keys, known.map(([k]) => k), known.map(([, v]) => v)],
    );
    const found = new Map<string, SnapshotEntry>();
    for (const row of rs.rows) {
      const key = String(row.key);
      const head = headOf(row);
      const hit = cached(key, head.version);
      const startedAt = date(row.started_at);
      const snapshot =
        row.body !== null && row.body !== undefined && startedAt
          ? { startedAt, ...bodyOf(row.body) }
          : (hit?.snapshot ?? null);
      found.set(key, keep(key, head, snapshot));
    }
    return found;
  }

  return {
    entries,
    async claim(key, now, leaseMs, seen) {
      const claimed = await transaction(db, async (tx) => {
        await tx.query("INSERT INTO fleet_snapshots (key) VALUES ($1) ON CONFLICT (key) DO NOTHING", [key]);
        const rs = await tx.query(
          `SELECT ${HEAD}, linear_dirty, forge_dirty, full_due, touched FROM fleet_snapshots WHERE key = $1 FOR UPDATE`,
          [key],
        );
        const row = rs.rows[0];
        if (!row) return null;
        const head = headOf(row);
        if (head.refreshingUntil && head.refreshingUntil > now) return null;
        if (seen !== undefined && head.version !== seen && !head.dirty) return null;
        await tx.query(
          `UPDATE fleet_snapshots SET attempted_at = $2, refreshing_until = $3,
             linear_dirty = false, forge_dirty = false, full_due = false, touched = '{}'
           WHERE key = $1`,
          [key, now, new Date(now.getTime() + leaseMs)],
        );
        return {
          head,
          linear: row.linear_dirty === true,
          forge: row.forge_dirty === true,
          full: row.full_due === true,
          touched: (row.touched as string[] | null) ?? [],
        };
      });
      if (!claimed) return null;
      const { head, ...marks } = claimed;
      // The reading it starts from: this server's copy when it has that version, else the database's.
      const hit = cached(key, head.version);
      const entry: SnapshotEntry =
        hit?.snapshot || head.readAt === null
          ? { ...head, snapshot: hit?.snapshot ?? null }
          : ((await entries([key])).get(key) ?? { ...head, snapshot: null });
      return { entry, ...marks };
    },
    async save(key, snapshot, { full, now }) {
      const { startedAt, ...body } = snapshot;
      const rs = await db.query(
        `UPDATE fleet_snapshots SET body = $2::jsonb, version = version + 1, started_at = $3, read_at = $4,
           full_at = CASE WHEN $5::boolean THEN $3 ELSE full_at END, error = NULL, refreshing_until = NULL,
           repository = $6, issue_ids = $7::text[]
         WHERE key = $1
         RETURNING ${HEAD}`,
        [
          key,
          JSON.stringify(body),
          startedAt,
          now,
          full,
          snapshot.config.github.repository.toLowerCase(),
          snapshot.sources.program.issues.map((i) => i.uuid),
        ],
      );
      const row = rs.rows[0];
      if (row) keep(key, headOf(row), snapshot);
      return { dirty: row?.dirty === true };
    },
    async fail(key, error, claim) {
      await db.query(
        `UPDATE fleet_snapshots SET error = $2, refreshing_until = NULL,
           linear_dirty = linear_dirty OR $3, forge_dirty = forge_dirty OR $4, full_due = full_due OR $5,
           touched = ARRAY(SELECT DISTINCT unnest(touched || $6::text[]))
         WHERE key = $1`,
        [key, error, claim.linear, claim.forge, claim.full, claim.touched],
      );
    },
  };
}

// ------------------------------------------------------------ the webhooks' marks

/**
 * Marks the projects holding any of these Linear ids (a ticket, its parent,
 * the ticket of a comment): their next refresh reads Linear's changes, and
 * these tickets whatever their update time. `full` asks for a whole read (a
 * ticket deleted). Returns the keys marked.
 */
export async function markIssues(db: Queryable, ids: string[], o: { full?: boolean } = {}): Promise<string[]> {
  if (!ids.length) return [];
  const rs = await db.query<{ key: string }>(
    `UPDATE fleet_snapshots SET linear_dirty = true, full_due = full_due OR $2,
       touched = ARRAY(SELECT DISTINCT unnest(touched || $1::text[]))
     WHERE issue_ids && $1::text[]
     RETURNING key`,
    [ids, o.full === true],
  );
  return rs.rows.map((r) => r.key);
}

/** Marks the projects of a repository (owner/name): their next refresh reads its pull requests again. */
export async function markRepository(db: Queryable, repository: string): Promise<string[]> {
  const rs = await db.query<{ key: string }>(
    "UPDATE fleet_snapshots SET forge_dirty = true WHERE repository = $1 RETURNING key",
    [repository.toLowerCase()],
  );
  return rs.rows.map((r) => r.key);
}

/** Marks every reading for a whole Linear read on its next view (a label renamed or deleted). */
export async function markEveryProject(db: Queryable): Promise<number> {
  const rs = await db.query("UPDATE fleet_snapshots SET full_due = true WHERE body IS NOT NULL");
  return rs.rowCount;
}
