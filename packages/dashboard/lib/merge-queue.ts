// Durable merge intent only. GitHub and Linear writes stay in the coordinator CLI.
import {
  MERGE_QUEUE_LEASE,
  type QueueAdded,
  type QueueEntry,
  type QueueFinish,
  type QueueInput,
  type QueueNext,
} from "@armada/core/read";
import { type Database, iso, isoAt, type Queryable, type Row, transaction } from "./db";
import { addInboxItem, getLease } from "./fleet-store";

const OPEN = "state IN ('queued','merging')";
const entryOf = (r: Row): QueueEntry => ({
  id: Number(r.id),
  project: String(r.project),
  pr: Number(r.pr),
  ticket: r.ticket == null ? null : String(r.ticket),
  noTicket: Boolean(r.no_ticket),
  keepOpen: Boolean(r.keep_open),
  throughHold: r.through_hold == null ? null : String(r.through_hold),
  reason: r.reason == null ? null : String(r.reason),
  headSha: String(r.head_sha),
  queuedBy: String(r.queued_by),
  state: r.state as QueueEntry["state"],
  detail: r.detail == null ? null : String(r.detail),
  attempts: Number(r.attempts),
  notBefore: iso(r.not_before),
  queuedAt: isoAt(r.queued_at),
  updatedAt: isoAt(r.updated_at),
  mergeCommit: r.merge_commit == null ? null : String(r.merge_commit),
  finishedAt: iso(r.finished_at),
});

export async function queueAdd(db: Database, e: QueueInput & { project: string; at: Date }): Promise<QueueAdded> {
  return transaction(db, async (tx) => {
    // Serialize enqueue/removal so the returned position describes the committed order.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('merge-queue'))", [e.project]);
    const rs = await tx.query(
      `INSERT INTO merge_queue
      (project, pr, ticket, no_ticket, keep_open, through_hold, reason, head_sha, state, queued_by, queued_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$10)
      ON CONFLICT (project, pr) WHERE ${OPEN} DO NOTHING RETURNING id`,
      [e.project, e.pr, e.ticket, e.noTicket, e.keepOpen, e.throughHold, e.reason, e.headSha, e.queuedBy, e.at],
    );
    if (!rs.rows[0]) {
      const existing = (
        await tx.query(`SELECT * FROM merge_queue WHERE project = $1 AND pr = $2 AND ${OPEN}`, [e.project, e.pr])
      ).rows[0];
      if (!existing) throw new Error("merge queue conflict without an open entry");
      return { existing: entryOf(existing) };
    }
    const id = Number(rs.rows[0].id);
    const count = await tx.query(
      `SELECT count(*) AS position FROM merge_queue WHERE project = $1 AND ${OPEN}
      AND (queued_at, id) <= ($2, $3)`,
      [e.project, e.at, id],
    );
    return { id, position: Number(count.rows[0]?.position) };
  });
}
export async function queueList(db: Queryable, project: string, opts: { since: Date }): Promise<QueueEntry[]> {
  const rs = await db.query(
    `SELECT * FROM merge_queue WHERE project = $1 AND ${OPEN}
    UNION ALL SELECT * FROM merge_queue WHERE project = $1 AND finished_at >= $2
    ORDER BY queued_at, id`,
    [project, opts.since],
  );
  return rs.rows.map(entryOf);
}
async function heldLease(tx: Queryable, q: { project: string; holder: string; at: Date }) {
  await tx.query("SELECT holder FROM leases WHERE project = $1 AND name = $2 FOR UPDATE", [
    q.project,
    MERGE_QUEUE_LEASE,
  ]);
  const held = await getLease(tx, q.project, MERGE_QUEUE_LEASE);
  return { held, ours: !!held && held.holder === q.holder && Date.parse(held.expiresAt) > q.at.getTime() };
}
export async function queueNext(db: Database, q: { project: string; holder: string; at: Date }): Promise<QueueNext> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('merge-queue'))", [q.project]);
    const { held, ours } = await heldLease(tx, q);
    if (!ours) return { refused: true, held };
    // Recover an entry stranded by a lost session before starting another merge.
    const rs = await tx.query(
      `SELECT * FROM merge_queue WHERE project = $1
      AND state IN ('merging', 'queued')
      ORDER BY (state = 'merging') DESC, queued_at, id LIMIT 1 FOR UPDATE`,
      [q.project],
    );
    const row = rs.rows[0];
    if (!row || (row.state === "queued" && row.not_before && Date.parse(isoAt(row.not_before)) > q.at.getTime()))
      return { entry: null, holds: [] };
    const updated = await tx.query(
      "UPDATE merge_queue SET state = 'merging', updated_at = $2 WHERE id = $1 RETURNING *",
      [row.id, q.at],
    );
    const entry = updated.rows[0];
    if (!entry) throw new Error("merge queue entry disappeared while locked");
    return { entry: entryOf(entry), holds: [] };
  });
}
export async function queueFinish(db: Database, q: QueueFinish & { project: string; at: Date }): Promise<boolean> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('merge-queue'))", [q.project]);
    if (!(await heldLease(tx, q)).ours) return false;
    const rs = await tx.query(
      `UPDATE merge_queue SET state = $3, detail = $4, updated_at = $5,
      attempts = attempts + $6, not_before = $7, merge_commit = $8, finished_at = $9
      WHERE project = $1 AND id = $2 AND state = 'merging' RETURNING *`,
      [
        q.project,
        q.id,
        q.outcome === "retry" || q.outcome === "paused" ? "queued" : q.outcome,
        q.detail,
        q.at,
        q.outcome === "retry" ? 1 : 0,
        q.outcome === "retry" ? (q.notBefore ?? null) : null,
        q.mergeCommit ?? null,
        q.outcome === "retry" || q.outcome === "paused" ? null : q.at,
      ],
    );
    const row = rs.rows[0];
    if (!row) return false;
    if (q.outcome === "refused")
      await addInboxItem(tx, {
        project: q.project,
        ticket: row.ticket == null ? null : String(row.ticket),
        kind: "queue-refused",
        recipient: "coordinator",
        author: q.holder,
        body: `PR #${row.pr} refused: ${q.detail ?? "merge refused"}`,
        at: q.at,
      });
    return true;
  });
}
export async function queueRemove(db: Database, q: { project: string; pr: number; at: Date }): Promise<boolean> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('merge-queue'))", [q.project]);
    const rs = await tx.query(
      "UPDATE merge_queue SET state = 'removed', updated_at = $3, finished_at = $3 WHERE project = $1 AND pr = $2 AND state = 'queued'",
      [q.project, q.pr, q.at],
    );
    return rs.rowCount > 0;
  });
}
