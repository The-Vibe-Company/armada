import { Database } from "bun:sqlite";
import type { AgentEvent, PromptStatus } from "@armada/core";
import { checkpointIdentity, checkpointIdentityKey } from "./identity.ts";
import type { CheckpointIdentity, StoredPrompt } from "./protocol.ts";
import { createRedactor } from "./state.ts";
export class Journal {
  readonly db: Database;
  readonly redact: (text: string) => string;
  private dynamicRedactor = createRedactor([]);
  registerSecrets(values: readonly string[]) {
    this.dynamicRedactor.register(values);
  }
  constructor(path: string, redact: (text: string) => string) {
    this.redact = (text) => this.dynamicRedactor(redact(text));
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
 CREATE TABLE IF NOT EXISTS prompts(id TEXT PRIMARY KEY, conversation TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(conversation TEXT PRIMARY KEY,harness TEXT NOT NULL,session TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS processes(pid INTEGER PRIMARY KEY,body TEXT NOT NULL);`);
  }
  append(event: AgentEvent): number {
    let body = this.redact(JSON.stringify(event));
    if (body.length > 262144)
      body = JSON.stringify({
        id: event.id,
        at: event.at,
        conversationId: event.conversationId,
        promptId: event.promptId,
        kind: "other",
        type: "event_truncated",
        data: { originalKind: event.kind, bytes: body.length },
      });
    return Number(this.db.query("INSERT INTO events(body) VALUES(?)").run(body).lastInsertRowid);
  }
  transition(prompt: StoredPrompt, status: PromptStatus, reason?: string) {
    this.db.transaction(() => {
      this.db
        .query("INSERT OR REPLACE INTO prompts VALUES(?,?,?,?)")
        .run(prompt.promptId, prompt.conversationId, status, this.redact(JSON.stringify({ ...prompt, status })));
      this.append({
        id: crypto.randomUUID(),
        at: Date.now(),
        kind: "prompt",
        promptId: prompt.promptId,
        conversationId: prompt.conversationId,
        text: prompt.request.text,
        status,
        ...(reason ? { reason } : {}),
      });
    })();
  }
  prompts(): StoredPrompt[] {
    return (this.db.query("SELECT body FROM prompts").all() as { body: string }[]).map((r) => JSON.parse(r.body));
  }
  get(id: string) {
    return this.prompts().find((p) => p.promptId === id);
  }
  session(conversation: string): string | undefined {
    return (
      this.db.query("SELECT session FROM sessions WHERE conversation=?").get(conversation) as { session: string } | null
    )?.session;
  }
  saveSession(conversation: string, harness: string, session: string) {
    if (
      !conversation ||
      conversation.length > 256 ||
      !session ||
      session.length > 256 ||
      !["claude", "codex"].includes(harness) ||
      this.redact(conversation) !== conversation ||
      this.redact(session) !== session
    )
      throw Error("invalid_native_session_identity");
    const saved = this.db
      .query(`INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(conversation) DO UPDATE SET
      harness=excluded.harness,session=excluded.session
      WHERE sessions.harness=excluded.harness AND sessions.session=excluded.session RETURNING session`)
      .get(conversation, harness, session);
    if (!saved) throw Error("native_session_identity_changed");
  }
  events(after = 0, limit = 100, conversation?: string) {
    const rows = this.db
      .query(
        "SELECT seq,body FROM events WHERE seq>? AND (? IS NULL OR json_extract(body,'$.conversationId')=?) ORDER BY seq LIMIT ?",
      )
      .all(after, conversation ?? null, conversation ?? null, limit) as { seq: number; body: string }[];
    return rows.map((r) => ({ sequence: r.seq, event: JSON.parse(r.body) as AgentEvent }));
  }

  get ack() {
    const value = Number(
      (this.db.query("SELECT value FROM metadata WHERE key='ack'").get() as { value: string } | null)?.value ?? 0,
    );
    if (!Number.isSafeInteger(value) || value < 0) throw Error("invalid_ingest_ack_metadata");
    return value;
  }
  set ack(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw Error("invalid_ingest_ack");
    this.db.query("INSERT OR REPLACE INTO metadata VALUES('ack',?)").run(String(value));
  }
  private assertNoLegacySeals() {
    for (const row of this.db.query("SELECT key FROM metadata WHERE key LIKE 'checkpoint:%'").all() as {
      key: string;
    }[])
      if (!/^checkpoint:v2:[a-f0-9]{64}$/.test(row.key)) throw Error("checkpoint_identity_ambiguous");
  }
  assertRestoreSource(identity: CheckpointIdentity): CheckpointIdentity | undefined {
    this.assertNoLegacySeals();
    const target = checkpointIdentity(identity),
      row = this.db.query("SELECT value FROM metadata WHERE key='runner:identity'").get() as { value: string } | null;
    if (!row) {
      for (const table of ["prompts", "sessions", "events", "requests", "processes", "metadata"])
        if (this.db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw Error("checkpoint_identity_ambiguous");
      return undefined;
    }
    let source: CheckpointIdentity;
    try {
      source = checkpointIdentity(JSON.parse(row.value));
    } catch {
      throw Error("checkpoint_identity_ambiguous");
    }
    if (source.sandboxId !== target.sandboxId) {
      const seal = this.db
        .query("SELECT value FROM metadata WHERE key=?")
        .get(`checkpoint:v2:${checkpointIdentityKey(source)}`) as { value: string } | null;
      if (seal?.value !== "complete") throw Error("checkpoint_source_not_quiescent");
      if (
        this.db.query("SELECT id FROM prompts LIMIT 1").get() ||
        this.db.query("SELECT conversation FROM sessions LIMIT 1").get() ||
        this.db.query("SELECT seq FROM events LIMIT 1").get()
      )
        throw Error("golden_runner_history_not_empty");
    }
    return source;
  }
  bindIdentity(identity: CheckpointIdentity) {
    this.assertRestoreSource(identity);
    this.db
      .query("INSERT OR REPLACE INTO metadata VALUES('runner:identity',?)")
      .run(JSON.stringify(checkpointIdentity(identity)));
  }
  checkpointPending(identity: CheckpointIdentity): boolean {
    this.assertRestoreSource(identity);
    const scope = checkpointIdentity(identity),
      key = `checkpoint:v2:${checkpointIdentityKey(scope)}`;
    if (this.db.query("SELECT value FROM metadata WHERE key=?").get(key) !== null) return true;
    return false;
  }
  checkpointFence(identity: CheckpointIdentity, phase: "preparing" | "complete") {
    if (!this.assertRestoreSource(identity)) throw Error("checkpoint_identity_ambiguous");
    this.checkpointPending(identity);
    this.db
      .query("INSERT OR REPLACE INTO metadata VALUES(?,?)")
      .run(`checkpoint:v2:${checkpointIdentityKey(identity)}`, phase);
  }
  sanitize() {
    this.db.transaction(() => {
      for (const table of ["events", "prompts", "requests", "processes"]) {
        for (const row of this.db.query(`SELECT rowid AS recordId,body FROM ${table}`).all() as {
          recordId: number;
          body: string;
        }[])
          this.db.query(`UPDATE ${table} SET body=? WHERE rowid=?`).run(this.redact(row.body), row.recordId);
      }
    })();
    this.flush();
    this.db.exec("VACUUM");
    this.flush();
  }
  flush() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    this.db.close();
  }
}
