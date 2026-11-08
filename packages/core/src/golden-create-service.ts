import type { Visibility } from "./contract.ts";
import type { GoldenActor, GoldenLimits } from "./golden.ts";
import { waitSnapshot } from "./golden.ts";
import { assignDirs, type GitHubGoldenConfig, GOLDEN_ROOT, GoldenError, parseGoldenName } from "./golden-config.ts";
import { GITHUB_TOKEN_PATTERN } from "./golden-scan.ts";
import type { Provider } from "./provider.ts";

const MAX_REPOS = 16;

export interface AuthorizedRepo {
  owner: string;
  repo: string;
  id: number;
  installationId: number;
  branch?: string;
}

/** An authorized repo with the single-segment directory it is cloned into, shared by the build script and the persisted config. */
export interface PreparedRepo extends AuthorizedRepo {
  dir: string;
}

export interface GoldenCreateDeps {
  /** The caller's own cached OAuth access token (never an App token) and the repos it may build from. */
  authorize(
    actor: GoldenActor,
    visibility: Visibility,
    repos: string[],
  ): Promise<{ repos: AuthorizedRepo[]; token: string }>;
  /**
   * Mints a short-lived, repo-scoped installation token. Optional: absent (no GITHUB_APP_PRIVATE_KEY)
   * means checkout falls back to the caller's own token from `authorize`, which is never revoked.
   */
  mint?(installationId: number, repoIds: number[]): Promise<{ token: string; revoke(): Promise<void> }>;
  ssh(provider: Provider, input: { sandboxId: string; token: string; script: string }): Promise<void>;
  /** Fail-closed secret scan of the builder, before it may be snapshotted. */
  scan(provider: Provider, sandboxId: string): Promise<void>;
  persist(input: {
    actor: GoldenActor;
    name: string;
    visibility: Visibility;
    repos: PreparedRepo[];
    snapshot: string;
  }): Promise<void>;
}

/** Coordinates a disposable no-env builder; only a fully scanned, ready snapshot is persisted. */
export class GoldenCreateService {
  constructor(private readonly deps: GoldenCreateDeps) {}
  async create(
    provider: Provider,
    actor: GoldenActor,
    input: { name: string; visibility: Visibility; repos: string[]; setup?: string; config?: GitHubGoldenConfig },
    limits: GoldenLimits = {},
  ): Promise<{ snapshot: string }> {
    if (input.visibility === "org" && actor.role !== "admin")
      throw new GoldenError("forbidden", "Only an admin can create an org golden.");
    const name = parseGoldenName(input.name);
    const requested = input.config?.repos;
    const requestedCount = requested?.length ?? input.repos.length;
    if (requestedCount < 1 || requestedCount > MAX_REPOS) {
      throw new GoldenError("invalid_config", `A golden needs 1 to ${MAX_REPOS} repositories.`);
    }
    const authorizationRepos = requested ? requested.map(({ owner, repo }) => `${owner}/${repo}`) : input.repos;
    const { repos, token: callerToken } = await this.deps.authorize(actor, input.visibility, authorizationRepos);
    if (!repos.length) throw new GoldenError("invalid_config", "A golden needs at least one authorized repository.");
    const installations = new Set(repos.map((r) => r.installationId));
    if (installations.size !== 1)
      throw new GoldenError("invalid_config", "Repositories must belong to one GitHub App installation.");
    const prepared = requested ? applyRequestedRepos(repos, requested) : withGoldenDirs(repos);
    const builder = await provider.createGolden({ name, ttlSeconds: 86400, labels: { armada: "golden-builder" } });
    let issued: { token: string; revoke(): Promise<void> } | undefined;
    try {
      issued = this.deps.mint
        ? await this.deps.mint(
            repos[0]?.installationId ?? 0,
            repos.map((r) => r.id),
          )
        : { token: callerToken, revoke: () => Promise.resolve() };
      await this.deps.ssh(provider, {
        sandboxId: builder.id,
        token: issued.token,
        script: goldenScript(prepared, [input.config?.init ?? [], input.setup ? [input.setup] : []].flat()),
      });
      await this.deps.scan(provider, builder.id);
      const snapshot = `golden-${builder.id}`;
      // `snapshot` only starts the save; it is asynchronous, so a brand-new snapshot is normally
      // "saving" here and must be polled, exactly like the original golden flow's own snapshot step.
      const started = await provider.snapshot({ sandboxId: builder.id, name: snapshot });
      const settled = started.status === "ready" ? started : await waitSnapshot(provider, snapshot, limits);
      if (settled.status !== "ready") {
        throw new GoldenError("snapshot_failed", settled.error ?? `Snapshot '${snapshot}' failed.`);
      }
      try {
        await this.deps.persist({ actor, name, visibility: input.visibility, repos: prepared, snapshot });
      } catch (error) {
        // A ready snapshot nothing tracks is worse than none: remove it so the name and the
        // boat.dev snapshot slot are both free to try again.
        await provider.deleteSnapshot(snapshot).catch(() => {});
        throw error;
      }
      return { snapshot };
    } finally {
      await issued?.revoke().catch(() => {});
      await provider.stop({ sandboxId: builder.id }).catch(() => {});
    }
  }
}

/**
 * The single-segment directory each repo is cloned into, so a golden created this way can later be
 * pulled at launch the same way as one from `armada golden create --repo <url>`: `basename`, with a
 * `-2`, `-3`, ... suffix on collision. The build script and the persisted config call this once each,
 * deterministically, so the two never disagree about where a repo lives.
 */
export function withGoldenDirs(repos: readonly AuthorizedRepo[]): PreparedRepo[] {
  const withDirs = assignDirs(
    repos.map((r) => ({ url: `https://github.com/${r.owner}/${r.repo}.git`, branch: r.branch ?? "main" })),
  );
  return repos.map((repo, index) => ({ ...repo, dir: withDirs[index]?.dir ?? repo.repo }));
}

/** Apply validated requested branch/directory metadata only after authorization resolved canonical GitHub repos. */
export function applyRequestedRepos(
  repos: readonly AuthorizedRepo[],
  requested: readonly GitHubGoldenConfig["repos"][number][],
): PreparedRepo[] {
  if (repos.length !== requested.length)
    throw new GoldenError("invalid_config", "Authorized repositories did not match the request.");
  return repos.map((repo, index) => {
    const wanted = requested[index];
    if (!wanted || repo.owner !== wanted.owner || repo.repo !== wanted.repo) {
      throw new GoldenError("invalid_config", "Authorized repositories did not match the request.");
    }
    return { ...repo, branch: wanted.branch, dir: wanted.dir };
  });
}

/**
 * The EXIT trap's cleanup: removes only the exact transient public key line (not the file's other
 * keys), and fails closed instead of risking an empty `authorized_keys`. `grep -Fvx` exits 1 when
 * the key was the only line (expected: nothing left to keep), which is not an error; anything
 * stricter than that (a real I/O or permission failure) aborts with 96 and leaves the original
 * file alone, rather than overwriting it with a tmpfile that may be empty or incomplete.
 */
const CLEANUP_TRAP = [
  "cleanup_armada_key() {",
  '  if [ -n "${ARMADA_SSH_PUBLIC_KEY:-}" ]; then',
  '    mkdir -p "$HOME/.ssh"',
  '    touch "$HOME/.ssh/authorized_keys"',
  "    set +e",
  '    grep -Fvx "$ARMADA_SSH_PUBLIC_KEY" "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.armada.$$"',
  "    grep_status=$?",
  "    set -e",
  '    if [ "$grep_status" -gt 1 ]; then rm -f "$HOME/.ssh/authorized_keys.armada.$$"; exit 96; fi',
  '    mv "$HOME/.ssh/authorized_keys.armada.$$" "$HOME/.ssh/authorized_keys"',
  "    unset ARMADA_SSH_PUBLIC_KEY",
  "  fi",
  "  unset ARMADA_GIT_TOKEN",
  "}",
  "trap 'cleanup_armada_key' EXIT",
].join("\n");

/**
 * The #491 baseline (a pinned Bun, a pinned Chromium), generalized across every repo instead of
 * just the first: the first `package.json` (in clone order) that names a `packageManager`/
 * `@playwright/test` pin wins. `grep` exits 1 when a file has no such key, which is normal, not an
 * error (hence `|| true`: a missing pin only means "install the latest", never aborts the build
 * under `set -e`); this is a best-effort optimization, not a security boundary, so a real read
 * failure here is tolerated the same way. `claude` and `codex` are actually installed when
 * missing, not merely checked: boat.dev's golden-builder image is expected to carry them, but a
 * build must not silently proceed without them if it does not.
 */
function baselineSetup(repos: readonly PreparedRepo[]): string {
  const dirs = repos.map((r) => safe(r.dir)).join(" ");
  if (!dirs) return "";
  return [
    'bun_pin=""',
    'pw_pin=""',
    `for dir in ${dirs}; do`,
    `  pkg=${GOLDEN_ROOT}/$dir/package.json`,
    '  [ -f "$pkg" ] || continue',
    '  if [ -z "$bun_pin" ]; then',
    '    bun_pin=$(grep -o \'"packageManager"[[:space:]]*:[[:space:]]*"bun@[^"]*"\' "$pkg" 2>/dev/null | sed -E \'s/.*"bun@([^"]*)"/\\1/\') || true',
    "  fi",
    '  if [ -z "$pw_pin" ]; then',
    '    pw_pin=$(grep -o \'"@playwright/test"[[:space:]]*:[[:space:]]*"[0-9][^"]*"\' "$pkg" 2>/dev/null | sed -E \'s/.*:[[:space:]]*"([^"]*)"/\\1/\') || true',
    "  fi",
    "done",
    'if [ -n "$bun_pin" ]; then npm install --global --prefix "$HOME/.bun-npm" "bun@$bun_pin"; export PATH="$HOME/.bun-npm/bin:$PATH"; fi',
    'command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }',
    "if command -v bun >/dev/null 2>&1; then",
    '  if [ -n "$pw_pin" ]; then bunx --bun --package "@playwright/test@$pw_pin" playwright install --with-deps chromium; else bunx playwright install --with-deps chromium; fi',
    "fi",
    "command -v claude >/dev/null 2>&1 || npm install --global @anthropic-ai/claude-code",
    "command -v codex >/dev/null 2>&1 || npm install --global @openai/codex",
  ].join("\n");
}

export function goldenScript(repos: readonly PreparedRepo[], setup: readonly string[] = []): string {
  const lines = [
    "set -euo pipefail",
    CLEANUP_TRAP,
    "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$ARMADA_GIT_TOKEN; }; f'",
    ...repos.map(
      (r) =>
        `git clone --branch ${shellQuote(r.branch ?? "main")} --single-branch https://github.com/${safe(r.owner)}/${safe(r.repo)}.git ${GOLDEN_ROOT}/${safe(r.dir)}`,
    ),
    "git config --global --unset credential.helper || true",
    "unset ARMADA_GIT_TOKEN",
    baselineSetup(repos),
    ...setup,
    // A quick, same-session check; the independent, far more thorough scan (working tree, binaries
    // and every git object, reachable or not) is `scanGoldenSandbox`, run over the provider's own
    // exec channel after this session closes, and is what actually gates the snapshot.
    `if grep -rIlE --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev '${GITHUB_TOKEN_PATTERN}' ${GOLDEN_ROOT} >/dev/null 2>/dev/null; then exit 97; fi`,
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safe(v: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) throw new GoldenError("invalid_config", "Unsafe repository path.");
  return v;
}
