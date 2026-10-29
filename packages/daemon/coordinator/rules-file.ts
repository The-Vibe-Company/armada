import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ProjectRules } from "./rules.ts";
import { importV1Rules } from "./rules-import.ts";

const MAX_BYTES = 262144;

/** Explicit local import adapter. Only the path and normalized rules reach the chat/log.
 * Bound reads even if the file grows, and refuse directories/devices before reading.
 */
export async function readV1RulesFile(file: string): Promise<ProjectRules> {
  if (!isAbsolute(file)) throw new Error("The import file must be an absolute path");
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Expected a TOML file of at most 256 KiB");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("TOML file exceeds 256 KiB");
    return importV1Rules(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    await handle.close();
  }
}
