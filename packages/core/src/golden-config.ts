/** Where a golden's repositories are cloned. Launch pulls the same directories. */
export const GOLDEN_ROOT = "/home/user";

/** How long the sandbox a golden is built in stays up, so `.env` files can be placed before it stops. */
export const GOLDEN_BUILD_TTL_SECONDS = 86_400;

/** How often create and snapshot ask the provider whether it has finished. */
export const GOLDEN_POLL_MS = 1000;

/** A blank sandbox is usually ready in seconds. Three minutes covers a slow machine. */
export const GOLDEN_SANDBOX_POLLS = 180;

/** Saving a snapshot answers immediately and can run for minutes. */
export const GOLDEN_SNAPSHOT_POLLS = 1800;

const CLONE_TIMEOUT_SECONDS = 600;
const INIT_TIMEOUT_SECONDS = 600;

const BRANCH = /^(?![-/.])(?!.*\.\.)(?!.*@)[A-Za-z0-9._/-]{1,255}$/;
const DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * The same words the database rejects, so a config fails before a sandbox exists.
 * Hyphens are underscores, then a whole word or a compound ending or starting with one.
 */
const SECRET_KEY =
  /(^|_)(secrets?|passwords?|passwds?|tokens?|api_keys?|apikeys?|authorizations?|credentials?|private_keys?|access_keys?|boat_api_keys?)($|_)/;

const MAX_REPOS = 16;
const MAX_INIT = 32;
const MAX_COMMAND = 4000;
const MAX_NAME = 120;

export type GoldenErrorCode =
  | "invalid_config"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "setup_failed"
  | "snapshot_failed";

export class GoldenError extends Error {
  override readonly name = "GoldenError";
  readonly code: GoldenErrorCode;

  constructor(code: GoldenErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

export interface GoldenRepo {
  url: string;
  branch: string;
  /** A single directory under {@link GOLDEN_ROOT}. */
  dir: string;
}

/** The versionable golden file, and the `goldens.config` object. No secrets. */
export interface GoldenConfig {
  repos: GoldenRepo[];
  init: string[];
}

/** A GitHub-only representation safe to hand to the server's checkout authorization layer. */
export interface GitHubGoldenConfig {
  repos: { owner: string; repo: string; branch: string; dir: string }[];
  init: string[];
}

/**
 * Converts an already-validated v2 golden config into GitHub repository identities. This intentionally
 * accepts no arbitrary git host or credential-bearing URL: checkout authorization owns the token.
 */
export function normalizeGitHubGoldenConfig(config: GoldenConfig): GitHubGoldenConfig {
  return {
    repos: config.repos.map((repo) => ({ ...githubRepoIdentity(repo.url), branch: repo.branch, dir: repo.dir })),
    init: [...config.init],
  };
}

function githubRepoIdentity(value: string): { owner: string; repo: string } {
  let path: string;
  if (/^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/.test(value)) {
    path = value.slice("git@github.com:".length);
  } else if (/^[^/@\s]+\/[^/@\s]+(?:\.git)?$/.test(value)) {
    path = value;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GoldenError("invalid_config", "Repository must identify a GitHub repository.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new GoldenError("invalid_config", "Repository must identify a GitHub repository.");
    }
    path = url.pathname.replace(/^\//, "");
  }
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(path);
  if (!match?.[1] || !match[2])
    throw new GoldenError("invalid_config", "Repository must identify a GitHub repository.");
  return { owner: match[1], repo: match[2] };
}

export interface ShellCommand {
  command: string;
  cwd: string;
  timeoutSeconds: number;
}

export function parseGoldenName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME) {
    throw new GoldenError("invalid_config", `A golden name must be 1 to ${MAX_NAME} characters.`);
  }
  if ([...trimmed].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new GoldenError("invalid_config", "A golden name cannot contain control characters.");
  }
  return trimmed;
}

/** `--repo <url>[@branch]`, repeated. A branch may contain slashes. */
export function splitRepoArg(arg: string): { url: string; branch?: string } {
  if (arg.startsWith("git@")) {
    const at = arg.indexOf("@", 4);
    if (at === -1) return { url: arg };
    const url = arg.slice(0, at);
    const branch = arg.slice(at + 1);
    if (!isScpUrl(url)) {
      throw new GoldenError("invalid_config", `Repository '${showUrl(arg)}' is not a git URL.`);
    }
    if (!isBranch(branch)) throw badBranch(branch);
    return { url, branch };
  }
  const at = arg.lastIndexOf("@");
  if (at > 0) {
    const url = arg.slice(0, at);
    const branch = arg.slice(at + 1);
    if (isRemoteUrl(url)) {
      if (!isBranch(branch)) throw badBranch(branch);
      return { url, branch };
    }
  }
  return { url: arg };
}

export function configFromFlags(repos: readonly string[], init: readonly string[]): GoldenConfig {
  if (repos.length === 0) throw new GoldenError("invalid_config", "A golden needs at least one --repo.");
  return parseGoldenConfig({
    repos: repos.map((arg) => {
      const split = splitRepoArg(arg);
      return split.branch === undefined ? { url: split.url } : { url: split.url, branch: split.branch };
    }),
    init: [...init],
  });
}

export function parseGoldenConfig(input: unknown): GoldenConfig {
  if (!isRecord(input)) throw new GoldenError("invalid_config", "Golden config must be a JSON object.");
  const secret = secretKeyPath(input);
  if (secret) {
    throw new GoldenError("invalid_config", `Golden config must not contain secrets (key "${secret}").`);
  }
  for (const key of Object.keys(input)) {
    if (key !== "repos" && key !== "init") {
      throw new GoldenError("invalid_config", `Unknown golden config key '${key}'.`);
    }
  }
  if (!Array.isArray(input.repos)) throw new GoldenError("invalid_config", "Golden config needs a repos array.");
  if (input.repos.length < 1 || input.repos.length > MAX_REPOS) {
    throw new GoldenError("invalid_config", `A golden needs 1 to ${MAX_REPOS} repositories.`);
  }
  const drafts = input.repos.map((repo) => parseRepo(repo));
  const init = parseInit(input.init);
  for (const command of init) {
    const assigned = secretAssignment(command);
    if (assigned) {
      throw new GoldenError("invalid_config", `Golden config must not contain secrets (key "${assigned}").`);
    }
  }
  return { repos: assignDirs(drafts), init };
}

export function cloneCommand(repo: GoldenRepo): ShellCommand {
  // No credential helper and no prompt: a private URL fails instead of baking a token into the disk.
  const command = [
    "env",
    "GIT_TERMINAL_PROMPT=0",
    "git",
    "-c",
    "credential.helper=",
    "clone",
    "--branch",
    repo.branch,
    "--single-branch",
    repo.url,
    repo.dir,
  ]
    .map(shQuote)
    .join(" ");
  // `env` and `git` and the flags are fixed words; only branch, url and dir come from the config.
  // Quoting every word keeps a branch or a URL from being read as shell syntax.
  return { command, cwd: GOLDEN_ROOT, timeoutSeconds: CLONE_TIMEOUT_SECONDS };
}

/** Brings one checkout up to date with its stored branch. Fast-forward only, and never asks for credentials. */
export function pullCommand(repo: GoldenRepo): ShellCommand {
  const command = [
    "env",
    "GIT_TERMINAL_PROMPT=0",
    "git",
    "-c",
    "credential.helper=",
    "pull",
    "--ff-only",
    "origin",
    repo.branch,
  ]
    .map(shQuote)
    .join(" ");
  return { command, cwd: `${GOLDEN_ROOT}/${repo.dir}`, timeoutSeconds: CLONE_TIMEOUT_SECONDS };
}

export function initCommand(command: string): ShellCommand {
  return { command, cwd: GOLDEN_ROOT, timeoutSeconds: INIT_TIMEOUT_SECONDS };
}

function parseRepo(input: unknown): { url: string; branch: string; dir?: string } {
  if (!isRecord(input)) throw new GoldenError("invalid_config", "A repository must be an object.");
  for (const key of Object.keys(input)) {
    if (key !== "url" && key !== "branch" && key !== "dir") {
      throw new GoldenError("invalid_config", `Unknown repository key '${key}'.`);
    }
  }
  if (typeof input.url !== "string") throw new GoldenError("invalid_config", "A repository needs a url.");
  const url = parseRepoUrl(input.url);
  const branch = input.branch === undefined ? "main" : input.branch;
  if (typeof branch !== "string" || !isBranch(branch)) throw badBranch(typeof branch === "string" ? branch : "");
  if (input.dir === undefined) return { url, branch };
  if (typeof input.dir !== "string" || !DIR.test(input.dir)) {
    throw new GoldenError("invalid_config", "A repository directory must be a single path segment.");
  }
  return { url, branch, dir: input.dir };
}

function parseInit(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new GoldenError("invalid_config", "Golden init must be an array of commands.");
  if (input.length > MAX_INIT) {
    throw new GoldenError("invalid_config", `A golden can run at most ${MAX_INIT} init commands.`);
  }
  return input.map((command, index) => {
    if (
      typeof command !== "string" ||
      command.trim() === "" ||
      command.length > MAX_COMMAND ||
      command.includes("\0")
    ) {
      throw new GoldenError("invalid_config", `Init command ${index + 1} must be a non-empty string.`);
    }
    return command;
  });
}

/** Assigns each repo a single-segment directory: its own `dir`, else the URL's basename, with a `-2`, `-3`, ... suffix on collision. */
export function assignDirs(repos: { url: string; branch: string; dir?: string }[]): GoldenRepo[] {
  const used = new Set<string>();
  return repos.map((repo) => {
    let dir = repo.dir ?? basename(repo.url);
    if (!DIR.test(dir)) {
      throw new GoldenError(
        "invalid_config",
        `Repository '${showUrl(repo.url)}' needs a directory name of letters, digits, dots, underscores or dashes.`,
      );
    }
    if (used.has(dir)) {
      if (repo.dir !== undefined) {
        throw new GoldenError("invalid_config", `Repository directory '${dir}' is used twice.`);
      }
      let suffix = 2;
      while (used.has(`${dir}-${suffix}`)) suffix += 1;
      dir = `${dir}-${suffix}`;
    }
    used.add(dir);
    return { url: repo.url, branch: repo.branch, dir };
  });
}

function parseRepoUrl(value: string): string {
  if (isScpUrl(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GoldenError("invalid_config", `Repository '${showUrl(value)}' is not a git URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new GoldenError("invalid_config", "A repository URL must be https or ssh.");
  }
  if (url.password !== "" || (url.username !== "" && url.username !== "git")) {
    throw new GoldenError("invalid_config", "A repository URL must not contain credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new GoldenError("invalid_config", "A repository URL must not contain a query or a fragment.");
  }
  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") {
    throw new GoldenError("invalid_config", "A repository URL needs a host and a path.");
  }
  return value;
}

function isBranch(value: string): boolean {
  return BRANCH.test(value);
}

function badBranch(branch: string): GoldenError {
  const shown = branch === "" ? "empty" : `'${clip(branch, 40)}'`;
  return new GoldenError("invalid_config", `Branch ${shown} is not a branch name.`);
}

function isScpUrl(value: string): boolean {
  return /^git@[\w.-]+:[\w./~-]+$/.test(value) && !value.includes("..");
}

function isRemoteUrl(value: string): boolean {
  if (isScpUrl(value)) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      (url.username === "" || url.username === "git") &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname !== "" &&
      url.pathname !== "" &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

function basename(url: string): string {
  const path = url.startsWith("git@") ? url.slice(url.indexOf(":") + 1) : new URL(url).pathname;
  const last =
    path
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? "";
  return last.endsWith(".git") ? last.slice(0, -4) : last;
}

/** The first secret-like key, as the database reports it (`env.token`). */
export function secretKeyPath(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = secretKeyPath(item);
      if (nested) return nested;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) return key;
    const nested = secretKeyPath(item);
    if (nested) return `${key}.${nested}`;
  }
  return null;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replaceAll("-", "_"));
}

function secretAssignment(command: string): string | null {
  const pattern = /(?:^|[\s;&|`(])([A-Za-z_][A-Za-z0-9_-]{0,128})=/g;
  for (const match of command.matchAll(pattern)) {
    const key = match[1];
    if (key && isSecretKey(key)) return key;
  }
  return null;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function showUrl(value: string): string {
  if (value.includes("@") && value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.password !== "" || (url.username !== "" && url.username !== "git"))
        return `${url.protocol}//${url.host}/…`;
    } catch {
      return "invalid-url";
    }
  }
  return clip(value, 80);
}

function clip(value: string, max: number): string {
  const oneLine = value.replaceAll(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`;
}
