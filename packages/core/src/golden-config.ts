import { isRecord } from "./record.ts";
import { shellQuote as shQuote } from "./shell-quote.ts";
/** Where a golden's repositories are cloned. Launch pulls the same directories. */
export const GOLDEN_ROOT = "/home/user";

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
  | "snapshot_failed"
  | "build_failed";

export class GoldenError extends Error {
  override readonly name = "GoldenError";
  readonly code: GoldenErrorCode;
  readonly safeReason: "skillpack_integrity_failed" | undefined;
  /** Curated public diagnostic only. Never supply upstream messages, output or command text. */
  readonly safeMessage: string | undefined;
  readonly safePhase: string | undefined;

  constructor(
    code: GoldenErrorCode,
    message: string,
    options?: { cause?: unknown; safeReason?: "skillpack_integrity_failed"; safeMessage?: string; safePhase?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.safeReason = options?.safeReason;
    this.safeMessage = options?.safeMessage;
    this.safePhase = options?.safePhase;
  }
}

export interface GoldenRepo<Branch extends string | undefined = string> {
  url: string;
  branch: Branch;
  /** A single directory under {@link GOLDEN_ROOT}. */
  dir: string;
  /** Explicit per-repository checkout history; omission preserves the provider's existing default. */
  history?: "full" | "shallow";
}

/** The versionable golden file, and the `goldens.config` object. No secrets. */
export interface GoldenConfig<Branch extends string | undefined = string> {
  repos: GoldenRepo<Branch>[];
  init: string[];
}

/** A GitHub-only representation safe to hand to the server's checkout authorization layer. */
export interface GitHubGoldenConfig<Branch extends string | undefined = string> {
  repos: { owner: string; repo: string; branch: Branch; dir: string; history?: "full" | "shallow" }[];
  init: string[];
}

/**
 * Converts an already-validated v2 golden config into GitHub repository identities. This intentionally
 * accepts no arbitrary git host or credential-bearing URL: checkout authorization owns the token.
 */
export function normalizeGitHubGoldenConfig<Branch extends string | undefined>(
  config: GoldenConfig<Branch>,
): GitHubGoldenConfig<Branch> {
  return {
    repos: config.repos.map((repo) => ({
      ...githubRepoIdentity(repo.url),
      branch: repo.branch,
      dir: repo.dir,
      ...(repo.history !== undefined ? { history: repo.history } : {}),
    })),
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

export function configFromFlags(repos: readonly string[], init: readonly string[]): GoldenConfig;
export function configFromFlags(
  repos: readonly string[],
  init: readonly string[],
  mode: "snapshot",
): GoldenConfig<string | undefined>;
export function configFromFlags(repos: readonly string[], init: readonly string[], mode?: "snapshot") {
  if (repos.length === 0) throw new GoldenError("invalid_config", "A golden needs at least one --repo.");
  const input = {
    repos: repos.map((arg) => {
      const split = splitRepoArg(arg);
      return split.branch === undefined ? { url: split.url } : { url: split.url, branch: split.branch };
    }),
    init: [...init],
  };
  return mode === "snapshot" ? parseSnapshotConfig(input) : parseGoldenConfig(input);
}

/** Add repositories without replacing stored branches, directories or initialization commands.
 * Repeating the same addition is a no-op so a successful admission remains recoverable.
 */
export function addGoldenRepositories(existing: GoldenConfig, additions: readonly string[]): GoldenConfig {
  if (!additions.length) throw new GoldenError("invalid_config", "Pass at least one --add-repo URL.");
  const current = parseGoldenConfig(existing);
  const requested = configFromFlags(additions, []);
  const repos = [...current.repos];
  const identities = new Map(
    normalizeGitHubGoldenConfig(current).repos.map((repo, index) => [
      `${repo.owner}/${repo.repo}`.toLowerCase(),
      current.repos[index]!,
    ]),
  );
  for (const [index, identity] of normalizeGitHubGoldenConfig(requested).repos.entries()) {
    const key = `${identity.owner}/${identity.repo}`.toLowerCase();
    const prior = identities.get(key);
    const addition = requested.repos[index]!;
    if (prior) {
      if (prior.branch !== addition.branch)
        throw new GoldenError(
          "invalid_config",
          "This repository already has a different branch in the golden. Use --config with the complete desired repository list to change it.",
        );
      continue;
    }
    repos.push(addition);
    identities.set(key, addition);
  }
  try {
    return parseGoldenConfig({ repos, init: current.init });
  } catch (error) {
    if (error instanceof GoldenError)
      throw new GoldenError(
        "invalid_config",
        `${error.message} Use --config with the complete desired repository list and distinct directories.`,
      );
    throw error;
  }
}

export function parseGoldenConfig(input: unknown): GoldenConfig {
  return parseConfig(input, "main");
}

/** Snapshot build requests retain an omitted branch until the server resolves it through GitHub. */
export function parseSnapshotConfig(input: unknown): GoldenConfig<string | undefined> {
  return parseConfig(input, undefined);
}

function parseConfig<Branch extends string | undefined>(
  input: unknown,
  defaultBranch: Branch,
): GoldenConfig<string | Branch> {
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
  const drafts = input.repos.map((repo) => parseRepo(repo, defaultBranch));
  const init = parseInit(input.init);
  for (const command of init) {
    const assigned = secretAssignment(command);
    if (assigned) {
      throw new GoldenError("invalid_config", `Golden config must not contain secrets (key "${assigned}").`);
    }
  }
  return { repos: assignDirs(drafts), init };
}

export const REPOSITORY_FETCH_FAILED_EXIT = 75;
export const REPOSITORY_FETCH_FAILED_MARKER = "ARMADA_REPOSITORY_FETCH_FAILED";

/** First line of the hook that records pushes; the observer requires it before trusting the ledger. */
export const PUSH_LEDGER_MARKER = "# armada-push-ledger v1";
/**
 * Per-repository ledger in the common Git directory, one `<unix time>\t<branch>\t<sha>`
 * line per confirmed push. A `<unix time>\t!push\t<pid>\t<branch>\t<sha>` line
 * records an attempt before the remote answers; a `<unix time>\t!gap` line
 * records a push the ledger could not attribute.
 */
export const PUSH_LEDGER_FILE = "armada-pushes";
/** Hooks that must all carry the marker for the ledger to prove coverage. */
export const PUSH_LEDGER_HOOKS = ["reference-transaction", "pre-push"] as const;
/**
 * Armada's hooks directory in the common Git directory. `core.hooksPath` points
 * to it; its `chained` file names the repository's own hooks directory, whose
 * hooks still run with their arguments, input and exit status.
 */
export const PUSH_LEDGER_HOOKS_DIR = "armada-hooks";
// Client-side hooks other than the ledger's, forwarded unchanged. Receiving-side
// hooks (push-to-checkout changes behaviour by merely existing) are left out.
const forwardedHooks = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "pre-auto-gc",
  "post-index-change",
  "sendemail-validate",
];
// The repository's own hook of the same name, when it would have run.
const chainedHook = `chain="$(cat "\${0%/*}/chained" 2>/dev/null)" && [ -n "$chain" ] && chain="$chain/\${0##*/}" && [ -x "$chain" ] || chain=`;
const forwardHook = `#!/bin/sh
${chainedHook}
[ -n "$chain" ] || exit 0
exec "$chain" "$@"
`;
// Runs the repository's own hook with the same input; exits with its status.
const runChained = `if [ -n "$input" ]; then printf '%s\\n' "$input"; fi | "$chain" "$@"`;

// Git updates the tracking ref only for a ref the remote accepted, in the same
// process that ran pre-push, even when the tracking ref already held the SHA
// (recreating a deleted branch). That update confirms the attempt pre-push
// recorded for this process. A reference-transaction hook cannot be skipped
// with --no-verify and runs after the tracking ref's reflog entry is written, so
// without an attempt "update by push" still separates a push from a fetch. The
// ledger survives pruning or deleting the tracking ref, which also deletes that
// ref's reflog. An origin-tracking update without its reflog entry (reflogs
// disabled) cannot be told apart from a push: it is a gap.
const referenceTransactionHook = `#!/bin/sh
${PUSH_LEDGER_MARKER}
input=$(cat)
if [ "$1" = committed ] && ledger="$(git rev-parse --git-common-dir)/${PUSH_LEDGER_FILE}"; then
  printf '%s\\n' "$input" | while read -r old new ref; do
    case "$ref" in refs/remotes/origin/HEAD) continue ;; refs/remotes/origin/*) ;; *) continue ;; esac
    case "$new" in ref:*) continue ;; *[!0]*) ;; *) continue ;; esac
    entry="$(git reflog show --format='%H %gs' -n 1 "$ref" -- 2>/dev/null)"
    if [ -f "$ledger" ] && awk -F '\\t' -v pid="$PPID" -v ref="\${ref#refs/remotes/origin/}" -v sha="$new" -v since="$(($(date +%s) - 3600))" \\
      '$2 == "!push" && $3 == pid && $4 == ref && $5 == sha && $1 + 0 >= since { found = 1 } END { exit !found }' "$ledger"; then
      printf '%s\\t%s\\t%s\\n' "$(date +%s)" "\${ref#refs/remotes/origin/}" "$new" >>"$ledger"
    elif [ "$entry" = "$new update by push" ]; then
      printf '%s\\t%s\\t%s\\n' "$(date +%s)" "\${ref#refs/remotes/origin/}" "$new" >>"$ledger"
    elif [ "\${entry%% *}" != "$new" ]; then
      printf '%s\\t!gap\\n' "$(date +%s)" >>"$ledger"
    fi
  done
fi
${chainedHook}
[ -n "$chain" ] || exit 0
${runChained}
`;

// The reference-transaction hook only sees pushes that update an origin-tracking
// ref. A push to a URL or another remote, or through origin without the wide
// tracking refspec, updates none: record it as a gap before it happens. Every
// branch update the repository's own hook allowed is recorded as an attempt
// with this push's process; only the tracking update above confirms it, so a
// rejected push is never push evidence.
const prePushHook = `#!/bin/sh
${PUSH_LEDGER_MARKER}
input=$(cat)
${chainedHook}
if [ -n "$chain" ]; then ${runChained} || exit; fi
ledger="$(git rev-parse --git-common-dir)/${PUSH_LEDGER_FILE}" || exit 0
if [ "$1" != origin ] || ! git config --get-all remote.origin.fetch | grep -qx '+\\{0,1\\}refs/heads/\\*:refs/remotes/origin/\\*'; then
  printf '%s\\t!gap\\n' "$(date +%s)" >>"$ledger"
  exit 0
fi
printf '%s\\n' "$input" | while read -r lref sha remote old; do
  case "$remote" in refs/heads/*) ;; *) continue ;; esac
  case "$sha" in *[!0]*) ;; *) continue ;; esac
  printf '%s\\t!push\\t%s\\t%s\\t%s\\n' "$(date +%s)" "$PPID" "\${remote#refs/heads/}" "$sha" >>"$ledger"
done
exit 0
`;

const writeHook = (name: string, body: string) =>
  `printf '%s' ${shQuote(body)} >"$own/${name}" && chmod +x "$own/${name}"`;

/**
 * Installs the push ledger hooks in the current repository without touching its
 * own hooks: Armada's hooks directory forwards to them, and `core.hooksPath` is
 * switched only once every hook is written. Reinstalling after a tool moved
 * `core.hooksPath` chains the new directory. A relative `core.hooksPath` is
 * chained as written: Git runs hooks from the root of the invoking worktree,
 * so each linked worktree keeps resolving it against its own checkout.
 */
export const pushLedgerInstall = `{ own="$(git rev-parse --git-common-dir)" && own="$(cd "$own" && pwd -P)/${PUSH_LEDGER_HOOKS_DIR}" && hooks="$(git rev-parse --git-path hooks)" && configured="$(git config --type=path --get core.hooksPath || :)" && case "$configured" in /*) configured= ;; esac && case "$hooks" in /*) ;; *) hooks="$(pwd)/$hooks" ;; esac && { [ ! -d "$hooks" ] || hooks="$(cd "$hooks" && pwd -P)"; } && mkdir -p "$own" && { [ "$hooks" = "$own" ] || printf '%s\\n' "\${configured:-$hooks}" >"$own/chained"; } && ${[...forwardedHooks.map((name) => writeHook(name, forwardHook)), writeHook("reference-transaction", referenceTransactionHook), writeHook("pre-push", prePushHook)].join(" && ")} && git config --local core.hooksPath "$own"; } >/dev/null 2>&1 || :`;

/** Fast-forward refresh using the caller-authorized helper already installed by launch. Never prompts. */
export function pullCommand(repo: GoldenRepo, trackPushes = false): ShellCommand {
  // Fetch cannot mutate the checkout. Only its completed failures may safely
  // fall back to the snapshot; merge/filter failures can have partial effects.
  // Upgrade the default narrow clone mapping while preserving custom refspecs.
  const singleBranch = shQuote(`+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`);
  const tracking = trackPushes
    ? `if [ "$(git config --local --get-all remote.origin.fetch 2>/dev/null)" = ${singleBranch} ]; then git config --local --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1 || :; fi; ${pushLedgerInstall}; `
    : "";
  const command = `${tracking}if env GIT_TERMINAL_PROMPT=0 git fetch origin ${shQuote(repo.branch)}; then env GIT_TERMINAL_PROMPT=0 git merge --ff-only FETCH_HEAD; else printf '%s\\n' ${REPOSITORY_FETCH_FAILED_MARKER} >&2; exit ${REPOSITORY_FETCH_FAILED_EXIT}; fi`;
  return { command, cwd: `${GOLDEN_ROOT}/${repo.dir}`, timeoutSeconds: CLONE_TIMEOUT_SECONDS };
}

export function initCommand(command: string): ShellCommand {
  return { command, cwd: GOLDEN_ROOT, timeoutSeconds: INIT_TIMEOUT_SECONDS };
}

function parseRepo<Branch extends string | undefined>(
  input: unknown,
  defaultBranch: Branch,
): { url: string; branch: string | Branch; dir?: string; history?: "full" | "shallow" } {
  if (!isRecord(input)) throw new GoldenError("invalid_config", "A repository must be an object.");
  for (const key of Object.keys(input)) {
    if (key !== "url" && key !== "branch" && key !== "dir" && key !== "history") {
      throw new GoldenError("invalid_config", `Unknown repository key '${key}'.`);
    }
  }
  if (typeof input.url !== "string") throw new GoldenError("invalid_config", "A repository needs a url.");
  const url = parseRepoUrl(input.url);
  const requested = input.branch;
  if (requested !== undefined && (typeof requested !== "string" || !isBranch(requested)))
    throw badBranch(typeof requested === "string" ? requested : "");
  const branch = typeof requested === "string" ? requested : defaultBranch;
  if (input.history !== undefined && input.history !== "full" && input.history !== "shallow")
    throw new GoldenError("invalid_config", 'Repository history must be "full" or "shallow".');
  const history = input.history === undefined ? {} : { history: input.history as "full" | "shallow" };
  if (input.dir === undefined) return { url, branch, ...history };
  if (typeof input.dir !== "string" || !DIR.test(input.dir)) {
    throw new GoldenError("invalid_config", "A repository directory must be a single path segment.");
  }
  return { url, branch, dir: input.dir, ...history };
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
export function assignDirs<Branch extends string | undefined>(
  repos: { url: string; branch: Branch; dir?: string; history?: "full" | "shallow" }[],
): GoldenRepo<Branch>[] {
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
    return {
      url: repo.url,
      branch: repo.branch,
      dir,
      ...(repo.history !== undefined ? { history: repo.history } : {}),
    };
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
