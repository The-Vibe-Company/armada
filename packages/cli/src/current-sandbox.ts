import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AuthError } from "@armada/auth";
import type { ListInput, ListResult } from "@armada/core/contract";
import type { AuthIo } from "./auth-commands.ts";

const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidTemplate = "00000000-0000-0000-0000-000000000000";

export function isFullUuid(value: string) {
  return fullId.test(value);
}

export function isUuidPrefix(value: string) {
  return (
    value.length > 0 && value.length <= uuidTemplate.length && fullId.test(value + uuidTemplate.slice(value.length))
  );
}

export interface CurrentSandboxFile {
  read(): Promise<string | undefined>;
  write(id: string): Promise<void>;
}

async function hasGitRoot(dir: string) {
  try {
    await lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function currentSandboxFile(cwd: string, home = homedir()) {
  const root = resolve(cwd);
  const homeDir = home ? resolve(home) : undefined;
  const dir = join(root, ".armada");
  const path = join(dir, "sandbox");
  const checkDirectory = async (target: string) => {
    if (!(await lstat(target)).isDirectory()) throw new Error(".armada must be a directory in the current workspace.");
  };
  const readAt = async (base: string) => {
    const armadaDir = join(base, ".armada");
    try {
      await checkDirectory(armadaDir);
      const handle = await open(
        join(armadaDir, "sandbox"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await handle.stat()).isFile()) throw new Error(".armada/sandbox must be a regular file.");
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AuthError("Could not read .armada/sandbox. Check its permissions or pass a sandbox ID.", "usage");
    }
  };
  return {
    async read() {
      let current = root;
      for (;;) {
        const value = await readAt(current);
        if (value !== undefined) return value;
        if (current === homeDir || (await hasGitRoot(current))) return undefined;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    },
    async write(id: string) {
      await mkdir(dir, { recursive: true });
      await checkDirectory(dir);
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

export async function readCurrentSandbox(env: AuthIo["env"], file: CurrentSandboxFile | undefined) {
  return env.ARMADA_SANDBOX?.trim() || (await file?.read())?.trim() || undefined;
}

export async function resolveSandboxId(
  explicit: string | undefined,
  env: AuthIo["env"],
  file: CurrentSandboxFile | undefined,
  org: string | undefined,
  list: (input: ListInput & { org?: string }) => Promise<ListResult>,
) {
  return resolveSandboxReference(
    explicit,
    explicit === undefined ? await readCurrentSandbox(env, file) : undefined,
    org,
    list,
  );
}

export async function resolveSandboxReference(
  explicit: string | undefined,
  current: string | undefined,
  org: string | undefined,
  list: (input: ListInput & { org?: string }) => Promise<ListResult>,
) {
  const id = explicit ?? current;
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
  if (!match) throw new AuthError("No visible sandbox matches that UUID prefix. Run armada ls.", "usage");
  return match;
}
