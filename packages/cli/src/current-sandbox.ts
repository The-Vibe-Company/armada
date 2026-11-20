import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthError } from "@armada/auth";
import type { ListInput, ListResult } from "@armada/core/contract";
import type { AuthIo } from "./auth-commands.ts";

const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidTemplate = "00000000-0000-0000-0000-000000000000";

export interface CurrentSandboxFile {
  read(): Promise<string | undefined>;
  write(id: string): Promise<void>;
}

export function currentSandboxFile(cwd: string) {
  const dir = join(cwd, ".armada");
  const path = join(dir, "sandbox");
  return {
    async read() {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new AuthError("Could not read .armada/sandbox. Check its permissions or pass a sandbox ID.", "usage");
      }
    },
    async write(id: string) {
      await mkdir(dir, { recursive: true });
      const temporaryDir = await mkdtemp(join(dir, "sandbox-"));
      try {
        const temporaryFile = join(temporaryDir, "id");
        await writeFile(temporaryFile, `${id}\n`);
        await rename(temporaryFile, path);
      } finally {
        await rm(temporaryDir, { recursive: true, force: true });
      }
    },
  } satisfies CurrentSandboxFile;
}

export async function rememberSandbox(id: string, file: CurrentSandboxFile | undefined, io: Pick<AuthIo, "err">) {
  if (!file || !fullId.test(id)) return;
  try {
    await file.write(id);
  } catch {
    io.err(`Sandbox ${id} was created. Could not update .armada/sandbox; use its ID for follow-up commands.\n`);
  }
}

export async function resolveSandboxId(
  explicit: string | undefined,
  env: AuthIo["env"],
  file: CurrentSandboxFile | undefined,
  org: string | undefined,
  list: (input: ListInput & { org?: string }) => Promise<ListResult>,
) {
  const id = explicit ?? (env.ARMADA_SANDBOX?.trim() || (await file?.read())?.trim());
  if (!id) throw new AuthError("Pass a sandbox ID or set ARMADA_SANDBOX.", "usage");
  if (fullId.test(id)) return id.toLowerCase();
  if (!fullId.test(id + uuidTemplate.slice(id.length))) {
    if (explicit !== undefined) return id;
    throw new AuthError("The current sandbox must be a UUID or UUID prefix.", "usage");
  }

  const prefix = id.toLowerCase();
  const matches = new Set<string>();
  let page = 1;
  for (;;) {
    const result = await list({ ...(org === undefined ? {} : { org }), page, limit: 200 });
    if (
      !Array.isArray(result.sandboxes) ||
      !result.sandboxes.every((sandbox) => typeof sandbox?.id === "string" && fullId.test(sandbox.id))
    )
      throw new AuthError("Armada returned an invalid sandbox page. Pass a full UUID.", "unavailable");
    for (const sandbox of result.sandboxes) {
      const candidate = sandbox.id.toLowerCase();
      if (candidate.startsWith(prefix)) matches.add(candidate);
      if (matches.size > 1)
        throw new AuthError("Sandbox ID prefix is ambiguous. Pass a longer prefix or the full UUID.", "usage");
    }
    if (result.hasMore === false) break;
    if (!Number.isSafeInteger(result.nextPage) || result.nextPage !== page + 1)
      throw new AuthError("Armada returned invalid sandbox pagination. Pass a full UUID.", "unavailable");
    page = result.nextPage;
  }
  const [match] = matches;
  if (!match) throw new AuthError("No visible sandbox matches that UUID prefix. Run armada list.", "usage");
  return match;
}
