import type { Visibility } from "./contract.ts";
import type { GoldenActor } from "./golden.ts";
import { assignDirs, GOLDEN_ROOT, GoldenError, parseGoldenName } from "./golden-config.ts";
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
    input: { name: string; visibility: Visibility; repos: string[]; setup?: string },
  ): Promise<{ snapshot: string }> {
    if (input.visibility === "org" && actor.role !== "admin")
      throw new GoldenError("forbidden", "Only an admin can create an org golden.");
    const name = parseGoldenName(input.name);
    if (input.repos.length < 1 || input.repos.length > MAX_REPOS) {
      throw new GoldenError("invalid_config", `A golden needs 1 to ${MAX_REPOS} repositories.`);
    }
    const { repos, token: callerToken } = await this.deps.authorize(actor, input.visibility, input.repos);
    if (!repos.length) throw new GoldenError("invalid_config", "A golden needs at least one authorized repository.");
    const installations = new Set(repos.map((r) => r.installationId));
    if (installations.size !== 1)
      throw new GoldenError("invalid_config", "Repositories must belong to one GitHub App installation.");
    const prepared = withGoldenDirs(repos);
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
        script: goldenScript(prepared, input.setup ?? ""),
      });
      await this.deps.scan(provider, builder.id);
      const snapshot = `golden-${builder.id}`;
      const saved = await provider.snapshot({ sandboxId: builder.id, name: snapshot });
      if (saved.status !== "ready") throw new GoldenError("snapshot_failed", "Golden snapshot did not become ready.");
      await this.deps.persist({ actor, name, visibility: input.visibility, repos: prepared, snapshot });
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

export function goldenScript(repos: readonly PreparedRepo[], setup = ""): string {
  const lines = [
    "set -euo pipefail",
    'cleanup_armada_key() { if [ -n "${ARMADA_SSH_PUBLIC_KEY:-}" ]; then mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; grep -Fvx "$ARMADA_SSH_PUBLIC_KEY" "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.armada.$$" || true; mv "$HOME/.ssh/authorized_keys.armada.$$" "$HOME/.ssh/authorized_keys"; unset ARMADA_SSH_PUBLIC_KEY; fi; unset ARMADA_GIT_TOKEN; }',
    "trap 'cleanup_armada_key' EXIT",
    "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$ARMADA_GIT_TOKEN; }; f'",
    ...repos.map(
      (r) =>
        `git clone --branch ${safe(r.branch ?? "main")} --single-branch https://github.com/${safe(r.owner)}/${safe(r.repo)}.git ${GOLDEN_ROOT}/${safe(r.dir)}`,
    ),
    "git config --global --unset credential.helper || true",
    "unset ARMADA_GIT_TOKEN",
    // #491 baseline, generalized to the first repo: a pinned Bun (from its packageManager) beats
    // whatever bun.sh last published, and a pinned @playwright/test beats an unpinned "latest" Chromium.
    repos[0] &&
      [
        `primary=${GOLDEN_ROOT}/${safe(repos[0].dir)}`,
        'bun_pin=$(grep -o \'"packageManager"[[:space:]]*:[[:space:]]*"bun@[^"]*"\' "$primary/package.json" 2>/dev/null | sed -E \'s/.*"bun@([^"]*)"/\\1/\')',
        'if [ -n "${bun_pin:-}" ]; then npm install --global --prefix "$HOME/.bun-npm" "bun@$bun_pin"; export PATH="$HOME/.bun-npm/bin:$PATH"; fi',
        'command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }',
        'if command -v bun >/dev/null 2>&1; then pw_pin=$(grep -o \'"@playwright/test"[[:space:]]*:[[:space:]]*"[0-9][^"]*"\' "$primary/package.json" 2>/dev/null | sed -E \'s/.*:[[:space:]]*"([^"]*)"/\\1/\'); if [ -n "${pw_pin:-}" ]; then bunx --bun --package "@playwright/test@$pw_pin" playwright install --with-deps chromium; else bunx playwright install --with-deps chromium; fi; fi',
      ].join("\n"),
    // boat.dev's golden-builder image already carries the claude and codex CLIs; this only confirms it.
    "command -v claude >/dev/null 2>&1 || true; command -v codex >/dev/null 2>&1 || true",
    setup,
    `if grep -rIlE --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 'gh[suo]_[A-Za-z0-9_-]+' ${GOLDEN_ROOT} >/dev/null; then exit 97; fi`,
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}
function safe(v: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) throw new GoldenError("invalid_config", "Unsafe repository path.");
  return v;
}
