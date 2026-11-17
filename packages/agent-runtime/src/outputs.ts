import { constants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import {
  DOCKER_OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_ENTRIES,
  OUTPUT_MAX_FILES,
  validOutputName,
} from "@armada/core";

/**
 * Fixed, read-only, bounded read of the declared output directory (#2570), the runtime
 * counterpart of the server's Python collector. No caller-supplied path: the directory is
 * fixed, its last component and every file are opened without following symlinks, and files
 * are opened through the directory's own descriptor, so a swapped directory or link never
 * redirects the read. Subdirectories, links, hard links and special files are excluded; the
 * count and byte bounds count admitted files only, in name order.
 */
export async function readOutputDirectory(
  directory: string = DOCKER_OUTPUT_DIRECTORY,
): Promise<{ name: string; base64: string }[]> {
  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw Error("output_directory_unreadable");
  }
  try {
    // Linux resolves this magic link to the opened directory itself (openat semantics).
    const base = `/proc/self/fd/${handle.fd}`;
    const entries = await readdir(base);
    // A larger directory is unreadable now (the previous snapshot stays), never a partial read.
    if (entries.length > OUTPUT_MAX_ENTRIES) throw Error("output_limit");
    const files: { name: string; base64: string }[] = [];
    let total = 0;
    for (const name of entries.filter(validOutputName).sort()) {
      if (files.length === OUTPUT_MAX_FILES) break;
      let file: FileHandle;
      try {
        file = await open(`${base}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        continue;
      }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > OUTPUT_MAX_BYTES - total) continue;
        const buffer = Buffer.alloc(OUTPUT_MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > OUTPUT_MAX_BYTES - total) continue;
        total += bytesRead;
        files.push({ name, base64: buffer.subarray(0, bytesRead).toString("base64") });
      } catch {
        // An entry that changed or vanished mid-read is skipped, never a failed snapshot.
      } finally {
        await file.close();
      }
    }
    return files;
  } finally {
    await handle.close();
  }
}
