import { GOLDEN_ROOT, GoldenError, type GoldenRepo } from "./golden-config.ts";
import type { Harness } from "./contract.ts";

const DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const REPO = /^([^/\s]+)\/([^/\s]+)$/;

/** The selected golden repository and its immutable work directory. */
export interface LaunchWorkdir {
  repo: GoldenRepo;
  cwd: string;
}

/**
 * Resolves a recorded `owner/repo` selector without accepting a path supplied by a caller.
 * A golden with several matching canonical repositories is intentionally ambiguous.
 */
export function resolveLaunchWorkdir(repos: readonly GoldenRepo[], selector: string): LaunchWorkdir {
  return resolveLaunchWorkdirAt(repos, selector, GOLDEN_ROOT);
}

/** Resolves the same recorded repository under an explicit root for an isolated launcher host. */
export function resolveLaunchWorkdirAt(repos: readonly GoldenRepo[], selector: string, root: string): LaunchWorkdir {
  const wanted = parseSelector(selector);
  const matches = repos.filter((repo) => repositoryIdentity(repo.url) === wanted);
  if (matches.length === 0) throw new GoldenError("not_found", `Golden has no repository '${selector}'.`);
  if (matches.length !== 1) throw new GoldenError("conflict", `Golden repository '${selector}' is ambiguous.`);
  const repo = matches[0];
  if (!repo || !DIR.test(repo.dir) || !isRoot(root))
    throw new GoldenError("invalid_config", "Golden repository directory is invalid.");
  return { repo, cwd: `${root}/${repo.dir}` };
}

/**
 * Builds an Armada-side shell wrapper that establishes the recorded directory before native agent exec.
 * Codex receives no caller cwd override: `-C`/`--cd` are stripped through `--`, while Claude uses shell cd.
 */
export function nativeHarnessWrapper(harness: Harness, workdir: LaunchWorkdir, argv: readonly string[]): string {
  const executable = harness === "codex" ? "codex" : "claude";
  const safeArgv = harness === "codex" ? stripCodexWorkdirOverrides(argv) : [...argv];
  return `cd -- ${quote(workdir.cwd)} && exec ${quote(executable)}${safeArgv.map((arg) => ` ${quote(arg)}`).join("")}`;
}

function isRoot(value: string): boolean {
  return value.startsWith("/") && !value.endsWith("/") && !value.includes("\0");
}

function parseSelector(value: string): string {
  const match = REPO.exec(value);
  if (!match || !match[1] || !match[2]) throw new GoldenError("invalid_config", "Repository must be owner/repo.");
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

function repositoryIdentity(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    const match = /^[^@]+@[^:]+:(.+)$/.exec(url);
    path = match?.[1] ?? "";
  }
  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?$/.exec(path);
  return match?.[1] && match[2] ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : null;
}

function stripCodexWorkdirOverrides(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") return [...result, "--", ...argv.slice(index + 1)];
    if (arg === "-C" || arg === "--cd") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--cd=")) continue;
    result.push(arg);
  }
  return result;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
