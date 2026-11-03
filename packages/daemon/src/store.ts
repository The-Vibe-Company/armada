import { DatabaseSync } from "node:sqlite";
import type { EventInput, FleetEvent } from "./events.ts";
import { CHECKPOINT_RETENTION, type FleetTables, FOLD_VERSION, FoldAccumulator } from "./fold.ts";

/** Rows replayed past the stored snapshot before the next one is written. */
export const SNAPSHOT_EVERY = 64;

/** What `warm` did for one project: the rows replayed after its snapshot. */
export interface FoldWarmup {
  /** The snapshot's cursor, 0 without one. */
  from: number;
  replayed: number;
  /** Rows whose payload was parsed; the rest were stubbed as superseded. */
  parsed: number;
  ms: number;
  /** Why a stored snapshot was ignored and rebuilt, when one was. */
  ignored?: string;
}

interface ProjectFold {
  accumulator: FoldAccumulator;
  /** The detached tables at a global cursor; rebuilt when the project's rows advance. */
  tables?: { seq: number; tables: FleetTables };
  /** The cursor of the snapshot row on disk, -1 without one. */
  written: number;
  /** Rows replayed since the snapshot on disk. */
  sinceWritten: number;
  /** Whether the accumulator came from a stored snapshot the fold has not yet confirmed. */
  restored: boolean;
  /** Set when a restored snapshot was discarded mid-replay: the replay started over from 0. */
  replayedFrom?: number;
  /** The row on disk was rejected: the next write replaces it whatever its cursor says. */
  rejected?: boolean;
  ignored?: string;
}

/** The only durable store: callers supply time and identity; SQLite supplies order. */
export class EventStore {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<() => void>();
  readonly #folds = new Map<string, ProjectFold>();
  #appending = false;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL CHECK(length(project) > 0),
          kind TEXT NOT NULL CHECK(length(kind) > 0),
          at TEXT NOT NULL CHECK(length(at) > 0),
          actor TEXT NOT NULL CHECK(length(actor) > 0),
          payload TEXT NOT NULL CHECK(json_valid(payload))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS events_project_seq ON events(project, seq);
        CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
          BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
          BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
        -- REPLACE can bypass a DELETE trigger on a connection without recursive_triggers.
        CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
          WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq)
          BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
        -- A durable projection of the fold at a cursor; the log stays the only truth.
        CREATE TABLE IF NOT EXISTS fold_snapshots (
          project TEXT PRIMARY KEY,
          fold_version INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          state TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  append(event: EventInput): FleetEvent {
    return this.appendMany([event])[0]!;
  }

  /** Queue intents and their receipts become visible together, including to subscribers. */
  appendMany(events: readonly EventInput[]): FleetEvent[] {
    return this.#append(() => events);
  }

  /** Allocation reads the committed fold only after acquiring SQLite's writer lock. */
  appendWith(project: string, build: (tables: FleetTables) => readonly EventInput[]): FleetEvent[] {
    return this.#append(() => {
      const events = build(this.fold(project));
      if (events.some((event) => event.project !== project)) throw new Error("appendWith project mismatch");
      return events;
    });
  }

  #append(build: () => readonly EventInput[]): FleetEvent[] {
    const stored: FleetEvent[] = [];
    this.#db.exec("BEGIN IMMEDIATE");
    this.#appending = true;
    try {
      const insert = this.#db.prepare("INSERT INTO events (project, kind, at, actor, payload) VALUES (?, ?, ?, ?, ?)");
      for (const event of build()) {
        const payload = JSON.stringify(event.payload);
        const result = insert.run(event.project, event.kind, event.at, event.actor, payload);
        stored.push({ ...event, payload: JSON.parse(payload), seq: Number(result.lastInsertRowid) } as FleetEvent);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#appending = false;
    }
    // The committed sequence is the cache key: an observer's fold reads past it.
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A failed observer cannot make a committed write look unsuccessful.
        this.#listeners.delete(listener);
      }
    }
    return stored;
  }

  /** Global committed high-water mark, including events of other projects. */
  get sequence(): number {
    return Number(this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get()?.seq);
  }

  /** In-process commit notice. Readers resume from their own cursor; no event objects are shared. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Exclusive global cursor; a project filter never renumbers the log. */
  readSince(sequence: number, project?: string, limit = -1): FleetEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error("sequence must be a non-negative safe integer");
    const columns = "SELECT seq, project, kind, at, actor, payload FROM events WHERE seq > ?";
    const rows =
      project === undefined
        ? this.#db.prepare(`${columns} ORDER BY seq LIMIT ?`).all(sequence, limit)
        : this.#db.prepare(`${columns} AND project = ? ORDER BY seq LIMIT ?`).all(sequence, project, limit);
    return rows.map(
      (row) =>
        ({
          seq: row.seq,
          project: row.project,
          kind: row.kind,
          at: row.at,
          actor: row.actor,
          payload: JSON.parse(row.payload as string),
        }) as FleetEvent,
    );
  }

  /** The fold's own read: the same rows as `readSince`, except that a
   * `coordinator.checkpoint` without a turn whose format the fold never reads,
   * or that a later row of the same actor and format supersedes, comes back with
   * a `{ checkpoint: null }` stub instead of its parsed payload. Exact for the
   * fold only, which reads those formats latest-wins: a row counts as superseding
   * only when it carries what the fold reads (version 1 and a usage object), so
   * a cursor-only checkpoint never hides an earlier reading. `readSince` is unchanged.
   */
  readForFold(sequence: number, project: string): { events: FleetEvent[]; parsed: number } {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error("sequence must be a non-negative safe integer");
    const list = (formats: readonly string[]) => formats.map((f) => `'${f}'`).join(", ");
    const rows = this.#db
      .prepare(`
      WITH scope AS MATERIALIZED (
        SELECT seq, actor,
          CASE WHEN kind = 'coordinator.checkpoint' AND json_type(payload, '$.turn') IS NULL
            THEN json_extract(payload, '$.checkpoint.format') END AS format,
          json_extract(payload, '$.checkpoint.version') = 1
            AND json_type(payload, '$.checkpoint.usage') = 'object' AS readable
        FROM events WHERE seq > ? AND project = ?),
      latest AS MATERIALIZED (
        SELECT MAX(seq) AS seq FROM scope WHERE format IN (${list(CHECKPOINT_RETENTION.latest)}) AND readable
        GROUP BY actor, format)
      SELECT e.seq, e.project, e.kind, e.at, e.actor,
        CASE WHEN s.format IN (${list(CHECKPOINT_RETENTION.skipped)})
          OR (s.format IN (${list(CHECKPOINT_RETENTION.latest)}) AND s.readable
            AND s.seq NOT IN (SELECT seq FROM latest))
          THEN NULL ELSE e.payload END AS payload
      FROM scope s JOIN events e ON e.seq = s.seq ORDER BY e.seq
    `)
      .all(sequence, project);
    let parsed = 0;
    const events = rows.map((row) => {
      if (row.payload !== null) parsed++;
      return {
        seq: row.seq,
        project: row.project,
        kind: row.kind,
        at: row.at,
        actor: row.actor,
        payload: row.payload === null ? { checkpoint: null } : JSON.parse(row.payload as string),
      } as FleetEvent;
    });
    return { events, parsed };
  }

  /** One reading per project at a committed cursor. Callers own detached results.
   * The reading resumes from the project's stored snapshot, then advances by the
   * rows appended since; the pure fold over `readSince(0, project)` is its contract.
   */
  fold(project: string): FleetTables {
    const seq = this.sequence;
    const entry = this.#entry(project);
    if (entry.tables?.seq !== seq) {
      this.#advance(entry, project, seq);
      if (!this.#appending && entry.sinceWritten >= SNAPSHOT_EVERY) this.#writeSnapshot(project, entry);
    }
    const tables = structuredClone(entry.tables!.tables);
    // structuredClone drops null prototypes. Keep dictionary lookups identical to
    // the pure fold, including a missing project/provider named "constructor".
    Object.setPrototypeOf(tables.projects, null);
    for (const state of Object.values(tables.projects)) {
      if (state.readers) Object.setPrototypeOf(state.readers, null);
      if (state.readAt) Object.setPrototypeOf(state.readAt, null);
    }
    return tables;
  }

  /** Rows these projects would replay after their snapshots: what a boot reads. */
  pending(projects: readonly string[]): number {
    const count = this.#db.prepare("SELECT COUNT(*) AS count FROM events WHERE project = ? AND seq > ?");
    let total = 0;
    for (const project of new Set(projects))
      total += Number(count.get(project, this.#entry(project).accumulator.seq)?.count);
    return total;
  }

  /** Replay a project's rows after its snapshot now, and store the result when anything was replayed. */
  warm(project: string): FoldWarmup {
    const before = performance.now();
    const seq = this.sequence;
    const entry = this.#entry(project);
    const from = entry.accumulator.seq;
    const read = this.#advance(entry, project, seq);
    if (read.events.length) this.#writeSnapshot(project, entry);
    const ignored = entry.ignored;
    delete entry.ignored;
    const replayedFrom = entry.replayedFrom;
    delete entry.replayedFrom;
    return {
      from: replayedFrom ?? from,
      replayed: read.events.length,
      parsed: read.parsed,
      ms: performance.now() - before,
      ...(ignored ? { ignored } : {}),
    };
  }

  #entry(project: string): ProjectFold {
    let entry = this.#folds.get(project);
    if (entry) return entry;
    entry = { accumulator: new FoldAccumulator(), written: -1, sinceWritten: 0, restored: false };
    const row = this.#db
      .prepare("SELECT fold_version, seq, state FROM fold_snapshots WHERE project = ?")
      .get(project) as { fold_version: unknown; seq: unknown; state: unknown } | undefined;
    if (row) {
      try {
        if (row.fold_version !== FOLD_VERSION) throw new Error(`fold version ${String(row.fold_version)}`);
        if (typeof row.state !== "string") throw new Error("state is not text");
        const accumulator = FoldAccumulator.restore(row.state);
        if (accumulator.seq !== row.seq) throw new Error("cursor differs from its state");
        if (accumulator.seq > this.sequence) throw new Error("cursor is ahead of the log");
        entry.accumulator = accumulator;
        entry.written = accumulator.seq;
        entry.restored = true;
      } catch (error) {
        // The log is the truth: a snapshot that cannot be read is rebuilt from it.
        entry.ignored = error instanceof Error ? error.message : String(error);
        entry.rejected = true;
      }
    }
    this.#folds.set(project, entry);
    return entry;
  }

  /** Replay the rows after the accumulator's cursor and rebuild the tables at `seq`.
   * A restored snapshot whose values break the fold is discarded here and the
   * project folds from the log instead: the snapshot can never fail a reading.
   */
  #advance(entry: ProjectFold, project: string, seq: number): { events: FleetEvent[]; parsed: number } {
    const read = this.readForFold(entry.accumulator.seq, project);
    try {
      for (const event of read.events) entry.accumulator.append(event, true);
      if (read.events.length || !entry.tables) entry.tables = { seq, tables: entry.accumulator.snapshot() };
      else entry.tables.seq = seq;
    } catch (error) {
      if (!entry.restored) throw error;
      entry.ignored = `fold failed on its state: ${error instanceof Error ? error.message : String(error)}`;
      entry.replayedFrom = 0;
      entry.rejected = true;
      entry.accumulator = new FoldAccumulator();
      entry.written = -1;
      entry.restored = false;
      entry.tables = undefined;
      const rebuilt = this.#advance(entry, project, seq);
      entry.sinceWritten = 0;
      return rebuilt;
    }
    entry.restored = false;
    entry.sinceWritten += read.events.length;
    return read;
  }

  #writeSnapshot(project: string, entry: ProjectFold): void {
    const seq = entry.accumulator.seq;
    if (seq <= entry.written) return;
    try {
      // Another connection may have stored a newer reading: never move a row this
      // connection could read back. A rejected row is replaced whatever it says.
      const guard = entry.rejected ? "" : " WHERE excluded.seq > fold_snapshots.seq";
      this.#db
        .prepare(`INSERT INTO fold_snapshots (project, fold_version, seq, state) VALUES (?, ?, ?, ?)
          ON CONFLICT(project) DO UPDATE SET fold_version = excluded.fold_version, seq = excluded.seq, state = excluded.state${guard}`)
        .run(project, FOLD_VERSION, seq, entry.accumulator.serialize());
      entry.written = seq;
      entry.sinceWritten = 0;
      entry.rejected = false;
    } catch {
      // A snapshot is a convenience: the next fold retries, and the log stays complete.
    }
  }

  get count(): number {
    return Number(this.#db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count);
  }

  /** Bounded history: SQL owns filtering, correlation, ordering and the exclusive cursor. */
  history(project: string, ticket?: string, cursor = this.sequence + 1, limit = 50): FleetEvent[] {
    const rows = this.#db
      .prepare(`
      SELECT e.seq, e.project, e.kind, e.at, e.actor, e.payload FROM events e
      WHERE project = ? AND seq < ?
        AND (kind != 'coordinator.checkpoint' OR json_extract(payload, '$.checkpoint.format') = 'armada.worker')
        AND (? IS NULL OR json_extract(payload, '$.ticket') = ?
          OR (kind IN ('ticket.seen', 'ticket.created') AND json_extract(payload, '$.id') = ?)
          OR (kind = 'coordinator.checkpoint' AND json_extract(payload, '$.checkpoint.ticket') = ?)
          OR (kind IN ('inbox.answered', 'validation.decided', 'merge.started', 'merge.refused', 'merge.canceled')
            AND json_extract(payload, '$.id') IN (
              SELECT json_extract(payload, '$.id') FROM events
              WHERE project = ? AND kind IN ('inbox.opened', 'validation.opened', 'merge.queued')
                AND json_extract(payload, '$.ticket') = ?
                AND kind = CASE WHEN e.kind = 'inbox.answered' THEN 'inbox.opened'
                  WHEN e.kind = 'validation.decided' THEN 'validation.opened' ELSE 'merge.queued' END)))
      ORDER BY seq DESC LIMIT ?
    `)
      .all(
        project,
        cursor,
        ticket ?? null,
        ticket ?? null,
        ticket ?? null,
        ticket ?? null,
        project,
        ticket ?? null,
        limit,
      );
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload as string) }) as FleetEvent);
  }

  close(): void {
    for (const [project, entry] of this.#folds) this.#writeSnapshot(project, entry);
    this.#folds.clear();
    this.#listeners.clear();
    this.#db.close();
  }
}
