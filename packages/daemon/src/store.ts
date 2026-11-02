import { DatabaseSync } from "node:sqlite";
import type { EventInput, FleetEvent } from "./events.ts";
import { type FleetTables, fold } from "./fold.ts";

/** The only durable store: callers supply time and identity; SQLite supplies order. */
export class EventStore {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<() => void>();
  readonly #folds = new Map<string, { seq: number; tables: FleetTables }>();

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
    }
    // Publish cache invalidation with the commit, before any observer reads it.
    if (stored.length) this.#folds.clear();
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
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload as string) }) as FleetEvent);
  }

  /** One replay per project at a committed cursor. Callers own detached results.
   * This is a memo of the pure fold, never an incremental or durable projection.
   */
  fold(project: string): FleetTables {
    const seq = this.sequence;
    let cached = this.#folds.get(project);
    if (!cached || cached.seq !== seq) {
      cached = { seq, tables: fold(this.readSince(0, project)) };
      this.#folds.set(project, cached);
    }
    const tables = structuredClone(cached.tables);
    // structuredClone drops null prototypes. Keep dictionary lookups identical to
    // the pure fold, including a missing project/provider named "constructor".
    Object.setPrototypeOf(tables.projects, null);
    for (const state of Object.values(tables.projects)) {
      if (state.readers) Object.setPrototypeOf(state.readers, null);
      if (state.readAt) Object.setPrototypeOf(state.readAt, null);
    }
    return tables;
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
    this.#folds.clear();
    this.#listeners.clear();
    this.#db.close();
  }
}
