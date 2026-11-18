import { createHash } from "node:crypto";
import { once } from "node:events";
import { extract } from "tar-stream";
import {
  OUTPUT_ARCHIVE_LIMIT,
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_ENTRIES,
  OUTPUT_MAX_FILE_BYTES,
  OUTPUT_MAX_FILES,
  type OutputEntry,
  validOutputName,
} from "./sandbox-output-limits.ts";
import { OutputCollectionError } from "./sandbox-outputs.ts";

const RETAINED_OUTPUT_PATH = OUTPUT_DIRECTORY.slice(1);
const BLOCK_BYTES = 512;

function unavailable(): never {
  throw new OutputCollectionError("output_unavailable");
}

/** Read one bounded, directory-scoped tar. Never extract it to a filesystem. */
export async function readOutputArchive(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  source: { fileCount: string | null; fileBytes: string | null } | { root: string },
) {
  if (!body) return unavailable();
  const reader = body.getReader();
  const archive = extract();
  const entries: OutputEntry[] = [];
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let archiveBytes = 0;
  let trailingZeros = 0;
  let lastEntryEnd = 0;
  let rooted = false;
  let archiveFileCount = 0;
  let archiveFileBytes = 0;
  const abort = () => {
    archive.destroy(Error("output_timeout"));
    void reader.cancel().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    const feed = async () => {
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          archiveBytes += value.length;
          if (archiveBytes > OUTPUT_ARCHIVE_LIMIT) return unavailable();
          const previous = trailingZeros;
          trailingZeros = 0;
          for (let end = value.length - 1; end >= 0 && value[end] === 0; end--) trailingZeros++;
          if (trailingZeros === value.length) trailingZeros += previous;
          if (!archive.write(Buffer.from(value))) await once(archive, "drain", { signal });
        }
        archive.end();
      } catch (error) {
        archive.destroy(error instanceof Error ? error : Error("output_unavailable"));
        throw error;
      }
    };
    const parse = async () => {
      for await (const entry of archive) {
        // tar-stream 3.1.7 emits the raw header offset on each entry stream.
        const offset = (entry as typeof entry & { offset?: number }).offset;
        const size = entry.header.size;
        if (
          offset === undefined ||
          !Number.isSafeInteger(offset) ||
          offset < lastEntryEnd ||
          size === undefined ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          (entry.header.type === "directory" && size !== 0)
        )
          return unavailable();
        lastEntryEnd = offset + BLOCK_BYTES * (1 + Math.ceil(size / BLOCK_BYTES));
        const path = entry.header.name.replace(/^\.\//, "").replace(/\/$/, "");
        if ("root" in source && !rooted) {
          if (entry.header.type !== "directory" || path !== source.root) return unavailable();
          rooted = true;
          entry.resume();
          continue;
        }
        if (!("root" in source) && entry.header.type === "directory" && (path === "." || !path)) {
          entry.resume();
          continue;
        }
        if (!("root" in source) && !seen.size && entry.header.type === "directory" && path === RETAINED_OUTPUT_PATH) {
          rooted = true;
          entry.resume();
          continue;
        }
        const prefix = ("root" in source ? source.root : RETAINED_OUTPUT_PATH) + "/";
        if (rooted && !path.startsWith(prefix)) return unavailable();
        // Without an explicit directory marker the prefix is ambiguous. Never mistake
        // a nested directory with the same name for the requested subtree root.
        if (!rooted && path.startsWith(prefix)) return unavailable();
        const relative = rooted ? path.slice(prefix.length) : path;
        if (seen.has(relative) || seen.size >= OUTPUT_MAX_ENTRIES) return unavailable();
        seen.add(relative);
        if (entry.header.type === "file") {
          archiveFileCount++;
          archiveFileBytes += size;
        }
        if (entry.header.type !== "file" || !validOutputName(relative)) {
          entry.resume();
          continue;
        }
        const hash = createHash("sha256");
        const parts: Buffer[] = [];
        let received = 0;
        for await (const bytes of entry) {
          const part = Buffer.from(bytes);
          received += part.length;
          hash.update(part);
          if (size <= OUTPUT_MAX_FILE_BYTES) parts.push(part);
        }
        if (received !== size) return unavailable();
        // Match the shared revision format using content identity, distinct from live stat revisions.
        const digest = hash.digest();
        const revision = [0, 8, 16, 24].map((offset) => digest.readBigUInt64BE(offset)).join(":");
        entries.push({ name: relative, size, revision });
        if (size <= OUTPUT_MAX_FILE_BYTES) files.set(relative, Buffer.concat(parts, size));
      }
    };
    await Promise.all([feed(), parse()]);
    // A successful HTTP response with an incomplete tar must never publish a subset.
    const footerBytes = archiveBytes - lastEntryEnd;
    if (footerBytes < 2 * BLOCK_BYTES || trailingZeros < footerBytes || archiveBytes % BLOCK_BYTES !== 0)
      return unavailable();
    if (
      "root" in source
        ? !rooted
        : source.fileCount !== String(archiveFileCount) || source.fileBytes !== String(archiveFileBytes)
    )
      return unavailable();
    signal.throwIfAborted();
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    return { entries: entries.slice(0, OUTPUT_MAX_FILES), files };
  } finally {
    signal.removeEventListener("abort", abort);
    archive.destroy();
    void reader.cancel().catch(() => {});
  }
}
