import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { KeychainBackend } from "./backend.ts";

/** Explicit Linux/CI fallback. One private file per entry; atomic replacement avoids partial writes. */
export function fileKeychain(directory: string): KeychainBackend {
  const path = (service: string, account: string) =>
    join(
      directory,
      createHash("sha256")
        .update(JSON.stringify([service, account]))
        .digest("hex"),
    );
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error("Credential directory must be private and owned by this user");
  }
  return {
    storage: "file",
    async read(service, account) {
      await prepare();
      let file: FileHandle;
      try {
        file = await open(path(service, account), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())
          throw new Error("Credential file must have mode 0600 and belong to this user");
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    },
    async write(service, account, value) {
      await prepare();
      const temporary = join(directory, `.pending-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await file.writeFile(value, "utf8");
        await file.sync();
        await file.close();
        await rename(temporary, path(service, account));
      } finally {
        await file.close();
        await unlink(temporary).catch(() => {});
      }
    },
  };
}
