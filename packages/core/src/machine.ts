// The machine store: Armada's keys and personal defaults for one user on one
// machine, under $XDG_CONFIG_HOME/armada or ~/.config/armada. This adapter is
// the only code that touches those files. It never logs or returns a value in
// an error; values leave it only through resolveCredentials.
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { ConfigError } from "./config.ts";
import { parseDotenv, updateDotenv } from "./dotenv.ts";
import { EMPTY_WATCH_STATE, type WatchState } from "./watch.ts";

export interface MachinePaths {
  dir: string;
  /** Dotenv file with the keys, mode 0600. */
  credentials: string;
  /** Non-secret personal defaults. */
  config: string;
}

/** Null when neither XDG_CONFIG_HOME nor HOME is set: the machine store is then off. */
export function machinePaths(env: Record<string, string | undefined>): MachinePaths | null {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim();
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const base = xdg && isAbsolute(xdg) ? xdg : home ? join(home, ".config") : null;
  if (!base) return null;
  const dir = join(base, "armada");
  return { dir, credentials: join(dir, "credentials"), config: join(dir, "config.toml") };
}

export interface CredentialStore {
  path: string;
  exists: boolean;
  /** Permission bits of the file (e.g. 0o600), or null when it does not exist. */
  mode: number | null;
  values: Record<string, string>;
  /** Line numbers that are not `KEY=value`; they are kept but ignored. */
  invalidLines: number[];
  /** Keys on any `KEY=...` line, even a malformed one. */
  assigned: string[];
}

const missing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export async function readCredentialStore(path: string): Promise<CredentialStore> {
  let text: string;
  let mode: number;
  try {
    [text, mode] = await Promise.all([readFile(path, "utf8"), stat(path).then((s) => s.mode & 0o777)]);
  } catch (err) {
    if (missing(err)) return { path, exists: false, mode: null, values: {}, invalidLines: [], assigned: [] };
    throw new Error(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  return { path, exists: true, mode, ...parseDotenv(text) };
}

/** True when anyone other than the owner can read or write the file. */
export const storeIsExposed = (store: CredentialStore) => store.mode !== null && (store.mode & 0o077) !== 0;

/** Writes `text` to `path` atomically with `mode`, creating the directory with 0700. */
async function writePrivate(paths: MachinePaths, path: string, text: string, mode: number): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory alone; Armada owns this one, so tighten it.
  await chmod(paths.dir, 0o700);
  if (dirname(path) !== paths.dir) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, "wx", mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Sets (string) or removes (null) keys in the credentials file, keeping every
 * other line and comment. The file ends up 0600 in a 0700 directory.
 */
export async function updateCredentialStore(
  paths: MachinePaths,
  updates: Record<string, string | null>,
): Promise<void> {
  let text = "";
  try {
    text = await readFile(paths.credentials, "utf8");
  } catch (err) {
    if (!missing(err)) throw err;
  }
  await writePrivate(paths, paths.credentials, updateDotenv(text, updates), 0o600);
}

export interface PersonalConfig {
  /** Owner's language (BCP 47 tag), or null. */
  language: string | null;
  dashboard: { url: string | null };
  /** The Armada API, for a self-hosted Armada; the built-in address otherwise. */
  api: { url: string | null };
}

export const EMPTY_PERSONAL_CONFIG: PersonalConfig = {
  language: null,
  dashboard: { url: null },
  api: { url: null },
};

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses config.toml. Unknown keys in known tables are errors; unknown tables are allowed. */
export function parsePersonalConfig(text: string, source = "config.toml"): PersonalConfig {
  let raw: Table;
  try {
    raw = parse(text) as Table;
  } catch (err) {
    const where = err instanceof TomlError ? ` (line ${err.line}, column ${err.column})` : "";
    throw new ConfigError(source, [`not valid TOML${where}`]);
  }
  const problems: string[] = [];
  const known: Record<string, string[]> = { dashboard: ["url"], api: ["url"] };
  for (const [key, v] of Object.entries(raw)) {
    if (key === "language") continue;
    const keys = known[key];
    if (!keys) {
      if (!isTable(v)) problems.push(`unknown key "${key}"`);
      continue;
    }
    if (!isTable(v)) {
      problems.push(`"${key}" must be a table`);
      continue;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) problems.push(`unknown key "${key}.${k}"`);
  }
  const str = (v: unknown, dotted: string): string | null => {
    if (v === undefined) return null;
    if (typeof v === "string" && v.trim()) return v.trim();
    problems.push(`"${dotted}" must be a non-empty string`);
    return null;
  };
  const table = (key: string): Table => (isTable(raw[key]) ? (raw[key] as Table) : {});
  const config: PersonalConfig = {
    language: str(raw.language, "language"),
    dashboard: { url: str(table("dashboard").url, "dashboard.url") },
    api: { url: str(table("api").url, "api.url") },
  };
  if (problems.length) throw new ConfigError(source, problems);
  return config;
}

/** Reads config.toml; a missing file gives empty defaults. */
export async function readPersonalConfig(path: string): Promise<{ exists: boolean; config: PersonalConfig }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (missing(err)) return { exists: false, config: EMPTY_PERSONAL_CONFIG };
    throw err;
  }
  return { exists: true, config: parsePersonalConfig(text, path) };
}

export const PERSONAL_CONFIG_TEMPLATE = `# Armada personal defaults for this machine. No secrets here:
# keys live in the credentials file next to this one (armada auth login).

# Your language for Armada's messages (BCP 47 tag).
# language = "en"

# [dashboard]
# url = "https://<your-armada-dashboard>"

# The Armada the CLI signs in to (armada login), for a self-hosted one.
# [api]
# url = "https://armada.example.com"
`;

/** Creates config.toml from the commented template unless it exists. Returns true when created. */
export async function ensurePersonalConfig(paths: MachinePaths): Promise<boolean> {
  try {
    await stat(paths.config);
    return false;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  await writePrivate(paths, paths.config, PERSONAL_CONFIG_TEMPLATE, 0o644);
  return true;
}

// ------------------------------------------------------------------ the watch state

/**
 * Where a project's watch lives on this machine: `watch/<project>.json`, its
 * state (no secret), and `watch/<project>.pid`, the lock a running
 * `armada watch` holds. The project is its armada.toml slug, already a safe
 * file name.
 */
export function watchFiles(paths: MachinePaths, project: string): { state: string; lock: string } {
  const dir = join(paths.dir, "watch");
  return { state: join(dir, `${project}.json`), lock: join(dir, `${project}.pid`) };
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
const stringOr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The project's watch state; null when there is none or it cannot be read as one. */
export async function readWatchState(paths: MachinePaths, project: string): Promise<WatchState | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(watchFiles(paths, project).state, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    root: stringOr(r.root),
    seen: strings(r.seen) ?? [],
    inFlight: strings(r.inFlight),
    readAt: stringOr(r.readAt),
    stopped: stringOr(r.stopped),
  };
}

/** Sets some fields of the project's watch state, keeping the others; returns the state written. */
export async function updateWatchState(
  paths: MachinePaths,
  project: string,
  patch: Partial<WatchState>,
): Promise<WatchState> {
  const state = { ...EMPTY_WATCH_STATE, ...(await readWatchState(paths, project)), ...patch };
  await writePrivate(paths, watchFiles(paths, project).state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return state;
}

/** The pid in the project's watch lock, or null when there is no lock. */
export async function readWatchLock(paths: MachinePaths, project: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(watchFiles(paths, project).lock, "utf8")).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** True while the process `pid` exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, under another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the project's watch lock for `pid`, atomically: one watch per project
 * and machine. A lock whose process is gone is stale and taken over. Returns
 * the pid of the watch already running otherwise.
 */
export async function takeWatchLock(
  paths: MachinePaths,
  project: string,
  pid: number,
  alive: (pid: number) => boolean = processAlive,
): Promise<{ taken: true } | { taken: false; pid: number }> {
  const { lock } = watchFiles(paths, project);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  // The pid is written first, then linked into place: the lock never exists empty.
  const tmp = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, lock);
        return { taken: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const held = await readWatchLock(paths, project);
      if (held !== null && held !== pid && alive(held)) return { taken: false, pid: held };
      // Stale: its watch is gone. Removed only if no other watch took it over meanwhile.
      if ((await readWatchLock(paths, project)) === held) await rm(lock, { force: true });
    }
    throw new Error(`cannot take the watch lock ${lock}`);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Gives the lock back, unless another watch holds it now. */
export async function releaseWatchLock(paths: MachinePaths, project: string, pid: number): Promise<void> {
  if ((await readWatchLock(paths, project).catch(() => null)) === pid)
    await rm(watchFiles(paths, project).lock, { force: true });
}

/** The pid of the live watch of the project on this machine, or null. */
export async function runningWatch(
  paths: MachinePaths,
  project: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<number | null> {
  const pid = await readWatchLock(paths, project).catch(() => null);
  return pid !== null && alive(pid) ? pid : null;
}
