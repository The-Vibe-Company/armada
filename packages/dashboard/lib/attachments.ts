import { createHash, randomUUID } from "node:crypto";
import {
  type ArmadaConfig,
  type Attachment,
  type AttachmentInput,
  CONFIG_DEFAULTS,
  checkAttachment,
  type Issue,
} from "@armada/core/read";
import { type Database, isoAt, type Queryable, text, transaction } from "./db";
import type { Scope } from "./fleet-data";

export class AttachmentRefusal extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const COLUMNS = "id, project, ticket, kind, content_type, size, sha256, caption, author, created_at, reference, url";
const metadata = (row: Record<string, unknown>): Attachment => ({
  id: String(row.id),
  project: String(row.project),
  ticket: String(row.ticket),
  kind: row.kind === "image" ? "image" : "link",
  contentType: text(row.content_type),
  size: Number(row.size),
  sha256: String(row.sha256),
  caption: text(row.caption),
  author: String(row.author),
  createdAt: isoAt(row.created_at),
  reference: text(row.reference),
  url: text(row.url),
});

export async function attachmentProjectAllowed(db: Queryable, project: string, scope: Scope): Promise<boolean> {
  const result = await db.query("SELECT organization_id FROM projects WHERE slug = $1", [project]);
  const row = result.rows[0];
  return (
    !!row &&
    (row.organization_id === scope.organization || (row.organization_id === null && scope.home === scope.organization))
  );
}

export async function listTicketAttachments(
  db: Queryable,
  scope: Scope,
  project: string,
  ticket: string,
): Promise<Attachment[] | null> {
  if (!(await attachmentProjectAllowed(db, project, scope))) return null;
  return (
    await db.query(`SELECT ${COLUMNS} FROM attachments WHERE project = $1 AND ticket = $2 ORDER BY created_at, id`, [
      project,
      ticket.toUpperCase(),
    ])
  ).rows.map(metadata);
}

/** The attachments of some tickets of one project, metadata only: what a validation's gallery shows (THE-885). */
export async function ticketsAttachments(db: Queryable, project: string, tickets: string[]): Promise<Attachment[]> {
  if (!tickets.length) return [];
  return (
    await db.query(
      `SELECT ${COLUMNS} FROM attachments WHERE project = $1 AND ticket = ANY($2::text[]) ORDER BY created_at, id`,
      [project, tickets],
    )
  ).rows.map(metadata);
}

export async function readAttachment(
  db: Queryable,
  scope: Scope,
  id: string,
): Promise<{ attachment: Attachment; bytes: Uint8Array | null } | null> {
  const result = await db.query(
    `SELECT ${COLUMNS}, bytes FROM attachments WHERE id = $1 AND project IN
    (SELECT slug FROM projects WHERE organization_id = $2 OR (organization_id IS NULL AND $2 = $3))`,
    [id, scope.organization, scope.home],
  );
  const row = result.rows[0];
  return row
    ? { attachment: metadata(row), bytes: row.bytes == null ? null : new Uint8Array(row.bytes as Uint8Array) }
    : null;
}

export async function saveAttachment(
  db: Database,
  target: {
    project: string;
    ticket: string;
    input: AttachmentInput;
    caption: string | null;
    reference: string | null;
    author: string;
    now: Date;
    policy: ArmadaConfig["policy"];
    doneAt?: string | null;
  },
): Promise<Attachment> {
  const refusal = checkAttachment(target.input);
  if (refusal)
    throw new AttachmentRefusal(
      refusal,
      target.input.kind === "image" && target.input.bytes.length > 2 * 1024 * 1024 ? 413 : 400,
    );
  if ((target.caption?.length ?? 0) > 2000)
    throw new AttachmentRefusal("attachment caption size limit: 2000 characters");
  if ((target.reference?.length ?? 0) > 256)
    throw new AttachmentRefusal("attachment --for reference size limit: 256 characters");
  const bytes = target.input.kind === "image" ? Buffer.from(target.input.bytes) : null;
  const sha256 = createHash("sha256")
    .update(bytes ?? (target.input.kind === "link" ? target.input.url : ""))
    .digest("hex");
  return transaction(db, async (tx) => {
    const project = await tx.query("SELECT slug FROM projects WHERE slug = $1 FOR UPDATE", [target.project]);
    if (!project.rows.length) throw new AttachmentRefusal("attachment ticket limit: project is not registered", 403);
    const existing = await tx.query(
      `SELECT ${COLUMNS} FROM attachments WHERE project = $1 AND ticket = $2 AND sha256 = $3`,
      [target.project, target.ticket, sha256],
    );
    if (existing.rows[0]) {
      if (target.reference !== null)
        await tx.query("UPDATE attachments SET reference = $2 WHERE id = $1", [existing.rows[0].id, target.reference]);
      return { ...metadata(existing.rows[0]), reference: target.reference ?? text(existing.rows[0].reference) };
    }
    const totals = (
      await tx.query(
        "SELECT count(*) FILTER (WHERE ticket = $2) AS count, COALESCE(sum(size), 0) AS size FROM attachments WHERE project = $1",
        [target.project, target.ticket],
      )
    ).rows[0];
    const countLimit = target.policy.attachmentsPerTicket ?? CONFIG_DEFAULTS.attachmentsPerTicket;
    const sizeLimit = target.policy.attachmentsProjectMb ?? CONFIG_DEFAULTS.attachmentsProjectMb;
    if (Number(totals?.count) >= countLimit)
      throw new AttachmentRefusal(`attachment count limit: ${countLimit} per ticket`, 409);
    if (Number(totals?.size) + (bytes?.length ?? 0) > sizeLimit * 1024 * 1024)
      throw new AttachmentRefusal(`attachment project size limit: ${sizeLimit} MB`, 409);
    const result = await tx.query(
      `INSERT INTO attachments (id, project, ticket, kind, bytes, content_type, size, sha256, caption, author, created_at, reference, url, done_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        target.project,
        target.ticket,
        target.input.kind,
        bytes,
        target.input.kind === "image" ? target.input.contentType : null,
        bytes?.length ?? 0,
        sha256,
        target.caption,
        target.author,
        target.now,
        target.reference,
        target.input.kind === "link" ? target.input.url : null,
        target.doneAt ?? null,
      ],
    );
    return metadata(result.rows[0] ?? {});
  });
}

export async function pruneAttachments(
  db: Queryable,
  project: string,
  issues: Pick<Issue, "id" | "statusType" | "completedAt" | "canceledAt">[],
  days: number,
  now: Date,
): Promise<number> {
  const states = issues.map((issue) => ({
    ticket: issue.id,
    done: ["completed", "canceled"].includes(issue.statusType),
    at: issue.completedAt ?? issue.canceledAt,
  }));
  await db.query(
    `UPDATE attachments AS attachment SET done_at = CASE WHEN state.done THEN COALESCE(state.at, attachment.done_at, $3) ELSE NULL END
    FROM jsonb_to_recordset($2::jsonb) AS state(ticket text, done boolean, at timestamptz)
    WHERE attachment.project = $1 AND attachment.ticket = state.ticket`,
    [project, JSON.stringify(states), now],
  );
  return (
    await db.query("DELETE FROM attachments WHERE project = $1 AND done_at <= $2", [
      project,
      new Date(now.getTime() - days * 86400_000),
    ])
  ).rowCount;
}

export async function serveAttachment(db: Queryable, scope: Scope | null, id: string): Promise<Response> {
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  const found = scope ? await readAttachment(db, scope, id) : null;
  if (!found)
    return Response.json(
      { error: "organization membership is required for this attachment" },
      { status: 403, headers },
    );
  if (found.attachment.kind === "link")
    return new Response(null, { status: 303, headers: { ...headers, Location: found.attachment.url ?? "" } });
  return new Response(found.bytes ? new Uint8Array(found.bytes) : null, {
    headers: {
      ...headers,
      "Content-Type": found.attachment.contentType ?? "application/octet-stream",
      "Content-Disposition": 'inline; filename="attachment"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
