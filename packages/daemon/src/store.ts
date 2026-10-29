import { DatabaseSync } from "node:sqlite";
import type { EventInput, FleetEvent } from "./events.ts";

/** The only durable store: callers supply time and identity; SQLite supplies order. */
export class EventStore {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<() => void>();

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
    const payload = JSON.stringify(event.payload);
    const result = this.#db
      .prepare("INSERT INTO events (project, kind, at, actor, payload) VALUES (?, ?, ?, ?, ?)")
      .run(event.project, event.kind, event.at, event.actor, payload);
    // Return exactly what was persisted, detached from the caller's objects.
    const stored = { ...event, payload: JSON.parse(payload), seq: Number(result.lastInsertRowid) } as FleetEvent;
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
  readSince(sequence: number, project?: string): FleetEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error("sequence must be a non-negative safe integer");
    const columns = "SELECT seq, project, kind, at, actor, payload FROM events WHERE seq > ?";
    const rows =
      project === undefined
        ? this.#db.prepare(`${columns} ORDER BY seq`).all(sequence)
        : this.#db.prepare(`${columns} AND project = ? ORDER BY seq`).all(sequence, project);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload as string) }) as FleetEvent);
  }

  close(): void {
    this.#listeners.clear();
    this.#db.close();
  }
}
