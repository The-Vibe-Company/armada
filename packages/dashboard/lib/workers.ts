// Workers launched with a one-time launch token (THE-841). A signed-in
// coordinator asks for a token when it prepares a worker (`armada brief`); the
// token is bound to the organization, the project, the ticket and whoever
// launched it, is used once and expires after an hour. The worker's first
// command exchanges it for a worker session, limited to its ticket, which each
// of its commands renews, and which ends on release, merge or revocation.
// Only hashes of both tokens are stored. Every launch, exchange and end is in
// the organization's audit list (`vault.ts`), never with a token. Everything is
// injected so tests run it on PGlite.
import { createHash, randomBytes } from "node:crypto";
import { type Database, isoAt, iso as isoOrNull, type Queryable, type Row, transaction } from "./db";
import { type Actor, recordEvent } from "./vault";

/** Every launch token starts with it, so a leaked one is recognisable. */
export const LAUNCH_TOKEN_PREFIX = "armada_launch_";
/** Every worker session token starts with it: the CLI API tells it from a person's session by it. */
export const WORKER_TOKEN_PREFIX = "armada_worker_";
/** How long a launch token waits to be used. */
export const LAUNCH_TOKEN_MS = 60 * 60 * 1000;
/** A worker session unused this long ends on its own; each of its commands starts the count again. */
export const WORKER_IDLE_MS = 72 * 60 * 60 * 1000;
/** Exchange attempts per address per minute. */
export const EXCHANGES_PER_MINUTE = 10;
/** What a worker session may do, on its own ticket only. */
export const WORKER_COMMANDS = ["claim", "report", "ask", "validate", "release"] as const;
export type WorkerCommand = (typeof WORKER_COMMANDS)[number];
export const isWorkerCommand = (v: unknown): v is WorkerCommand => WORKER_COMMANDS.includes(v as WorkerCommand);

export const isTicketId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(v);
export const isProjectSlug = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);

export type EndReason = "released" | "merged" | "revoked" | "expired";

/** Who launched a worker: a person's terminal, or an organization API key. */
export interface Launcher {
  kind: "session" | "api-key";
  id: string;
  label: string;
}

/** One launch, as the dashboard lists it. Carries no token. */
export interface Worker {
  id: string;
  organization: string;
  project: string;
  ticket: string;
  coordinator?: string | null;
  launchedBy: Launcher;
  createdAt: string;
  tokenExpiresAt: string;
  tokenUsedAt: string | null;
  sessionExpiresAt: string | null;
  sessionSeenAt: string | null;
  endedAt: string | null;
  endReason: EndReason | null;
  endedBy: string | null;
  /** The runtime and session bound at launch, or reported at sign-in when unbound. */
  runtime: string | null;
  /** A sign-in mismatch, read from the audit event on the launch list only. */
  runtimeMismatch?: string | null;
  handle: string | null;
}

/**
 * Where a launch stands: its token `waiting` to be used or `unused` past its
 * hour; its session `active`, or `idle` past its idle time; or ended.
 */
export type WorkerState = "waiting" | "unused" | "active" | "idle" | EndReason;

export function workerState(w: Worker, now: Date): WorkerState {
  if (w.endReason) return w.endReason;
  const t = now.toISOString();
  if (!w.tokenUsedAt) return w.tokenExpiresAt > t ? "waiting" : "unused";
  return w.sessionExpiresAt && w.sessionExpiresAt > t ? "active" : "idle";
}

/** The person whose own keys a worker receives; null when an API key launched it. */
export const launchingUser = (w: Worker) => (w.launchedBy.kind === "session" ? w.launchedBy.id : null);

/** How the audit list names a worker. */
export const workerActor = (w: Worker): Actor => ({
  kind: "worker",
  id: w.id,
  label: `worker on ${w.ticket} (launched by ${w.launchedBy.label})`,
});

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const hhmm = (iso: string) => `${iso.slice(0, 16)}Z`;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const COLUMNS = `"id", "organizationId", "project", "ticket", "launchedByKind", "launchedById", "launchedByLabel",
  "createdAt", "tokenExpiresAt", "tokenUsedAt", "sessionExpiresAt", "sessionSeenAt", "endedAt", "endReason", "endedByLabel", "runtime", "runtimeHandle", "coordinator"`;

function workerOf(r: Row): Worker {
  const reason = str(r.endReason);
  return {
    id: String(r.id),
    organization: String(r.organizationId),
    project: String(r.project),
    ticket: String(r.ticket),
    coordinator: str(r.coordinator),
    launchedBy: {
      kind: String(r.launchedByKind) === "api-key" ? "api-key" : "session",
      id: String(r.launchedById),
      label: String(r.launchedByLabel),
    },
    createdAt: isoAt(r.createdAt),
    tokenExpiresAt: isoAt(r.tokenExpiresAt),
    tokenUsedAt: isoOrNull(r.tokenUsedAt),
    sessionExpiresAt: isoOrNull(r.sessionExpiresAt),
    sessionSeenAt: isoOrNull(r.sessionSeenAt),
    endedAt: isoOrNull(r.endedAt),
    endReason:
      reason === "released" || reason === "merged" || reason === "revoked" || reason === "expired" ? reason : null,
    endedBy: str(r.endedByLabel),
    runtime: str(r.runtime),
    handle: str(r.runtimeHandle),
    ...(r.runtimeMismatch !== undefined ? { runtimeMismatch: str(r.runtimeMismatch) } : {}),
  };
}

// ------------------------------------------------------------ launch

/** Makes a launch token for one ticket. The token is returned once and only its hash is kept. */
export async function createLaunch(
  client: Database,
  input: {
    organization: string;
    project: string;
    ticket: string;
    launcher: Launcher;
    coordinator?: string | null;
    now: Date;
  },
): Promise<{ worker: Worker; token: string }> {
  const token = newToken(LAUNCH_TOKEN_PREFIX);
  const at = input.now.toISOString();
  const expires = new Date(input.now.getTime() + LAUNCH_TOKEN_MS).toISOString();
  const id = `wk_${randomBytes(9).toString("base64url")}`;
  const ticket = input.ticket.toUpperCase();
  await client.query(
    `INSERT INTO coordinators (project, name, created_at, created_by, started_at, seen_at)
     SELECT slug, $2, $3, $4, $3, $3 FROM projects WHERE slug = $1 AND organization_id = $5 AND $2::text IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [
      input.project,
      input.coordinator === undefined ? "default" : input.coordinator,
      input.now,
      input.launcher.id,
      input.organization,
    ],
  );
  await client.query(
    `INSERT INTO "armada_worker" ("id", "organizationId", "project", "ticket", "launchedByKind", "launchedById",
       "launchedByLabel", "createdAt", "tokenHash", "tokenExpiresAt", "coordinator")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      input.organization,
      input.project,
      ticket,
      input.launcher.kind,
      input.launcher.id,
      input.launcher.label,
      at,
      hashOf(token),
      expires,
      input.coordinator === undefined ? "default" : input.coordinator,
    ],
  );
  await recordEvent(client, input.organization, {
    at,
    action: "launch",
    project: input.project,
    keys: [],
    actor: { kind: input.launcher.kind, id: input.launcher.id, label: input.launcher.label },
    detail: `launch token for ${input.project} ${ticket}, to use before ${hhmm(expires)}`,
  });
  const worker: Worker = {
    id,
    organization: input.organization,
    project: input.project,
    ticket,
    coordinator: input.coordinator === undefined ? "default" : input.coordinator,
    launchedBy: input.launcher,
    createdAt: at,
    tokenExpiresAt: expires,
    tokenUsedAt: null,
    sessionExpiresAt: null,
    sessionSeenAt: null,
    endedAt: null,
    endReason: null,
    endedBy: null,
    runtime: null,
    handle: null,
  };
  return { worker, token };
}

/** Bind the launch to one runtime session, even before the worker signs in. */
export async function bindLaunch(
  client: Database,
  input: { organization: string; project: string; ticket: string; id: string; runtime: string; handle: string },
): Promise<"bound" | "conflict" | "gone"> {
  return transaction(client, async (tx) => {
    const args = [input.id, input.organization, input.project, input.ticket.toUpperCase()];
    const found = await tx.query(
      `SELECT ${COLUMNS} FROM "armada_worker"
       WHERE "id" = $1 AND "organizationId" = $2 AND "project" = $3 AND "ticket" = $4 FOR UPDATE`,
      args,
    );
    const row = found.rows[0];
    if (!row || row.endedAt) return "gone";
    if (row.runtimeHandle !== null) {
      if (row.runtimeHandle !== input.handle || (row.runtime !== null && row.runtime !== input.runtime))
        return "conflict";
      if (row.runtime === input.runtime) return "bound";
      // A fast worker may sign in before the coordinator receives the launch result.
      // The matching handle permits filling its still-unknown runtime.
    }
    await tx.query(
      `UPDATE "armada_worker" SET "runtime" = $5, "runtimeHandle" = $6
       WHERE "id" = $1 AND "organizationId" = $2 AND "project" = $3 AND "ticket" = $4
         AND "endedAt" IS NULL AND ("runtimeHandle" IS NULL OR ("runtimeHandle" = $6 AND "runtime" IS NULL))`,
      [...args, input.runtime, input.handle],
    );
    return "bound";
  });
}

// ------------------------------------------------------------ exchange

export type ExchangeRefusal = "limited" | "unknown" | "used" | "expired" | "ended";

export type Exchange =
  | { ok: true; worker: Worker; token: string }
  | { ok: false; reason: ExchangeRefusal; worker: Worker | null };

/** Counts this attempt and says whether the address made too many in the last minute. */
async function tooManyAttempts(client: Database, address: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  // Old attempts count for nothing: they go.
  await client.query(`DELETE FROM "armada_launch_attempt" WHERE "at" < $1`, [
    new Date(now.getTime() - 3_600_000).toISOString(),
  ]);
  await client.query(`INSERT INTO "armada_launch_attempt" ("address", "at") VALUES ($1, $2)`, [
    address.slice(0, 64),
    at,
  ]);
  const rs = await client.query(
    `SELECT count(*)::int AS n FROM "armada_launch_attempt" WHERE "address" = $1 AND "at" > $2`,
    [address.slice(0, 64), new Date(now.getTime() - 60_000).toISOString()],
  );
  return Number(rs.rows[0]?.n ?? 0) > EXCHANGES_PER_MINUTE;
}

/**
 * Exchanges a launch token for a worker session, once: a second use, a use
 * after its hour, or after the launch was revoked, is refused. Every outcome
 * with a known token is in the audit list. `handle` is the worker's runtime
 * session when its environment names one: a launch that never claims shows it.
 */
export async function exchangeLaunch(
  client: Database,
  input: { token: string; address: string; handle?: string | null; now: Date },
): Promise<Exchange> {
  const { now } = input;
  if (await tooManyAttempts(client, input.address, now)) return { ok: false, reason: "limited", worker: null };
  if (!input.token.startsWith(LAUNCH_TOKEN_PREFIX) || input.token.length > 200)
    return { ok: false, reason: "unknown", worker: null };
  const rs = await client.query(`SELECT ${COLUMNS} FROM "armada_worker" WHERE "tokenHash" = $1`, [hashOf(input.token)]);
  const row = rs.rows[0];
  if (!row) return { ok: false, reason: "unknown", worker: null };
  const found = workerOf(row);
  const at = now.toISOString();
  const refuse = async (reason: Exclude<ExchangeRefusal, "limited" | "unknown">, why: string): Promise<Exchange> => {
    await recordEvent(client, found.organization, {
      at,
      action: "exchange",
      project: found.project,
      keys: [],
      actor: workerActor(found),
      detail: `launch token for ${found.project} ${found.ticket} refused: ${why}`,
    });
    return { ok: false, reason, worker: found };
  };
  if (found.endReason) return refuse("ended", `the launch was ${found.endReason}`);
  if (found.tokenUsedAt) return refuse("used", `already used at ${hhmm(found.tokenUsedAt)}`);
  if (found.tokenExpiresAt <= at) return refuse("expired", `expired at ${hhmm(found.tokenExpiresAt)}`);

  const token = newToken(WORKER_TOKEN_PREFIX);
  const expires = new Date(now.getTime() + WORKER_IDLE_MS).toISOString();
  const handle = input.handle?.trim().slice(0, 500) || null;
  // One conditional write: of two exchanges racing, one wins.
  const won = await client.query(
    `UPDATE "armada_worker" SET "tokenUsedAt" = $1, "sessionHash" = $2, "sessionExpiresAt" = $3, "sessionSeenAt" = $1,
       "runtimeHandle" = COALESCE("runtimeHandle", $5)
     WHERE "id" = $4 AND "tokenUsedAt" IS NULL AND "endedAt" IS NULL AND "tokenExpiresAt" > $1 RETURNING ${COLUMNS}`,
    [at, hashOf(token), expires, found.id, handle],
  );
  if (won.rowCount !== 1 || !won.rows[0]) return refuse("used", "used by another exchange at the same time");
  const worker = workerOf(won.rows[0]);
  const mismatch = handle && worker.handle !== handle;
  await recordEvent(client, found.organization, {
    at,
    action: "exchange",
    project: found.project,
    keys: [],
    actor: workerActor(worker),
    detail: mismatch
      ? `runtime session mismatch for ${found.project} ${found.ticket}: reported ${handle}; kept ${worker.runtime ?? "unknown"} ${worker.handle}`
      : `launch token for ${found.project} ${found.ticket} used; worker session started`,
  });
  return { ok: true, worker, token };
}

// ------------------------------------------------------------ session

export type WorkerLookup = { ok: true; worker: Worker } | { ok: false; worker: Worker | null };

/** Whether a bearer token is a worker session's, by its prefix. */
export const isWorkerToken = (token: string) => token.startsWith(WORKER_TOKEN_PREFIX);

/**
 * The worker behind a session token, renewed for another idle period. Not ok
 * when unknown, ended or idle past its time; `worker` then says which, when known.
 */
export async function workerSession(client: Database, token: string, now: Date): Promise<WorkerLookup> {
  const rs = await client.query(`SELECT ${COLUMNS} FROM "armada_worker" WHERE "sessionHash" = $1`, [hashOf(token)]);
  const row = rs.rows[0];
  if (!row) return { ok: false, worker: null };
  const worker = workerOf(row);
  if (workerState(worker, now) !== "active") {
    if (!worker.endedAt && worker.tokenUsedAt)
      await endWorker(client, {
        organization: worker.organization,
        id: worker.id,
        reason: "expired",
        by: { kind: "dashboard", id: "", label: "Armada (session expired)" },
        now,
      });
    return { ok: false, worker };
  }
  const at = now.toISOString();
  const expires = new Date(now.getTime() + WORKER_IDLE_MS).toISOString();
  await client.query(
    `UPDATE "armada_worker" SET "sessionExpiresAt" = $1, "sessionSeenAt" = $2 WHERE "id" = $3 AND "endedAt" IS NULL`,
    [expires, at, worker.id],
  );
  return { ok: true, worker: { ...worker, sessionExpiresAt: expires, sessionSeenAt: at } };
}

async function end(
  client: Queryable,
  where: { sql: string; args: (string | null)[] },
  input: { organization: string; reason: EndReason; by: Actor; now: Date },
): Promise<Worker[]> {
  if ("connect" in client) return transaction(client as Database, (tx) => end(tx, where, input));
  const rs = await client.query(
    `SELECT ${COLUMNS} FROM "armada_worker" WHERE "organizationId" = $1 AND "endedAt" IS NULL AND ${where.sql}`,
    [input.organization, ...where.args],
  );
  const at = input.now.toISOString();
  const ended: Worker[] = [];
  for (const row of rs.rows) {
    const w = workerOf(row);
    // Claims and releases lock the project first too, so ending a worker cannot
    // race a replacement claim or invert the handle/session lock order.
    await client.query("SELECT slug FROM projects WHERE slug = $1 FOR NO KEY UPDATE", [w.project]);
    const done = await client.query(
      `UPDATE "armada_worker" SET "endedAt" = $1, "endReason" = $2, "endedByLabel" = $3 WHERE "id" = $4 AND "endedAt" IS NULL${input.reason === "expired" ? ' AND (("tokenUsedAt" IS NULL AND "tokenExpiresAt" <= $1) OR "sessionExpiresAt" <= $1)' : ""}`,
      [at, input.reason, input.by.label, w.id],
    );
    if (done.rowCount !== 1) continue;
    const handles = await client.query(
      `UPDATE runtime_handles SET released_at = $4 WHERE project = $1 AND ticket = $2
       AND worker_session_id = $3 AND released_at IS NULL RETURNING handle, claimed_at`,
      [w.project, w.ticket, w.id, at],
    );
    for (const h of handles.rows) {
      await client.query(
        `UPDATE fleet_sessions SET released_at = $5 WHERE project = $1 AND ticket = $2
         AND handle = $3 AND claimed_at = $4 AND released_at IS NULL`,
        [w.project, w.ticket, h.handle, h.claimed_at, at],
      );
      await client.query("DELETE FROM worker_profiles WHERE project = $1 AND ticket = $2", [w.project, w.ticket]);
      await client.query(
        `INSERT INTO events (project, ticket, kind, runtime, handle, message, created_at)
         SELECT $1, $2, 'release', runtime, handle, $3, $4 FROM runtime_handles
         WHERE project = $1 AND ticket = $2 AND worker_session_id = $5`,
        [w.project, w.ticket, `worker session ${input.reason}`, at, w.id],
      );
    }
    ended.push({ ...w, endedAt: at, endReason: input.reason, endedBy: input.by.label });
    await recordEvent(client, input.organization, {
      at,
      action: "end",
      project: w.project,
      keys: [],
      actor: input.by,
      detail: `${w.tokenUsedAt ? "worker session" : "unused launch token"} of ${w.project} ${w.ticket} ${input.reason}`,
    });
  }
  return ended;
}

/** Ends one launch of the organization: its session, or its token if still unused. Null when there was none to end. */
export async function endWorker(
  client: Queryable,
  input: { organization: string; id: string; reason: EndReason; by: Actor; now: Date },
): Promise<Worker | null> {
  return (await end(client, { sql: `"id" = $2`, args: [input.id] }, input))[0] ?? null;
}

export async function revokePendingLaunch(
  client: Database,
  input: { organization: string; project: string; ticket: string; id?: string; by: Actor; now: Date },
): Promise<{ worker: Worker } | { reason: "claimed" | "gone" }> {
  return transaction(client, async (tx) => {
    const found = await tx.query(
      `SELECT ${COLUMNS} FROM "armada_worker" WHERE "organizationId" = $1 AND "project" = $2 AND "ticket" = $3${input.id ? ' AND "id" = $4' : ""}
       ORDER BY "createdAt" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [input.organization, input.project, input.ticket.toUpperCase(), ...(input.id ? [input.id] : [])],
    );
    const row = found.rows[0];
    if (!row || row.endedAt) return { reason: "gone" };
    const worker = workerOf(row);
    // An unused specific token cannot have claimed. Another launch's claim must
    // not prevent ending it. Exchange and revoke lock the same worker row.
    if (input.id && !worker.tokenUsedAt) {
      const ended = await endWorker(tx, { ...input, id: worker.id, reason: "revoked" });
      return ended ? { worker: ended } : { reason: "gone" };
    }
    const held = await tx.query(
      `SELECT 1 FROM runtime_handles WHERE project = $1 AND ticket = $2 AND released_at IS NULL
       UNION ALL SELECT 1 FROM events WHERE project = $1 AND ticket = $2 AND kind = 'claim' AND created_at >= $3 LIMIT 1`,
      [input.project, worker.ticket, worker.createdAt],
    );
    if (held.rows.length) return { reason: "claimed" };
    const ended = await endWorker(tx, { ...input, id: worker.id, reason: "revoked" });
    return ended ? { worker: ended } : { reason: "gone" };
  });
}

/** Ends every launch of a ticket: its pull request merged, or the ticket released. */
export async function endTicketWorkers(
  client: Database,
  input: {
    organization: string;
    project: string;
    ticket: string;
    reason: EndReason;
    by: Actor;
    now: Date;
    claimedAt?: string | null;
  },
): Promise<Worker[]> {
  return end(
    client,
    {
      sql: `"project" = $2 AND "ticket" = $3${input.claimedAt ? ' AND "createdAt" <= $4::timestamptz' : ""}`,
      args: [input.project, input.ticket.toUpperCase(), ...(input.claimedAt ? [input.claimedAt] : [])],
    },
    input,
  );
}

/** The organization's launches, newest first. */
export async function listWorkers(client: Database, organization: string, limit = 100): Promise<Worker[]> {
  const rs = await client.query(
    `SELECT w.*, mismatch."detail" AS "runtimeMismatch" FROM (
       SELECT ${COLUMNS} FROM "armada_worker" WHERE "organizationId" = $1 ORDER BY "createdAt" DESC, "id" LIMIT $2
     ) w LEFT JOIN LATERAL (
       SELECT "detail" FROM "armada_secret_event" WHERE "organizationId" = $1
         AND "actorKind" = 'worker' AND "actorId" = w."id" AND "action" = 'exchange'
         AND "detail" LIKE 'runtime session mismatch%'
       ORDER BY "at" DESC, "id" DESC LIMIT 1
     ) mismatch ON true ORDER BY w."createdAt" DESC, w."id"`,
    [organization, limit],
  );
  return rs.rows.map(workerOf);
}
