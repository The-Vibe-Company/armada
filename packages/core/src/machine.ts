// The machine store: Armada's keys and personal defaults for one user on one
// machine, under $XDG_CONFIG_HOME/armada or ~/.config/armada. This adapter is
// the only code that touches those files. It never logs or returns a value in
// an error; credential values leave it only through resolveCredentials.
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { lock } from "proper-lockfile";
import { parse, TomlError } from "smol-toml";
import { ConfigError, deployEnvName } from "./config.ts";
import { parseDotenv, updateDotenv } from "./dotenv.ts";
import { COORDINATOR } from "./fleet-api.ts";
import { EMPTY_WATCH_STATE, type HookRun, type PeekTail, type WatchState } from "./watch.ts";

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
  await writePrivateFile(path, text, mode);
}

/**
 * Writes a file only its owner can read (mode 0600 by default), atomically,
 * in an existing directory: the credentials file, and `armada secrets export`
 * (THE-859). An existing file is replaced, and ends up with `mode` whatever
 * its mode was.
 */
export async function writePrivateFile(path: string, text: string, mode = 0o600): Promise<void> {
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

// ------------------------------------------------------ project machine settings

const projectSettingsPath = (paths: MachinePaths, project: string): string => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error("invalid project slug");
  return join(paths.dir, "projects", `${project}.json`);
};

/** Non-secret deploy command settings, isolated per project on this machine.
 * Invalid files are repairable with config set and never interrupt merge cleanup.
 */
export async function readDeployEnv(
  paths: MachinePaths | null,
  project: string,
): Promise<{ env: Record<string, string>; warning: string | null }> {
  const empty = { env: {}, warning: null };
  if (!paths) return empty;
  const path = projectSettingsPath(paths, project);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (missing(err)) return empty;
    return {
      env: {},
      warning: `cannot read project machine settings in ${path}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}; using the process environment`,
    };
  }
  try {
    const raw = JSON.parse(text);
    if (!isTable(raw) || !isTable(raw.deploy) || !isTable(raw.deploy.env)) throw new Error();
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.deploy.env)) {
      if (!deployEnvName(name) || typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error();
      env[name] = value;
    }
    return { env, warning: null };
  } catch {
    return {
      env: {},
      warning: `invalid project machine settings in ${path}; using the process environment. armada config set repairs this file`,
    };
  }
}

/** Set or unset a non-secret setting without printing its value. */
export async function updateDeployEnv(
  paths: MachinePaths,
  project: string,
  name: string,
  value: string | null,
): Promise<void> {
  if (!deployEnvName(name)) throw new Error("invalid deploy environment variable name");
  if (value !== null && (!value.trim() || value.includes("\0")))
    throw new Error("deploy setting must be a non-empty string without NUL");
  const { env } = await readDeployEnv(paths, project);
  if (value === null) delete env[name];
  else env[name] = value;
  await writePrivate(
    paths,
    projectSettingsPath(paths, project),
    `${JSON.stringify({ deploy: { env } }, null, 2)}\n`,
    0o600,
  );
}

// ------------------------------------------------------------------ the watch state

/**
 * Where a project's watch lives on this machine: `watch/<project>.json`, its
 * state (no secret), and `watch/<project>.pid`, the lock a running
 * `armada watch` holds. The project is its armada.toml slug, already a safe
 * file name.
 */
export function watchFiles(
  paths: MachinePaths,
  project: string,
  name = "default",
): { state: string; lock: string; result: string } {
  if (!COORDINATOR.test(name)) throw new Error("invalid coordinator name");
  const dir = join(paths.dir, "watch");
  const key = name === "default" ? project : `${project}@${name}`;
  return { state: join(dir, `${key}.json`), lock: join(dir, `${key}.pid`), result: join(dir, `${key}.result.json`) };
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
const stringOr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function peekTails(value: unknown): Record<string, PeekTail> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const tails: Record<string, PeekTail> = {};
  const at = (v: unknown) => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
  const reply = (v: unknown): v is NonNullable<PeekTail["lastReply"]> => {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    return typeof r.text === "string" && r.text.length <= 4000 && at(r.at);
  };
  for (const [key, raw] of Object.entries(value).slice(-50)) {
    if (typeof raw !== "object" || raw === null) continue;
    const t = raw as Record<string, unknown>;
    if (
      typeof t.generation !== "string" ||
      typeof t.truncated !== "boolean" ||
      !(t.lastReply === null || reply(t.lastReply)) ||
      !Array.isArray(t.actions) ||
      t.actions.length > 100
    )
      continue;
    const actions: PeekTail["actions"] = [];
    for (const raw of t.actions) {
      if (!reply(raw)) continue;
      const a = raw as Record<string, unknown>;
      if (
        !["command", "tool", "message"].includes(String(a.kind)) ||
        !(a.id === undefined || (typeof a.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a.id))) ||
        !(a.exit === undefined || a.exit === null || (typeof a.exit === "number" && Number.isSafeInteger(a.exit)))
      )
        continue;
      actions.push(raw as PeekTail["actions"][number]);
    }
    tails[key] = { generation: t.generation, truncated: t.truncated, lastReply: t.lastReply, actions };
  }
  return tails;
}

/** The project's watch state; null when there is none or it cannot be read as one. */
function readWorkerSlots(value: unknown): WatchState["slots"] {
  if (!value || typeof value !== "object") return undefined;
  const { taken, max } = value as { taken?: unknown; max?: unknown };
  if (typeof taken !== "number" || !Number.isSafeInteger(taken) || taken < 0) return undefined;
  if (max !== null && (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0)) return undefined;
  return { taken, max };
}

export async function readWatchState(
  paths: MachinePaths,
  project: string,
  name = "default",
): Promise<WatchState | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(watchFiles(paths, project, name).state, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...(typeof r.claudeSessions === "object" && r.claudeSessions !== null && !Array.isArray(r.claudeSessions)
      ? { claudeSessions: boundedTimes(r.claudeSessions, 10) }
      : {}),
    ...(typeof r.habitCursors === "object" && r.habitCursors !== null && !Array.isArray(r.habitCursors)
      ? {
          habitCursors: Object.fromEntries(
            Object.entries(r.habitCursors)
              .filter(([id, v]) => {
                if (!id || id.length > 256 || typeof v !== "object" || v === null) return false;
                const cursor = v as Record<string, unknown>;
                return (
                  typeof cursor.path === "string" &&
                  cursor.path.length <= 4096 &&
                  typeof cursor.offset === "number" &&
                  Number.isSafeInteger(cursor.offset) &&
                  cursor.offset >= 0
                );
              })
              .slice(-10),
          ) as NonNullable<WatchState["habitCursors"]>,
        }
      : {}),
    // Only a bounded, validated transcript tail is read back.
    ...(typeof r.peek === "object" && r.peek !== null && !Array.isArray(r.peek)
      ? {
          peek: Object.fromEntries(
            Object.entries(r.peek)
              .filter(([_, v]) => typeof v === "string")
              .slice(-50),
          ) as Record<string, string>,
        }
      : {}),
    ...(typeof r.peekTail === "object" && r.peekTail !== null && !Array.isArray(r.peekTail)
      ? { peekTail: peekTails(r.peekTail) }
      : {}),
    ...(typeof r.harnessLimitMinutes === "number" &&
    Number.isFinite(r.harnessLimitMinutes) &&
    r.harnessLimitMinutes >= 5
      ? { harnessLimitMinutes: r.harnessLimitMinutes }
      : {}),
    root: stringOr(r.root),
    seen: strings(r.seen) ?? [],
    ...(r.seenScope === "mine" || r.seenScope === "all" ? { seenScope: r.seenScope } : {}),
    inFlight: strings(r.inFlight),
    ...(Array.isArray(r.waiting) ? { waiting: strings(r.waiting) ?? [] } : {}),
    ...(readWorkerSlots(r.slots) ? { slots: readWorkerSlots(r.slots)! } : {}),
    ...(Array.isArray(r.openJobs)
      ? { openJobs: r.openJobs.filter((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0) }
      : {}),
    readAt: stringOr(r.readAt),
    stopped: stringOr(r.stopped),
    ...(typeof r.cursor === "string" ? { cursor: r.cursor } : {}),
    ...(typeof r.baselinePending === "boolean" ? { baselinePending: r.baselinePending } : {}),
    ...(typeof r.freshStart === "boolean" ? { freshStart: r.freshStart } : {}),
    ...(Array.isArray(r.eventIds)
      ? { eventIds: r.eventIds.filter((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0).slice(-500) }
      : {}),
    ...(typeof r.jobObserved === "object" && r.jobObserved !== null && !Array.isArray(r.jobObserved)
      ? {
          jobObserved: Object.fromEntries(
            Object.entries(r.jobObserved).filter(([_, v]) => typeof v === "string" && Number.isFinite(Date.parse(v))),
          ) as Record<string, string>,
        }
      : {}),
    ...(typeof r.runtimeObserved === "object" && r.runtimeObserved !== null && !Array.isArray(r.runtimeObserved)
      ? {
          runtimeObserved: Object.fromEntries(
            Object.entries(r.runtimeObserved).filter(
              ([_, v]) => typeof v === "string" && Number.isFinite(Date.parse(v)),
            ),
          ) as Record<string, string>,
        }
      : {}),
  };
}

/** Known checkouts, newest watch reading first, including named coordinator watches. */
export async function readWatchStates(
  paths: MachinePaths,
): Promise<{ project: string; coordinator: string; state: WatchState }[]> {
  const dir = join(paths.dir, "watch");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if (missing(err)) return [];
    throw new Error(`cannot read ${dir}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  const projects = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map(async (file) => {
        const name = file.slice(0, -5);
        const project = name.split("@")[0] ?? "";
        const coordinator = name.includes("@") ? name.slice(name.indexOf("@") + 1) : "default";
        if (!COORDINATOR.test(coordinator)) return null;
        const state = await readWatchState(paths, project, coordinator);
        if (!project || !state?.root || !isAbsolute(state.root)) return null;
        const readAt = Date.parse(state.readAt ?? "");
        const at = Number.isFinite(readAt)
          ? readAt
          : await stat(join(dir, file))
              .then((s) => s.mtimeMs)
              .catch(() => 0);
        return { project, coordinator, state, at };
      }),
  );
  return projects
    .filter((p) => p !== null)
    .sort((a, b) => b.at - a.at)
    .map(({ project, coordinator, state }) => ({ project, coordinator, state }));
}

export async function readWatchProjects(paths: MachinePaths): Promise<{ project: string; root: string }[]> {
  return (await readWatchStates(paths)).map(({ project, state }) => ({ project, root: state.root as string }));
}

function boundedTimes(value: object, limit: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k, v]) => k.length > 0 && k.length <= 256 && typeof v === "string" && Number.isFinite(Date.parse(v)))
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(0, limit),
  );
}

/** Delivery receipts for all sessions, including sessions outside Armada checkouts. */
export async function readHookRuns(paths: MachinePaths): Promise<Record<string, HookRun>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(paths.dir, "watch", "hooks", "runs.json"), "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const runs = Object.entries(raw).filter(
    ([id, r]) =>
      id.length > 0 &&
      id.length <= 256 &&
      typeof r === "object" &&
      r !== null &&
      typeof r.at === "string" &&
      Number.isFinite(Date.parse(r.at)) &&
      (r.project === null || typeof r.project === "string") &&
      typeof r.why === "string",
  );
  return Object.fromEntries(runs.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 50));
}

export async function recordHookRun(paths: MachinePaths, sessionId: string, run: HookRun): Promise<void> {
  if (!sessionId || sessionId.length > 256) return;
  const file = join(paths.dir, "watch", "hooks", "runs.json");
  await withMachineUpdate(file, async () => {
    const runs = { ...(await readHookRuns(paths)), [sessionId]: run };
    const bounded = Object.fromEntries(
      Object.entries(runs)
        .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
        .slice(0, 50),
    );
    await writePrivate(paths, file, `${JSON.stringify(bounded, null, 2)}\n`, 0o600);
  });
}

/** A short, bounded local lock: serialize read/merge/replace across command processes. */
async function withMachineUpdate<T>(file: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let compromised: Error | null = null;
  const release = await lock(file, {
    realpath: false,
    lockfilePath: `${file}.update.lock`,
    stale: 5000,
    update: 1000,
    retries: { retries: 200, factor: 1, minTimeout: 5, maxTimeout: 5, randomize: false },
    // A cache failure is reported by the caller, never an uncaught timer error in a Stop hook.
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    const result = await work();
    if (compromised) throw compromised;
    return result;
  } finally {
    await release();
  }
}

/** Sets some fields of the project's watch state, keeping the others; returns the state written. */
export async function updateWatchState(
  paths: MachinePaths,
  project: string,
  patch: Partial<WatchState>,
  name = "default",
  session?: { id: string; at: string; root: string },
): Promise<WatchState> {
  const file = watchFiles(paths, project, name).state;
  return withMachineUpdate(file, async () => {
    const before = await readWatchState(paths, project, name);
    if (patch.seen && patch.seenScope) {
      const coversPrevious = !before?.seen.length || patch.seenScope === "all" || before?.seenScope === "mine";
      const open = new Set(patch.seen);
      const retained = (before?.seen ?? []).filter(
        (key) => !coversPrevious || key.startsWith("version:") || open.has(key),
      );
      const keys = [...new Set([...retained, ...patch.seen])];
      // Retain shown history inside the lock, reserving required-version keys before capping it.
      const discarded = new Set(
        keys.filter((key) => !key.startsWith("version:")).slice(0, Math.max(0, keys.length - 500)),
      );
      patch = {
        ...patch,
        seen: keys.filter((key) => !discarded.has(key)).slice(-500),
        seenScope: coversPrevious ? patch.seenScope : "all",
      };
    }
    const state = { ...EMPTY_WATCH_STATE, ...before, ...patch };
    if (before?.claudeSessions || patch.claudeSessions || session) {
      state.claudeSessions = boundedTimes(
        { ...before?.claudeSessions, ...patch.claudeSessions, ...(session ? { [session.id]: session.at } : {}) },
        10,
      );
    }
    if (patch.habitCursors)
      state.habitCursors = Object.fromEntries(
        Object.entries({ ...before?.habitCursors, ...patch.habitCursors }).slice(-10),
      );
    if (session) state.root ??= session.root;
    await writePrivate(paths, file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    return state;
  });
}

/** The process identity captured by the watch that owns the lock. Legacy locks have none. */
export interface WatchIdentity {
  coordinatorName?: string;
  project: string;
  configPath: string;
  started: string;
  /** Wall-clock start of this watch; process identities can use kernel ticks. */
  watchStartedAt?: string;
  command: string;
  cwd: string;
}

export interface WatchLock {
  pid: number;
  identity: WatchIdentity | null;
  mode?: "follow";
  stopRequested?: boolean;
}

/** Reads both legacy PID locks and locks with a process identity; malformed locks are unverified. */
export async function readWatchLockInfo(
  paths: MachinePaths,
  project: string,
  name = "default",
): Promise<WatchLock | null> {
  try {
    const raw = JSON.parse(await readFile(watchFiles(paths, project, name).lock, "utf8"));
    const pid = typeof raw === "number" ? raw : raw?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const i = raw?.identity;
    const verified =
      i && [i.project, i.configPath, i.started, i.command, i.cwd].every((v) => typeof v === "string" && v);
    return {
      pid,
      ...(raw?.stopRequested === true ? { stopRequested: true } : {}),
      ...(raw?.mode === "follow" ? { mode: "follow" as const } : {}),
      identity: verified
        ? {
            project: i.project,
            ...(typeof i.coordinatorName === "string" ? { coordinatorName: i.coordinatorName } : {}),
            configPath: i.configPath,
            started: i.started,
            ...(typeof i.watchStartedAt === "string" ? { watchStartedAt: i.watchStartedAt } : {}),
            command: i.command,
            cwd: i.cwd,
          }
        : null,
    };
  } catch (err) {
    if (missing(err) || err instanceof SyntaxError) return null;
    throw err;
  }
}

/** The pid in the project's watch lock, including a legacy PID-only lock. */
export async function readWatchLock(paths: MachinePaths, project: string, name = "default"): Promise<number | null> {
  return (await readWatchLockInfo(paths, project, name))?.pid ?? null;
}

/** Compares a captured lock with its current holder, including identity (a reused PID is another holder). */
export function sameWatchLock(a: WatchLock | null, b: WatchLock): boolean {
  if (a?.pid !== b.pid) return false;
  const left = a.identity;
  const right = b.identity;
  if (!left || !right) return left === right;
  if ((left.coordinatorName ?? "default") !== (right.coordinatorName ?? "default")) return false;
  return (["project", "configPath", "started", "command", "cwd"] as const).every(
    (field) => left[field] === right[field],
  );
}

/** A plain watch's private completion receipt; process identity fences old results. */
export interface WatchResult {
  pid: number;
  started: string;
  endedAt: string;
  outcome: "items" | "nothing" | "timeout" | "stopped" | "error";
  exit: number;
  stdout: string;
  stderr: string;
  json?: boolean;
  stopRequested?: boolean;
}

// Keep recent generations so a fast later watch cannot erase a waiter's receipt.
const WATCH_RESULTS_KEPT = 100;
async function watchResults(paths: MachinePaths, project: string, name: string): Promise<WatchResult[]> {
  try {
    const raw = JSON.parse(await readFile(watchFiles(paths, project, name).result, "utf8"));
    return [raw, ...(Array.isArray(raw?.previous) ? raw.previous.slice(0, WATCH_RESULTS_KEPT - 1) : [])]
      .filter(
        (r): r is WatchResult =>
          r &&
          Number.isSafeInteger(r.pid) &&
          r.pid > 0 &&
          typeof r.started === "string" &&
          typeof r.endedAt === "string" &&
          Number.isFinite(Date.parse(r.endedAt)) &&
          ["items", "nothing", "timeout", "stopped", "error"].includes(r.outcome) &&
          Number.isInteger(r.exit) &&
          r.exit >= 0 &&
          r.exit <= 255 &&
          typeof r.stdout === "string" &&
          typeof r.stderr === "string" &&
          (r.json === undefined || typeof r.json === "boolean") &&
          (r.stopRequested === undefined || typeof r.stopRequested === "boolean"),
      )
      .map(({ pid, started, endedAt, outcome, exit, stdout, stderr, json, stopRequested }) => ({
        pid,
        started,
        endedAt,
        outcome,
        exit,
        stdout,
        stderr,
        ...(json === undefined ? {} : { json }),
        ...(stopRequested === undefined ? {} : { stopRequested }),
      }));
  } catch {
    return [];
  }
}

export async function readWatchResult(
  paths: MachinePaths,
  project: string,
  holder: WatchLock,
  name = "default",
): Promise<WatchResult | null> {
  if (!holder.identity) return null;
  return (
    (await watchResults(paths, project, name)).find(
      (r) => r.pid === holder.pid && r.started === holder.identity?.started,
    ) ?? null
  );
}

/** A completion during command setup still belongs to that command's waiting window. */
export async function readWatchResultSince(
  paths: MachinePaths,
  project: string,
  since: Date,
  name = "default",
): Promise<WatchResult | null> {
  return (
    (await watchResults(paths, project, name))
      .reverse()
      .filter((r) => Date.parse(r.endedAt) > since.getTime())
      .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))[0] ?? null
  );
}

/** Mark an owned generation before signalling; failed signals can undo only that generation's request. */
export async function setWatchStopRequest(
  paths: MachinePaths,
  project: string,
  holder: WatchLock,
  requested: boolean,
  name = "default",
): Promise<boolean> {
  const file = watchFiles(paths, project, name).lock;
  return withMachineUpdate(file, async () => {
    const current = await readWatchLockInfo(paths, project, name);
    if (!sameWatchLock(current, holder)) return false;
    await writePrivate(paths, file, `${JSON.stringify({ ...current, stopRequested: requested })}\n`, 0o600);
    return true;
  });
}

/** Only the current generation may replace its receipt, before releasing its lock. */
export async function writeWatchResult(
  paths: MachinePaths,
  project: string,
  holder: WatchLock,
  result: WatchResult,
  name = "default",
): Promise<void> {
  if (!holder.identity || result.pid !== holder.pid || result.started !== holder.identity.started) return;
  const file = watchFiles(paths, project, name).result;
  await withMachineUpdate(watchFiles(paths, project, name).lock, async () => {
    if (!sameWatchLock(await readWatchLockInfo(paths, project, name), holder)) return;
    const previous = (await watchResults(paths, project, name))
      .filter((r) => r.pid !== result.pid || r.started !== result.started)
      .slice(0, WATCH_RESULTS_KEPT - 1);
    await writePrivate(
      paths,
      file,
      `${JSON.stringify({ ...result, ...(previous.length ? { previous } : {}) })}\n`,
      0o600,
    );
  });
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
 * Takes the coordinator's watch lock for `pid`, atomically: one watch per role
 * of each project on the machine. A lock whose process is gone is stale and taken over. Returns
 * the pid of the watch already running otherwise.
 */
export async function takeWatchLock(
  paths: MachinePaths,
  project: string,
  pid: number,
  alive: (pid: number) => boolean = processAlive,
  identity?: WatchIdentity,
  mode?: "follow",
  name = "default",
  samePidIsStale = true,
): Promise<{ taken: true } | { taken: false; pid: number }> {
  const { lock } = watchFiles(paths, project, name);
  return withMachineUpdate(lock, async () => {
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    // The pid is written first, then linked into place: the lock never exists empty.
    const tmp = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(
      tmp,
      `${identity || mode ? JSON.stringify({ pid, identity: identity ?? null, ...(mode ? { mode } : {}) }) : pid}\n`,
      { mode: 0o600 },
    );
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await link(tmp, lock);
          return { taken: true };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        const held = await readWatchLock(paths, project, name);
        if (held !== null && (held !== pid || !samePidIsStale) && alive(held)) return { taken: false, pid: held };
        // Stale: its watch is gone. Removed only if no other watch took it over meanwhile.
        if ((await readWatchLock(paths, project, name)) === held) await rm(lock, { force: true });
      }
      throw new Error(`cannot take the watch lock ${lock}`);
    } finally {
      await rm(tmp, { force: true });
    }
  });
}

/** Gives the lock back, unless another watch holds it now. */
export async function releaseWatchLock(
  paths: MachinePaths,
  project: string,
  pid: number,
  identity?: WatchIdentity,
  name = "default",
): Promise<void> {
  await withMachineUpdate(watchFiles(paths, project, name).lock, async () => {
    const held = await readWatchLockInfo(paths, project, name).catch(() => null);
    if (identity ? sameWatchLock(held, { pid, identity }) : held?.pid === pid)
      await rm(watchFiles(paths, project, name).lock, { force: true });
  });
}

/** The pid of the live watch of the project on this machine, or null. */
export async function runningWatch(
  paths: MachinePaths,
  project: string,
  alive: (pid: number) => boolean = processAlive,
  name = "default",
): Promise<number | null> {
  const pid = await readWatchLock(paths, project, name).catch(() => null);
  return pid !== null && alive(pid) ? pid : null;
}

// ------------------------------------------------------------------ notices already reserved

const NOTICED_KEPT = 50;
export const noticesFile = (paths: MachinePaths) => join(paths.dir, "notices.json");
/** Compatibility receipts shared with still-running older CLIs under releases.lock. */
export const releasesFile = (paths: MachinePaths) => join(paths.dir, "releases.json");

interface Notice {
  key: string;
  /** Legacy releases had no timestamp. */
  at: string | null;
}
export interface NoticedRelease {
  version: string;
  at: string | null;
}

/** Missing memory starts empty; corrupt or unreadable memory must suppress reservations. */
async function readNotices(paths: MachinePaths): Promise<Notice[]> {
  const [current, legacy] = await Promise.all([
    readNoticeFile(noticesFile(paths), false),
    readNoticeFile(releasesFile(paths), true),
  ]);
  const receipts = new Map<string, Notice>();
  for (const entry of [...current, ...legacy]) {
    const previous = receipts.get(entry.key);
    if (!previous || (entry.at !== null && (previous.at === null || Date.parse(entry.at) > Date.parse(previous.at))))
      receipts.set(entry.key, entry);
  }
  return [...receipts.values()];
}

async function readNoticeFile(path: string, legacy: boolean): Promise<Notice[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const raw = JSON.parse(text) as { noticed?: unknown };
  if (!Array.isArray(raw?.noticed)) throw new Error("invalid notice memory");
  return raw.noticed.map((entry): Notice => {
    if (legacy && typeof entry === "string") return { key: `release:${entry}`, at: null };
    const key = legacy ? entry?.version : entry?.key;
    if (
      typeof key !== "string" ||
      !key ||
      !(entry.at === null || (typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))))
    )
      throw new Error("invalid notice memory");
    return { key: legacy ? `release:${key}` : key, at: entry.at };
  });
}

export async function readReleaseNotices(paths: MachinePaths): Promise<NoticedRelease[]> {
  return (await readNotices(paths).catch(() => [])).flatMap((entry) =>
    entry.key.startsWith("release:") ? [{ version: entry.key.slice(8), at: entry.at }] : [],
  );
}
export async function readNoticedReleases(paths: MachinePaths): Promise<string[]> {
  return (await readReleaseNotices(paths)).map((entry) => entry.version);
}

type NoticeOptions = { pid?: number; alive?: (pid: number) => boolean };

/** Reserve before printing: concurrent commands and crashes cannot repeat a notice.
 * Infinity reserves a key permanently. Storage failures suppress this best-effort output.
 */
export async function reserveNotice(
  paths: MachinePaths,
  key: string,
  now: Date,
  everyMs: number,
  options: NoticeOptions = {},
): Promise<boolean> {
  return reserveMatchingNotice(paths, key, now, everyMs, (candidate) => candidate === key, options).catch(() => false);
}

/** Release throttling stays machine-wide, with separate budgets for setup drift and ordinary releases. */
export async function addNoticedRelease(
  paths: MachinePaths,
  version: string,
  at: Date = new Date(),
  options: NoticeOptions & { intervalMs?: number } = {},
): Promise<boolean> {
  return reserveMatchingNotice(
    paths,
    `release:${version}`,
    at,
    options.intervalMs ?? 0,
    (key) => key.startsWith("release:") && key.startsWith("release:setup:") === version.startsWith("setup:"),
    options,
  ).catch(() => false);
}

async function reserveMatchingNotice(
  paths: MachinePaths,
  key: string,
  now: Date,
  everyMs: number,
  matches: (candidate: string) => boolean,
  options: NoticeOptions,
): Promise<boolean> {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processAlive;
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const lock = join(paths.dir, "releases.lock");
  const tmp = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
  const holder = `${pid}\n`;
  await writeFile(tmp, holder, { mode: 0o600 });
  let taken = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, lock);
        taken = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const held = await readFile(lock, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (held === null) continue;
      const heldPid = /^\d+\n$/.test(held) ? Number(held.trim()) : null;
      // Even our own PID may belong to another call in this process.
      if (heldPid !== null && alive(heldPid)) return false;
      // Serialize stale recovery too: a reread followed by unlink alone can
      // remove another command's newly acquired lock. Never reclaim this short
      // cleanup guard; a crash here safely suppresses best-effort notices.
      const cleanup = `${lock}.cleanup`;
      try {
        await link(tmp, cleanup);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
      try {
        const current = await readFile(lock, "utf8").catch(() => null);
        const currentPid = current !== null && /^\d+\n$/.test(current) ? Number(current.trim()) : null;
        if (current !== null && (currentPid === null || !alive(currentPid))) await rm(lock, { force: true });
      } finally {
        await rm(cleanup, { force: true });
      }
    }
    if (!taken) return false;
    const previous = await readNotices(paths);
    if (
      previous.some(
        (entry) =>
          matches(entry.key) &&
          (everyMs === Infinity || (entry.at !== null && now.getTime() - Date.parse(entry.at) < everyMs)),
      )
    )
      return false;
    const noticed = previous.filter((entry) => entry.key !== key);
    noticed.push({ key, at: now.toISOString() });
    // Only release history is bounded. Per-session receipts must never be evicted.
    const releases = noticed.filter((entry) => entry.key.startsWith("release:")).slice(-NOTICED_KEPT);
    const kept = noticed.filter((entry) => !entry.key.startsWith("release:"));
    // Old processes use only releases.json. Publish their receipt before permitting output,
    // under the shared lock. New readers merge this file too, so even a partial write
    // or crash after the first receipt suppresses the notice for both CLI generations.
    if (key.startsWith("release:"))
      await writePrivate(
        paths,
        releasesFile(paths),
        `${JSON.stringify(
          {
            noticed: releases.map((entry) =>
              entry.at === null ? entry.key.slice(8) : { version: entry.key.slice(8), at: entry.at },
            ),
          },
          null,
          2,
        )}\n`,
        0o644,
      );
    await writePrivate(
      paths,
      noticesFile(paths),
      `${JSON.stringify({ noticed: [...kept, ...releases] }, null, 2)}\n`,
      0o644,
    );
    return true;
  } finally {
    if (taken && (await readFile(lock, "utf8").catch(() => null)) === holder) await rm(lock, { force: true });
    await rm(tmp, { force: true });
  }
}

/** Non-secret memory of a keys fallback, shared by this machine's commands. */
export interface KeysFallback {
  reason: string;
  failedAt: string;
  warnedAt: string;
}

const keysFallbackFile = (paths: MachinePaths) => join(paths.dir, "keys-fallback.json");

/** Missing, unreadable or malformed memory never prevents asking Armada. */
export async function readKeysFallback(paths: MachinePaths): Promise<KeysFallback | null> {
  try {
    const raw = JSON.parse(await readFile(keysFallbackFile(paths), "utf8")) as Partial<KeysFallback> | null;
    if (
      typeof raw?.reason !== "string" ||
      typeof raw.failedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.failedAt)) ||
      typeof raw.warnedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.warnedAt))
    )
      return null;
    return { reason: raw.reason, failedAt: raw.failedAt, warnedAt: raw.warnedAt };
  } catch {
    return null;
  }
}

/** A successful keys answer clears the memory; writes replace it atomically. */
export async function writeKeysFallback(paths: MachinePaths, fallback: KeysFallback | null): Promise<void> {
  if (!fallback) {
    await rm(keysFallbackFile(paths), { force: true });
    return;
  }
  await writePrivate(paths, keysFallbackFile(paths), `${JSON.stringify(fallback, null, 2)}\n`, 0o644);
}

// ------------------------------------------------------------------ coordinator role per checkout

/** A checkout keeps its coordinator role across terminal sessions. */
export async function readCoordinatorName(paths: MachinePaths, project: string, root: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(paths.dir, "coordinators.json"), "utf8"));
    const value = raw?.[project]?.[root];
    return typeof value === "string" && COORDINATOR.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeCoordinatorName(
  paths: MachinePaths,
  project: string,
  root: string,
  name: string,
): Promise<void> {
  if (!COORDINATOR.test(name)) throw new Error("invalid coordinator name");
  const path = join(paths.dir, "coordinators.json");
  let raw: Record<string, Record<string, string>> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isTable(parsed)) raw = parsed as typeof raw;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  const projectRoles = isTable(raw[project]) ? raw[project] : {};
  await writePrivate(
    paths,
    path,
    `${JSON.stringify({ ...raw, [project]: { ...projectRoles, [root]: name } }, null, 2)}\n`,
    0o600,
  );
}
