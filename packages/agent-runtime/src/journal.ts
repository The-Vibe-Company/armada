import { Database } from "bun:sqlite";
import type { AgentEvent, PromptStatus } from "@armada/core";
import { HARNESSES, isFinalPromptStatus } from "@armada/core";
import { HarnessError } from "./errors.ts";
import { checkpointIdentity, checkpointIdentityKey } from "./identity.ts";
import type { CheckpointIdentity, StoredPrompt } from "./protocol.ts";
import { createRedactor, createShortSecretTextRedactor } from "./state.ts";

/** Cut a preview without splitting a surrogate pair into a lone UTF-16 code unit. */
function boundedPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = limit > 0 && /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit;
  return text.slice(0, end);
}
function maskText(original: string, scrubbed: string, mask: (text: string) => string) {
  const short = mask(original);
  if (short === original || short === scrubbed) return scrubbed;
  return original === scrubbed ? short : "[REDACTED]";
}

const maskPayload: (value: unknown, mask: (text: string) => string) => unknown = (value, mask) => {
  if (typeof value === "string") return mask(value);
  if (typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    const masked = mask(text);
    return text === masked ? value : "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, mask));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), maskPayload(item, mask)]));
  return value;
};

export class Journal {
  readonly db: Database;
  readonly redact: (text: string) => string;
  private dynamicRedactor = createRedactor([]);
  private applicationSecrets = new Set<string>();
  private redactShortApplicationText: ((text: string) => string) | undefined;
  registerSecrets(values: readonly string[]) {
    this.dynamicRedactor.register(values);
  }
  registerApplicationSecrets(values: readonly string[]) {
    this.registerSecrets(values);
    for (const value of values) if (value.length > 0 && value.length < 8) this.applicationSecrets.add(value);
    this.redactShortApplicationText = createShortSecretTextRedactor([...this.applicationSecrets]);
  }
  redactCommandOutput(text: string, truncated: boolean): string {
    const mask = this.redactShortApplicationText;
    if (mask && truncated) return "[REDACTED]";
    const scrubbed = this.redact(text);
    return mask ? maskText(text, scrubbed, mask) : scrubbed;
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
  // The listener only schedules work, so a synchronous transaction can commit before it runs.
  onAppend: ((sequence: number) => void) | undefined;
  append(event: AgentEvent): number {
    const terminalSnapshot = event.kind === "message" && !event.partial && event.textMode === "snapshot";
    // Control events must retain their identity, status and failure reason. Bound only
    // the display preview, after redaction, so JSON escaping cannot erase the event.
    let control = event;
    if (
      (event.kind === "prompt" || event.kind === "steer") &&
      Buffer.byteLength(this.redact(JSON.stringify(event))) > 262144
    )
      control = { ...event, text: `${boundedPreview(this.redact(event.text), 16000)}… [truncated]` };
    let body = this.eventBody(control, true);
    const oversized = Buffer.byteLength(body) > 262144;
    if (oversized)
      body = JSON.stringify({
        id: event.id,
        at: event.at,
        conversationId: event.conversationId,
        promptId: event.promptId,
        kind: "other",
        type: "event_truncated",
        data: { originalKind: event.kind, bytes: body.length, ...(terminalSnapshot ? { terminal: true } : {}) },
      });
    const sequence = Number(this.db.query("INSERT INTO events(body) VALUES(?)").run(body).lastInsertRowid);
    this.onAppend?.(sequence);
    // A terminal snapshot is an answer receipt. Never acknowledge a finished answer whose full text
    // was replaced by a truncation marker (including size growth caused by secret redaction).
    if (oversized && terminalSnapshot) throw new HarnessError("invalid_harness_protocol");
    return sequence;
  }
  private eventBody(event: AgentEvent, appending: boolean) {
    const mask = this.redactShortApplicationText;
    const body = this.redact(JSON.stringify(event));
    if (event.kind === "message") {
      const scrubbed = JSON.parse(body) as typeof event;
      scrubbed.kind = event.kind;
      if (event.textMode !== undefined) scrubbed.textMode = event.textMode;
      if (event.responseKind !== undefined) scrubbed.responseKind = event.responseKind;
      if (!mask) return JSON.stringify(scrubbed);
      return JSON.stringify({
        ...scrubbed,
        text: appending && event.textMode === "delta" ? "" : maskText(event.text, scrubbed.text, mask),
        tools: scrubbed.tools.map((tool, index) => ({
          ...tool,
          name: maskText(event.tools[index]!.name, tool.name, mask),
          ...(tool.server !== undefined ? { server: maskText(event.tools[index]!.server!, tool.server, mask) } : {}),
          ...(tool.input !== undefined ? { input: maskPayload(tool.input, mask) } : {}),
          ...(tool.result ? { result: { ...tool.result, output: maskPayload(tool.result.output, mask) } } : {}),
        })),
      });
    }
    if (!mask || event.kind !== "other") return body;
    if (event.type === "armada/opencodeMcp") {
      const proof = JSON.parse(body) as typeof event & {
        data: { input?: unknown; result?: { output: unknown } };
      };
      if (proof.data?.input !== undefined) proof.data.input = maskPayload(proof.data.input, mask);
      if (proof.data?.result) proof.data.result.output = maskPayload(proof.data.result.output, mask);
      return JSON.stringify(proof);
    }
    if (event.type !== "harness_stderr") return body;
    const masked = JSON.parse(body) as { data?: { text?: unknown } | null };
    const original = (event.data as { text?: unknown } | null)?.text;
    if (typeof original === "string" && typeof masked.data?.text === "string")
      masked.data.text = maskText(original, masked.data.text, mask);
    return JSON.stringify(masked);
  }
  private sanitizeEvent(body: string) {
    let event: AgentEvent;
    try {
      event = JSON.parse(body);
    } catch {
      return this.redact(body);
    }
    return event?.kind === "message" || (event?.kind === "other" && event.type === "armada/opencodeMcp")
      ? this.eventBody(event, false)
      : this.redact(body);
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
  get(id: string): StoredPrompt | undefined {
    if (typeof id !== "string") return undefined;
    const row = this.db.query("SELECT body FROM prompts WHERE id=?").get(id) as { body: string } | null;
    if (!row) return undefined;
    const prompt = JSON.parse(row.body) as StoredPrompt;
    return prompt.promptId === id ? prompt : undefined;
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
      !(HARNESSES as readonly string[]).includes(harness) ||
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

  highWatermark(): number {
    return (this.db.query("SELECT coalesce(max(seq),0) AS n FROM events").get() as { n: number }).n;
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
  /** A sealed empty checkpoint is distinct from fresh or rolled-back storage. */
  requireCheckpoint(identity: CheckpointIdentity, watermark: number, conversationId: string | null) {
    const source = this.assertRestoreSource(identity);
    const seal = this.db
      .query("SELECT value FROM metadata WHERE key=?")
      .get(`checkpoint:v2:${checkpointIdentityKey(identity)}`) as { value: string } | null;
    const high = this.highWatermark();
    if (
      !source ||
      checkpointIdentityKey(source) !== checkpointIdentityKey(identity) ||
      seal?.value !== "complete" ||
      !Number.isSafeInteger(watermark) ||
      watermark < 0 ||
      high !== watermark ||
      this.ack !== watermark ||
      (conversationId === null
        ? this.prompts().length !== 0 || this.db.query("SELECT conversation FROM sessions LIMIT 1").get() !== null
        : !this.session(conversationId)) ||
      this.prompts().some((prompt) => !isFinalPromptStatus(prompt.status))
    )
      throw Error("resume_checkpoint_mismatch");
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
        // A batch is one row: retain O(largest body + its redacted copy), not
        // cumulative history. Prompts/requests/processes have no body-size cap.
        // Keyset reads finish before UPDATE; text preserves every SQLite rowid without numeric rounding.
        const first = this.db.query(`SELECT CAST(rowid AS TEXT) AS recordId,body FROM ${table} ORDER BY rowid LIMIT 1`);
        const next = this.db.query(
          `SELECT CAST(rowid AS TEXT) AS recordId,body FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1`,
        );
        const update = this.db.query(`UPDATE ${table} SET body=? WHERE rowid=?`);
        let cursor: string | undefined;
        for (;;) {
          const row = (cursor === undefined ? first.get() : next.get(cursor)) as {
            recordId: string;
            body: string;
          } | null;
          if (!row) break;
          update.run(table === "events" ? this.sanitizeEvent(row.body) : this.redact(row.body), row.recordId);
          cursor = row.recordId;
        }
      }
    })();
    // The full scan, WAL truncation and VACUUM still require cumulative I/O;
    // bounded retained bodies do not imply bounded latency or SQLite disk/cache use.
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
