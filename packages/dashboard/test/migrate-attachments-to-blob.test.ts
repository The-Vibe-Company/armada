import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Database, DB_MIGRATIONS, migrateDatabase, pgliteDatabase } from "../lib/db";
import { upsertProject } from "../lib/fleet-store";
import { migrateAttachmentsToBlob } from "../scripts/migrate-attachments-to-blob";
import { fakeAttachmentBlobs } from "./attachment-support";

let db: Database;
const now = new Date("2026-04-01T00:00:00Z");
const logs: string[] = [];
const log = (message: string) => logs.push(message);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  // Always in-memory PGlite, independent of any database URL in the shell.
  db = await pgliteDatabase();
  // Recreate the previously deployed schema and apply the new migration over real rows.
  await db.query("CREATE TABLE armada_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
  for (const migration of DB_MIGRATIONS.filter((m) => m.version < 52)) {
    for (const sql of migration.statements) await db.query(sql);
    await db.query("INSERT INTO armada_migrations VALUES ($1, $2)", [migration.version, now]);
  }
  await upsertProject(
    db,
    { slug: "backfill", name: "Backfill", repository: "acme/backfill", programRoot: "BACK-1" },
    now,
  );
  await legacy("schema-upgrade");
  await migrateDatabase(db);
});
afterAll(() => db.end());

async function legacy(id: string, hash?: string) {
  const bytes = Buffer.from(`synthetic-image-${id}`);
  await db.query(
    `INSERT INTO attachments (id, project, ticket, kind, bytes, content_type, size, sha256, author, created_at)
     VALUES ($1, 'backfill', $1, 'image', $2, 'image/png', $3, $4, 'Worker', $5)`,
    [id, bytes, bytes.length, hash ?? sha(bytes), now],
  );
  return bytes;
}

test("the additive schema migration preserves existing images and is repeatable", async () => {
  const before = (await db.query("SELECT bytes, storage_key, stored_at FROM attachments WHERE id = 'schema-upgrade'"))
    .rows[0];
  expect(before).toEqual({ bytes: Buffer.from("synthetic-image-schema-upgrade"), storage_key: null, stored_at: null });
  await migrateDatabase(db);
  expect(
    (await db.query("SELECT bytes, storage_key, stored_at FROM attachments WHERE id = 'schema-upgrade'")).rows[0],
  ).toEqual(before);
  await db.query("DELETE FROM attachments WHERE id = 'schema-upgrade'");
});

test("batch migration verifies remote content, preserves bytes, and reruns without uploads", async () => {
  const originals = new Map<string, Uint8Array>();
  for (const id of ["batch-a", "batch-b", "batch-c"]) originals.set(id, await legacy(id));
  const blobs = fakeAttachmentBlobs();
  const result = await migrateAttachmentsToBlob(db, { blobs, batchSize: 2, log, now: () => now });
  expect(result).toEqual({ migrated: 3, skipped: 0, mismatches: 0, remaining: 0, wouldMigrate: 0 });
  expect(blobs.put).toHaveBeenCalledTimes(3);
  for (const [id, bytes] of originals) {
    const row = (await db.query("SELECT bytes, sha256, storage_key, stored_at FROM attachments WHERE id = $1", [id]))
      .rows[0];
    const key = `attachments/backfill/${sha(bytes)}`;
    expect(Buffer.from(row?.bytes as Uint8Array)).toEqual(Buffer.from(bytes));
    expect(row?.sha256).toBe(sha(bytes));
    expect(row?.storage_key).toBe(key);
    expect(new Date(String(row?.stored_at)).toISOString()).toBe(now.toISOString());
    expect(blobs.get).toHaveBeenCalledWith(key, false);
    expect(blobs.objects.get(key)).toEqual(bytes);
  }
  expect((await migrateAttachmentsToBlob(db, { blobs, batchSize: 2, log })).migrated).toBe(0);
  expect(blobs.put).toHaveBeenCalledTimes(3);
});

test("dry-run reports candidates without any database or Blob writes", async () => {
  await legacy("dry-a");
  await legacy("dry-b");
  const blobs = fakeAttachmentBlobs();
  const before = (await db.query("SELECT * FROM attachments ORDER BY id")).rows;
  const result = await migrateAttachmentsToBlob(db, { dryRun: true, batchSize: 1, blobs, log });
  expect(result).toEqual({ migrated: 0, skipped: 0, mismatches: 0, remaining: 2, wouldMigrate: 2 });
  expect((await db.query("SELECT * FROM attachments ORDER BY id")).rows).toEqual(before);
  expect(blobs.put).not.toHaveBeenCalled();
  expect(blobs.get).not.toHaveBeenCalled();
  expect(blobs.del).not.toHaveBeenCalled();
  expect(logs.some((line) => line.startsWith("Summary (dry-run):"))).toBe(true);
  await db.query("DELETE FROM attachments WHERE id IN ('dry-a', 'dry-b')");
});

test("source hash mismatches are logged and skipped while later batches continue", async () => {
  await legacy("mismatch-a", "0".repeat(64));
  await legacy("mismatch-b");
  const blobs = fakeAttachmentBlobs();
  const result = await migrateAttachmentsToBlob(db, { blobs, batchSize: 1, log });
  expect(result).toEqual({ migrated: 1, skipped: 0, mismatches: 1, remaining: 1, wouldMigrate: 0 });
  expect(blobs.put).toHaveBeenCalledTimes(1);
  expect(logs.some((line) => line.includes("Mismatch mismatch-a"))).toBe(true);
  expect((await db.query("SELECT storage_key, bytes FROM attachments WHERE id = 'mismatch-a'")).rows[0]).toEqual({
    storage_key: null,
    bytes: Buffer.from("synthetic-image-mismatch-a"),
  });
  await db.query("DELETE FROM attachments WHERE id = 'mismatch-a'");
});

test("readback hash, size and missing-object failures never mark a row as stored and are retryable", async () => {
  const bytes = await legacy("readback");
  const blobs = fakeAttachmentBlobs();
  const get = blobs.get.getMockImplementation();
  for (const body of [
    Buffer.alloc(bytes.length, 0),
    bytes.subarray(0, -1),
    Buffer.concat([bytes, Buffer.from("extra")]),
    null,
  ]) {
    blobs.get.mockImplementation(async () => (body ? new Response(body).body : null));
    const result = await migrateAttachmentsToBlob(db, { blobs, log });
    expect(result.mismatches).toBe(1);
    expect(result.remaining).toBe(1);
    expect((await db.query("SELECT storage_key, stored_at FROM attachments WHERE id = 'readback'")).rows[0]).toEqual({
      storage_key: null,
      stored_at: null,
    });
  }
  if (!get) throw new Error("fake Blob reader required");
  blobs.get.mockImplementation(get);
  expect((await migrateAttachmentsToBlob(db, { blobs, log })).migrated).toBe(1);
  expect((await db.query("SELECT bytes FROM attachments WHERE id = 'readback'")).rows[0]?.bytes).toEqual(bytes);
});

test("provider failures skip a row, continue the batch, and do not echo sensitive errors", async () => {
  await legacy("retry-a");
  await legacy("retry-b");
  const blobs = fakeAttachmentBlobs();
  blobs.put.mockRejectedValueOnce(new Error("provider detail that must not reach logs"));
  const result = await migrateAttachmentsToBlob(db, { blobs, log });
  expect(result).toEqual({ migrated: 1, skipped: 1, mismatches: 0, remaining: 1, wouldMigrate: 0 });
  expect(logs.join("\n")).not.toContain("provider detail");
  expect((await migrateAttachmentsToBlob(db, { blobs, log })).migrated).toBe(1);
});
