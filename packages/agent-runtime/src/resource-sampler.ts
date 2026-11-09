import { open } from "node:fs/promises";
import type { VmResourceReading } from "@armada/core";
import {
  parseVmResourceFiles,
  VM_RESOURCE_MAX_FILE_BYTES,
  VM_RESOURCE_PATHS,
} from "../../core/src/vm-resource-reading.ts";

/** Fixed paths, one bounded read per open, no shell, process listing or secrets. */
async function read(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const buffer = Buffer.alloc(VM_RESOURCE_MAX_FILE_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    // A full buffer might be truncated. Missing is safer than a partial counter set.
    return bytesRead < buffer.length ? buffer.toString("utf8", 0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
/** Caller must establish provider-attested VM isolation; raw guest files cannot establish it. */
export async function sampleVmResources(): Promise<VmResourceReading | null> {
  const files: (string | null)[] = [];
  for (const path of VM_RESOURCE_PATHS) files.push(await read(path));
  return parseVmResourceFiles(files);
}
