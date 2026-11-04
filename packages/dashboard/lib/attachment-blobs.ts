import { del, get, put } from "@vercel/blob";
import { type Database, transaction } from "./db";

export interface AttachmentBlobs {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string, useCache?: boolean): Promise<ReadableStream<Uint8Array> | null>;
  del(key: string): Promise<void>;
}

export const attachmentStorageKey = (project: string, sha256: string): string => `attachments/${project}/${sha256}`;

function blobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is required for attachment storage");
  return token;
}

// Pass only the environment token: the SDK also supports OIDC, which this store does not use.
export const attachmentBlobs: AttachmentBlobs = {
  async put(key, bytes, contentType) {
    await put(key, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      token: blobToken(),
    });
  },
  async get(key, useCache = true) {
    const result = await get(key, { access: "private", useCache, token: blobToken() });
    return result?.stream ?? null;
  },
  del: (key) => del(key, { token: blobToken() }),
};

/** Shared content keys outlive any one ticket. Serialize cleanup with uploads and backfills. */
export async function removeUnusedAttachmentBlobs(
  db: Database,
  project: string,
  keys: string[],
  blobs: AttachmentBlobs,
): Promise<void> {
  if (!keys.length) return;
  try {
    await transaction(db, async (tx) => {
      await tx.query("SELECT slug FROM projects WHERE slug = $1 FOR UPDATE", [project]);
      const rows = await tx.query(
        "SELECT storage_key FROM attachments WHERE project = $1 AND kind = 'image' AND storage_key IS NOT NULL",
        [project],
      );
      // Legacy rows serve bytea. A backfill holds this same lock until its real pointer is stored.
      const used = new Set(rows.rows.map((row) => row.storage_key));
      for (const key of new Set(keys)) if (!used.has(key)) await blobs.del(key).catch(() => {});
    });
  } catch {
    // Cleanup is best effort; database uncertainty must never delete a referenced image.
  }
}
