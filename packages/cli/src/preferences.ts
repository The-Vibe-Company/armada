import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthError } from "@armada/auth";

/** Non-secret per-Armada-origin preferences, deliberately separate from credentials/sessions. */
export interface Preferences {
  read(origin: string): Promise<string | undefined>;
  write(origin: string, org: string | undefined): Promise<void>;
}
export function filePreferences(path: string): Preferences {
  async function load(): Promise<Record<string, string>> {
    try {
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.values(data).some((v) => typeof v !== "string")
      )
        throw new Error();
      return data as Record<string, string>;
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return {};
      throw new AuthError("Could not read Armada organization preferences.", "unavailable");
    }
  }
  return {
    read: async (origin) => (await load())[origin],
    async write(origin, org) {
      const data = await load();
      if (org === undefined) delete data[origin];
      else data[origin] = org;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
