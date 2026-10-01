// The machine store: Armada's keys and personal defaults for one user on one
// machine, under $XDG_CONFIG_HOME/armada or ~/.config/armada. This adapter is
// the only code that touches those files. It never logs or returns a value in
// an error; values leave it only through resolveCredentials.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { ConfigError } from "./config.ts";
import { parseDotenv, updateDotenv } from "./dotenv.ts";

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
