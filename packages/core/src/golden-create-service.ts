import type { Visibility } from "./contract.ts";
import type { GoldenActor, GoldenLimits, GoldenRecord } from "./golden.ts";
import { assertGoldenMutation, waitSnapshot } from "./golden.ts";
import { assignDirs, type GitHubGoldenConfig, GOLDEN_ROOT, GoldenError, parseGoldenName } from "./golden-config.ts";
import { GITHUB_TOKEN_PATTERN } from "./golden-scan.ts";
import { type Provider, ProviderError } from "./provider.ts";

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
  /** Reserve capacity before any builder starts. Returns an opaque server-only reservation. */
  reserve?(provider: Provider, actor: GoldenActor, existingGolden?: GoldenRecord): Promise<string | undefined>;
  /** Legacy factory hook; production persistence finalizes atomically itself. */
  finalize?(reservationId: string, goldenId: string): Promise<void>;
  release?(reservationId: string): Promise<void>;
  /** Confirm after a persistence error that no committed row references this attempt's artifact.
   * Unknown database outcomes must retain the artifact rather than risk deleting a committed pointer. */
  canDiscardSnapshot?(snapshot: string): Promise<boolean>;
  /** Persist must atomically finalize a reservation when one was taken. */
  persist(input: {
    actor: GoldenActor;
    existingGolden?: GoldenRecord;
    name: string;
    visibility: Visibility;
    repos: PreparedRepo[];
    init: string[];
    snapshot: string;
    builderId: string;
    reservationId?: string;
  }): Promise<string | void>;
}

/** Coordinates a disposable no-env builder; only a fully scanned, ready snapshot is persisted. */
export class GoldenCreateService {
  constructor(private readonly deps: GoldenCreateDeps) {}
  async create(
    provider: Provider,
    actor: GoldenActor,
    input: {
      name: string;
      visibility: Visibility;
      repos: string[];
      setup?: string;
      config?: GitHubGoldenConfig;
      existingGolden?: GoldenRecord;
    },
    limits: GoldenLimits = {},
  ): Promise<{ snapshot: string }> {
    if (input.existingGolden) {
      const existing = input.existingGolden;
      if (existing.orgId !== actor.orgId || existing.name !== input.name)
        throw new GoldenError("forbidden", "You cannot rebuild this golden.");
      assertGoldenMutation(actor, existing);
      if (existing.visibility !== input.visibility)
        throw new GoldenError("forbidden", "You cannot change this golden visibility.");
    }
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
    const prepared = requested ? applyRequestedRepos(repos, requested) : withGoldenDirs(repos);
    const reservation = await this.deps.reserve?.(provider, actor, input.existingGolden);
    let persisted = false;
    let persistAttempted = false;
    let requestedSnapshot: string | undefined;
    let ownedSnapshot: string | undefined;
    let artifactSettled = false;
    let builder: Awaited<ReturnType<Provider["createGolden"]>> | undefined;
    let issued: { token: string; revoke(): Promise<void> } | undefined;
    const buildId = crypto.randomUUID();
    const startedAt = Date.now();
    let phase = "builder";
    const enter = (next: string) => {
      phase = next;
      console.info(JSON.stringify({ event: "golden_build_phase", buildId, phase, elapsedMs: Date.now() - startedAt }));
    };
    try {
      enter("builder");
      builder = await provider.createGolden({ name, ttlSeconds: 86400, labels: { armada: "golden-builder" } });
      // A scoped installation token can cover only one installation. Multiple already-authorized
      // repos use the caller's cached user token, which is never revoked or rotated here.
      enter("checkout_credentials");
      issued =
        this.deps.mint && installations.size === 1
          ? await this.deps.mint(
              repos[0]?.installationId ?? 0,
              repos.map((r) => r.id),
            )
          : { token: callerToken, revoke: () => Promise.resolve() };
      enter("checkout_baseline");
      await this.deps.ssh(provider, {
        sandboxId: builder.id,
        token: issued.token,
        script: goldenScript(prepared, [input.config?.init ?? [], input.setup ? [input.setup] : []].flat()),
      });
      enter("secret_scan");
      await this.deps.scan(provider, builder.id);
      enter("snapshot");
      requestedSnapshot = input.existingGolden ? `golden-r-${crypto.randomUUID()}` : `golden-${builder.id}`;
      // `snapshot` only starts the save; it is asynchronous, so a brand-new snapshot is normally
      // "saving" here and must be polled, exactly like the original golden flow's own snapshot step.
      const started = await provider.snapshot({ sandboxId: builder.id, name: requestedSnapshot });
      const snapshot = started.name;
      // The provider's reference is authoritative, not necessarily the requested label.
      // A remap needs source correlation before we may publish or reclaim that artifact.
      // Never accept the previous pointer, even if a provider reports matching provenance.
      if (!snapshot || snapshot === input.existingGolden?.providerSnapshotId)
        throw new GoldenError("snapshot_failed", "Provider returned an unsafe snapshot reference.");
      if (snapshot !== requestedSnapshot) {
        const provenance = started.sourceSandboxId === undefined ? await provider.getSnapshot(snapshot) : started;
        if (provenance.name !== snapshot || provenance.sourceSandboxId !== builder.id)
          throw new GoldenError("snapshot_failed", "Snapshot source could not be verified.");
      } else if (started.sourceSandboxId !== undefined && started.sourceSandboxId !== builder.id) {
        throw new GoldenError("snapshot_failed", "Snapshot source could not be verified.");
      }
      ownedSnapshot = snapshot;
      const settled = started.status === "ready" ? started : await waitSnapshot(provider, snapshot, limits);
      artifactSettled = true;
      if (settled.status !== "ready") {
        throw new GoldenError("snapshot_failed", settled.error ?? `Snapshot '${snapshot}' failed.`);
      }
      enter("persist");
      persistAttempted = true;
      {
        const goldenId = await this.deps.persist({
          actor,
          ...(input.existingGolden ? { existingGolden: input.existingGolden } : {}),
          name,
          visibility: input.visibility,
          repos: prepared,
          init: [input.config?.init ?? [], input.setup ? [input.setup] : []].flat(),
          snapshot,
          builderId: builder.id,
          ...(reservation ? { reservationId: reservation } : {}),
        });
        if (reservation && goldenId && this.deps.finalize) await this.deps.finalize(reservation, goldenId);
        persisted = true;
      }
      return { snapshot };
    } catch (error) {
      // Never log the thrown object: provider errors can contain bodies, commands or credentials.
      const code = error instanceof GoldenError || error instanceof ProviderError ? error.code : "unknown";
      console.error(
        JSON.stringify({ event: "golden_build_failed", buildId, phase, code, elapsedMs: Date.now() - startedAt }),
      );
      if (error instanceof GoldenError) throw error;
      throw new GoldenError(
        "build_failed",
        `Golden build failed during ${phase} (${code}). Check server phase diagnostics and retry; last-good snapshots are not deleted by failure cleanup.`,
      );
    } finally {
      if (!persisted && requestedSnapshot && builder) {
        // A timed-out request may have created an artifact. Only reclaim a settled artifact
        // with matching source provenance; an in-flight/unknown save is left for reconciliation.
        if (!artifactSettled) {
          try {
            const candidate = ownedSnapshot ?? requestedSnapshot;
            const artifact = await provider.getSnapshot(candidate);
            if (
              candidate !== input.existingGolden?.providerSnapshotId &&
              artifact.name === candidate &&
              artifact.sourceSandboxId === builder.id &&
              artifact.status !== "saving"
            ) {
              ownedSnapshot = candidate;
              artifactSettled = true;
            }
          } catch {
            /* Unknown ownership/state: retain. */
          }
        }
        if (
          ownedSnapshot &&
          artifactSettled &&
          (!persistAttempted || (await this.deps.canDiscardSnapshot?.(ownedSnapshot).catch(() => false)))
        ) {
          await provider.deleteSnapshot(ownedSnapshot).catch(() => {});
        }
      }
      if (!persisted && reservation) await this.deps.release?.(reservation).catch(() => {});
      await issued?.revoke().catch(() => {});
      if (builder) await provider.stop({ sandboxId: builder.id }).catch(() => {});
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
    "armada_phase=bun",
    'if [ -n "$bun_pin" ]; then npm install --global --prefix "$HOME/.bun-npm" "bun@$bun_pin"; mkdir -p "$HOME/.local/bin" "$HOME/.bun/bin"; ln -sf "$HOME/.bun-npm/bin/bun" "$HOME/.local/bin/bun"; ln -sf "$HOME/.bun-npm/bin/bun" "$HOME/.bun/bin/bun"; resolved_bun=$(command -v bun || true); if [ -n "$resolved_bun" ]; then if [ -w "$(dirname "$resolved_bun")" ]; then ln -sf "$HOME/.bun-npm/bin/bun" "$resolved_bun"; else sudo -n ln -sf "$HOME/.bun-npm/bin/bun" "$resolved_bun"; fi; fi; export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; fi',
    'command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }',
    "armada_phase=chromium",
    "if command -v bun >/dev/null 2>&1; then",
    '  if [ -n "$pw_pin" ]; then bunx --bun --package "@playwright/test@$pw_pin" playwright install --with-deps chromium; else bunx playwright install --with-deps chromium; fi',
    "fi",
    "armada_phase=harness",
    "command -v claude >/dev/null 2>&1 || npm install --global @anthropic-ai/claude-code",
    "command -v codex >/dev/null 2>&1 || npm install --global @openai/codex",
  ].join("\n");
}

export function goldenScript(repos: readonly PreparedRepo[], setup: readonly string[] = []): string {
  const lines = [
    "set -euo pipefail",
    CLEANUP_TRAP,
    "armada_phase=checkout",
    `trap 'armada_status=$?; printf "ARMADA_BUILD_FAILURE %s %s\\n" "$armada_phase" "$armada_status" >&2' ERR`,
    // Keep credentials process-local.  The helper accepts only Git's HTTPS credential
    // protocol for github.com, and no global/system configuration can leak into a clone.
    "export GIT_CONFIG_NOSYSTEM=1",
    "export GIT_CONFIG_GLOBAL=/dev/null",
    "export GIT_TERMINAL_PROMPT=0",
    "export GIT_ASKPASS=/bin/false",
    "export GIT_CONFIG_COUNT=1",
    "export GIT_CONFIG_KEY_0=credential.helper",
    'export GIT_CONFIG_VALUE_0=\'!f() { while IFS= read -r line; do case $line in protocol=https|host=github.com|host=github.com:443) ;; *) exit 1 ;; esac; done; printf "username=x-access-token\\npassword=%s\\n" "$ARMADA_GIT_TOKEN"; }; f\'',
    ...repos.map(
      (r) =>
        `git clone --branch ${shellQuote(r.branch ?? "main")} --single-branch https://github.com/${safe(r.owner)}/${safe(r.repo)}.git ${GOLDEN_ROOT}/${safe(r.dir)}`,
    ),
    "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_TERMINAL_PROMPT GIT_ASKPASS",
    "unset ARMADA_GIT_TOKEN",
    baselineSetup(repos),
    "armada_phase=init",
    ...setup,
    // A quick, same-session check; the independent, far more thorough scan (working tree, binaries
    // and every git object, reachable or not) is `scanGoldenSandbox`, run over the provider's own
    // exec channel after this session closes, and is what actually gates the snapshot.
    "armada_phase=inline_scan",
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
