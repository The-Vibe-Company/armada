import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** Private native home only. No returned state is allowed in runner responses or events. */
export function readNativeCodexAuth(root: string, register: (values: readonly string[]) => void): string | undefined {
  let fd: number | undefined;
  try {
    const directory = lstatSync(join(root, "codex"));
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw Error("unsafe");
    fd = openSync(join(root, "codex", "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o077) throw Error("unsafe");
    const buffer = Buffer.alloc(65537);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 65536) throw Error("oversized");
    const text = buffer.subarray(0, length).toString("utf8");
    const state = JSON.parse(text);
    const leaves = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(leaves)
          : [];
    register([text, ...leaves(state)]);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw Error("native_auth_state_unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
