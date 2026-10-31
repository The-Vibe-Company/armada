import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import type { BriefFile } from "./brief.ts";

/** Nonblocking open prevents a FIFO from holding the daemon before we can reject it. */
async function boundedFile(path: string, limit: number, truncate: boolean): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Brief context must be a regular file");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) {
      if (!truncate) throw new Error("armada.toml is too large to read for a worker brief (256 KiB maximum)");
      // Streaming decode withholds any partial UTF-8 sequence at the prefix boundary.
      return (
        new TextDecoder().decode(buffer.subarray(0, limit), { stream: true }) +
        "\n[truncated: file exceeds its brief budget]"
      );
    }
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}
async function optionalFile(path: string, limit: number, truncate: boolean): Promise<string | undefined> {
  try {
    return await boundedFile(path, limit, truncate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Repository context comes from the registered root, never the daemon's cwd. */
export async function loadBriefContext(root?: string): Promise<{ instructions?: BriefFile; extra?: BriefFile }> {
  if (!root) return {};
  const result: { instructions?: BriefFile; extra?: BriefFile } = {};
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await optionalFile(resolve(root, name), 8192, true);
    if (text !== undefined) {
      result.instructions = { name, text };
      break;
    }
  }
  const toml = await optionalFile(resolve(root, "armada.toml"), 256 * 1024, false);
  if (toml === undefined) return result;
  const config = parse(toml);
  const brief = config.brief;
  if (brief === undefined) return result;
  if (!brief || typeof brief !== "object" || Array.isArray(brief) || brief instanceof Date)
    throw new Error("brief must be a TOML table");
  const extra = brief.extra;
  if (extra === undefined) return result;
  if (typeof extra !== "string" || !extra.trim() || isAbsolute(extra))
    throw new Error("brief.extra must name a file inside the project root");
  const path = await realpath(resolve(root, extra));
  const inside = relative(await realpath(root), path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error("brief.extra must name a file inside the project root");
  result.extra = { name: extra, text: await boundedFile(path, 48 * 1024, true) };
  return result;
}
