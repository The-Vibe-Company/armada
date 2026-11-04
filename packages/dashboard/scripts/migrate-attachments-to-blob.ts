// Run only after the additive schema migration and deployment, with the owner's approval.
// Credentials come exclusively from the environment; errors never echo provider messages.
import { createHash } from "node:crypto";
import { type AttachmentBlobs, attachmentBlobs, attachmentStorageKey } from "../lib/attachment-blobs";
import { type Database, databaseUrlOf, openDatabase, transaction } from "../lib/db";

const CANDIDATES = "kind = 'image' AND storage_key IS NULL AND bytes IS NOT NULL";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Candidate = {
  id: string;
  project: string;
  sha256: string;
  content_type: string;
  size: number;
  bytes: Uint8Array;
};

async function verifiedBlob(blobs: AttachmentBlobs, key: string, row: Candidate): Promise<boolean> {
  const stream = await blobs.get(key, false);
  if (!stream) return false;
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > Number(row.size)) {
        await reader.cancel();
        return false;
      }
      hash.update(part.value);
    }
    return size === Number(row.size) && hash.digest("hex") === row.sha256;
  } finally {
    reader.releaseLock();
  }
}

export async function migrateAttachmentsToBlob(
  db: Database,
  options: {
    dryRun?: boolean;
    batchSize?: number;
    blobs?: AttachmentBlobs;
    log?: (message: string) => void;
    now?: () => Date;
  } = {},
) {
  const {
    dryRun = false,
    batchSize = 50,
    blobs = attachmentBlobs,
    log = console.log,
    now = () => new Date(),
  } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("batch size must be an integer from 1 to 1000");
  const summary = { migrated: 0, skipped: 0, mismatches: 0, remaining: 0, wouldMigrate: 0 };
  let cursor = "";
  while (true) {
    const batch = await db.query<Candidate>(
      `SELECT id, project, sha256, content_type, size, bytes FROM attachments
       WHERE ${CANDIDATES} AND id > $1 ORDER BY id LIMIT $2`,
      [cursor, batchSize],
    );
    if (!batch.rows.length) break;
    for (const candidate of batch.rows) {
      cursor = candidate.id;
      try {
        if (digest(candidate.bytes) !== candidate.sha256 || candidate.bytes.byteLength !== Number(candidate.size)) {
          summary.mismatches++;
          log(`Mismatch ${candidate.id}: database sha256 or size; skipped`);
          continue;
        }
        const key = attachmentStorageKey(candidate.project, candidate.sha256);
        if (dryRun) {
          summary.wouldMigrate++;
          log(`Would migrate ${candidate.id} (${candidate.size} bytes)`);
          continue;
        }
        const outcome = await transaction(db, async (tx) => {
          // Same lock as save/prune: a deleted row cannot leave a dangling storage pointer.
          await tx.query("SELECT slug FROM projects WHERE slug = $1 FOR UPDATE", [candidate.project]);
          const fresh = await tx.query<Candidate>(
            `SELECT id, project, sha256, content_type, size, bytes FROM attachments WHERE id = $1 AND ${CANDIDATES}`,
            [candidate.id],
          );
          const row = fresh.rows[0];
          if (!row) return "skipped";
          if (digest(row.bytes) !== row.sha256 || row.bytes.byteLength !== Number(row.size)) return "mismatches";
          await blobs.put(key, row.bytes, row.content_type);
          if (!(await verifiedBlob(blobs, key, row))) return "mismatches";
          await tx.query("UPDATE attachments SET storage_key = $2, stored_at = $3 WHERE id = $1", [row.id, key, now()]);
          return "migrated";
        });
        summary[outcome]++;
        log(`${outcome} ${candidate.id}`);
      } catch {
        summary.skipped++;
        log(`Skipped ${candidate.id}: upload, verification or database operation failed; safe to retry`);
      }
    }
  }
  const remaining = await db.query(`SELECT count(*) AS count FROM attachments WHERE ${CANDIDATES}`);
  summary.remaining = Number(remaining.rows[0]?.count ?? 0);
  log(`Summary${dryRun ? " (dry-run)" : ""}: ${JSON.stringify(summary)}`);
  return summary;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dryRun = false;
  let batchSize = 50;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--batch-size" && args[i + 1]) batchSize = Number(args[++i]);
    else throw new Error("usage: bun run attachments:migrate [--dry-run] [--batch-size 50]");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("batch size must be an integer from 1 to 1000");
  const url = databaseUrlOf(process.env);
  if (!url || !process.env.BLOB_READ_WRITE_TOKEN)
    throw new Error("Set ARMADA_DATABASE_URL (or DATABASE_URL) and BLOB_READ_WRITE_TOKEN in the environment");
  // Even dry-run must not apply schema migrations. The operator runs those separately.
  const db = await openDatabase(url, { migrate: false });
  try {
    await migrateAttachmentsToBlob(db, { dryRun, batchSize });
  } finally {
    await db.end();
  }
}

if (import.meta.main)
  main().catch(() => {
    console.error(
      "Attachment migration failed. Check arguments, environment and additive schema migration; no credentials are logged.",
    );
    process.exitCode = 1;
  });
