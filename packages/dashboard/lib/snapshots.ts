// Where each project's reading of Linear and GitHub is kept (THE-853): in the
// app's database, so a new server answers its first request from Postgres
// instead of reading Linear and GitHub, and every server shows the same
// reading. Each server keeps the bodies it already read, by version, and only
// asks Postgres for the small heads on a poll. Without a database, or while
// it is unreachable, the same rules run on this process's memory, seeded with
// the last bodies the database gave.
//
// A refresh first takes the project's lease (one statement under a row lock):
// one refresh per project at a time across servers. Its write only lands while
// it still holds that lease, so a refresh that outlived it never overwrites a
// newer reading. The webhooks' marks (`markIssues`, `markRepository`,
// `markEveryProject`) stay until a reading that saw them is written: a refresh
// that fails or is cut short loses none of them.
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
  /** When each webhook last marked this reading: a reading both keep fresh may be refreshed less often on view. */
  hooks: { linear: Date | null; github: Date | null };
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
  /** How many marks the reading had received: those after it stay for the next refresh. */
  marked: number;
  /** The lease, as taken: a write after it was lost or taken over does not land. */
  lease: Date;
}

export interface ClaimOptions {
  /** The version the caller saw: when another refresh wrote a newer one meanwhile and no webhook marked it since, there is nothing to do. */
  seen?: number;
  /** No refresh when the last one started less than this ago: a burst of webhooks makes one read, not one each. */
  gapMs?: number;
}

export interface SnapshotStore {
  /** The entries of `keys` that exist, bodies included. */
  entries(keys: string[]): Promise<Map<string, SnapshotEntry>>;
  /** Takes the lease until `now + leaseMs`; null when another refresh holds it, or `o` says there is nothing to do. */
  claim(key: string, now: Date, leaseMs: number, o?: ClaimOptions): Promise<RefreshClaim | null>;
  /**
   * Writes a new reading and frees the lease, when the claim still holds it
   * (`saved`); clears the marks the claim saw. `dirty` when a webhook marked
   * the reading since the claim.
   */
  save(
    key: string,
    snapshot: Snapshot,
    claim: RefreshClaim,
    o: { full: boolean; now: Date },
  ): Promise<{ saved: boolean; dirty: boolean }>;
  /** Records a failed refresh and frees the lease, when the claim still holds it. The marks stay. */
  fail(key: string, error: string, claim: RefreshClaim): Promise<void>;
}

const due = (head: SnapshotHead, now: Date, o: ClaimOptions) =>
  !(head.refreshingUntil && head.refreshingUntil > now) &&
  !(o.seen !== undefined && head.version !== o.seen && !head.dirty) &&
  !(o.gapMs && head.attemptedAt && now.getTime() - head.attemptedAt.getTime() < o.gapMs);

// ------------------------------------------------------------ in memory

interface MemoryRow extends SnapshotEntry {
  /** Where the version comes from: a database version is only trusted against the database. */
  source: "db" | "memory";
  linear: boolean;
  forge: boolean;
  full: boolean;
  touched: string[];
  marked: number;
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
  hooks: { linear: null, github: null },
  snapshot: null,
  source: "memory",
  linear: false,
  forge: false,
  full: false,
  touched: [],
  marked: 0,
});

const entryOf = (r: MemoryRow): SnapshotEntry => ({
  version: r.version,
  readAt: r.readAt,
  fullAt: r.fullAt,
  attemptedAt: r.attemptedAt,
  error: r.error,
  dirty: r.linear || r.forge || r.full,
  refreshingUntil: r.refreshingUntil,
  hooks: r.hooks,
  snapshot: r.snapshot,
});

export function memorySnapshots(): MemorySnapshots {
  const rows = new Map<string, MemoryRow>();
  const row = (key: string) => {
    const r = rows.get(key) ?? blank();
    rows.set(key, r);
    return r;
  };
  const holds = (r: MemoryRow, claim: RefreshClaim) => r.refreshingUntil?.getTime() === claim.lease.getTime();
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
    async claim(key, now, leaseMs, o = {}) {
      const r = row(key);
      if (!due(entryOf(r), now, o)) return null;
      const lease = new Date(now.getTime() + leaseMs);
      const claim = {
        entry: entryOf(r),
        linear: r.linear,
        forge: r.forge,
        full: r.full,
        touched: r.touched,
        marked: r.marked,
        lease,
      };
      Object.assign(r, { attemptedAt: now, refreshingUntil: lease });
      return claim;
    },
    async save(key, snapshot, claim, { full, now }) {
      const r = row(key);
      if (!holds(r, claim)) return { saved: false, dirty: false };
      const seen = r.marked === claim.marked;
      Object.assign(r, {
        version: r.version + 1,
        source: "memory",
        snapshot,
        readAt: now,
        fullAt: full ? snapshot.startedAt : r.fullAt,
        error: null,
        refreshingUntil: null,
        ...(seen ? { linear: false, forge: false, full: false, touched: [] } : {}),
      });
      return { saved: true, dirty: r.linear || r.forge || r.full };
    },
    async fail(key, error, claim) {
      const r = row(key);
      if (holds(r, claim)) Object.assign(r, { error, refreshingUntil: null });
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
  hooks: { linear: date(r.linear_hook_at), github: date(r.github_hook_at) },
});

interface Body {
  config: ArmadaConfig;
  configWarning: string | null;
  sources: StatusSources;
}

const bodyOf = (v: unknown): Body => (typeof v === "string" ? JSON.parse(v) : v) as Body;

const head = (t: string) => `${t}.version, ${t}.read_at, ${t}.full_at, ${t}.attempted_at, ${t}.error,
  ${t}.refreshing_until, ${t}.linear_hook_at, ${t}.github_hook_at,
  (${t}.linear_dirty OR ${t}.forge_dirty OR ${t}.full_due) AS dirty`;
const HEAD = head("fleet_snapshots");

/** The readings in the app's database, with `memory` as the cache of bodies this process already read. */
export function dbSnapshots(db: Database, memory: MemorySnapshots): SnapshotStore {
  /**
   * Keeps what the database gave. A copy this process already holds at a newer
   * version (its own refresh wrote it while this read ran) is kept instead.
   */
  const keep = (key: string, h: SnapshotHead, snapshot: Snapshot | null): SnapshotEntry => {
    const r = memory.rows.get(key);
    if (r?.source === "db" && r.version > h.version) return entryOf(r);
    memory.rows.set(key, Object.assign(r ?? blank(), h, { snapshot, source: "db" as const }));
    return { ...h, snapshot };
  };
  const cached = (key: string, version: number) => {
    const r = memory.rows.get(key);
    return r?.source === "db" && r.version === version && r.snapshot ? r.snapshot : null;
  };
  const snapshotOf = (row: Record<string, unknown>): Snapshot | null => {
    const startedAt = date(row.started_at);
    return row.body !== null && row.body !== undefined && startedAt ? { startedAt, ...bodyOf(row.body) } : null;
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
    const missing: string[] = [];
    for (const row of rs.rows) {
      const key = String(row.key);
      const h = headOf(row);
      const snapshot = snapshotOf(row) ?? cached(key, h.version);
      // Left out because this server held it, then replaced meanwhile: read it again below.
      if (!snapshot && h.readAt) missing.push(key);
      else found.set(key, keep(key, h, snapshot));
    }
    if (missing.length) {
      const again = await db.query(
        `SELECT key, started_at, body, ${HEAD} FROM fleet_snapshots WHERE key = ANY($1::text[])`,
        [missing],
      );
      for (const row of again.rows) found.set(String(row.key), keep(String(row.key), headOf(row), snapshotOf(row)));
    }
    return found;
  }

  return {
    entries,
    async claim(key, now, leaseMs, o = {}) {
      const lease = new Date(now.getTime() + leaseMs);
      const claimed = await transaction(db, async (tx) => {
        await tx.query("INSERT INTO fleet_snapshots (key) VALUES ($1) ON CONFLICT (key) DO NOTHING", [key]);
        const rs = await tx.query(
          `SELECT ${HEAD}, linear_dirty, forge_dirty, full_due, touched, marked FROM fleet_snapshots WHERE key = $1 FOR UPDATE`,
          [key],
        );
        const row = rs.rows[0];
        if (!row) return null;
        const h = headOf(row);
        if (!due(h, now, o)) return null;
        await tx.query("UPDATE fleet_snapshots SET attempted_at = $2, refreshing_until = $3 WHERE key = $1", [
          key,
          now,
          lease,
        ]);
        return {
          head: h,
          linear: row.linear_dirty === true,
          forge: row.forge_dirty === true,
          full: row.full_due === true,
          touched: (row.touched as string[] | null) ?? [],
          marked: Number(row.marked),
        };
      });
      if (!claimed) return null;
      const { head: h, ...marks } = claimed;
      // The reading it starts from: this server's copy when it has that version, else the database's.
      const hit = cached(key, h.version);
      const entry: SnapshotEntry =
        hit || h.readAt === null
          ? { ...h, snapshot: hit }
          : ((await entries([key])).get(key) ?? { ...h, snapshot: null });
      return { entry, ...marks, lease };
    },
    async save(key, snapshot, claim, { full, now }) {
      const { startedAt, ...body } = snapshot;
      const rs = await db.query(
        `UPDATE fleet_snapshots SET body = $2::jsonb, version = version + 1, started_at = $3, read_at = $4,
           full_at = CASE WHEN $5::boolean THEN $3 ELSE full_at END, error = NULL, refreshing_until = NULL,
           repository = $6, issue_ids = $7::text[],
           linear_dirty = linear_dirty AND marked <> $9, forge_dirty = forge_dirty AND marked <> $9,
           full_due = full_due AND marked <> $9, touched = CASE WHEN marked = $9 THEN '{}' ELSE touched END
         WHERE key = $1 AND refreshing_until = $8
         RETURNING ${HEAD}`,
        [
          key,
          JSON.stringify(body),
          startedAt,
          now,
          full,
          snapshot.config.github.repository.toLowerCase(),
          snapshot.sources.program.issues.map((i) => i.uuid),
          claim.lease,
          claim.marked,
        ],
      );
      const row = rs.rows[0];
      if (!row) return { saved: false, dirty: false };
      keep(key, headOf(row), snapshot);
      return { saved: true, dirty: row.dirty === true };
    },
    async fail(key, error, claim) {
      await db.query(
        "UPDATE fleet_snapshots SET error = $2, refreshing_until = NULL WHERE key = $1 AND refreshing_until = $3",
        [key, error, claim.lease],
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
export async function markIssues(
  db: Queryable,
  ids: string[],
  o: { full?: boolean; now?: Date } = {},
): Promise<string[]> {
  if (!ids.length) return [];
  const rs = await db.query<{ key: string }>(
    `UPDATE fleet_snapshots SET linear_dirty = true, full_due = full_due OR $2, marked = marked + 1,
       linear_hook_at = $3, touched = ARRAY(SELECT DISTINCT unnest(touched || $1::text[]) ORDER BY 1)
     WHERE issue_ids && $1::text[]
     RETURNING key`,
    [ids, o.full === true, o.now ?? new Date()],
  );
  return rs.rows.map((r) => r.key);
}

/** Marks the projects of a repository (owner/name): their next refresh reads its pull requests again. */
export async function markRepository(db: Queryable, repository: string, now: Date = new Date()): Promise<string[]> {
  const rs = await db.query<{ key: string }>(
    `UPDATE fleet_snapshots SET forge_dirty = true, marked = marked + 1, github_hook_at = $2
     WHERE repository = $1 RETURNING key`,
    [repository.toLowerCase(), now],
  );
  return rs.rows.map((r) => r.key);
}

/** Marks every reading for a whole Linear read on its next view (a label renamed or deleted). */
export async function markEveryProject(db: Queryable): Promise<number> {
  const rs = await db.query("UPDATE fleet_snapshots SET full_due = true, marked = marked + 1 WHERE body IS NOT NULL");
  return rs.rowCount;
}
