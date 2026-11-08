import type { GitHubInstallationApp, GitHubResolveDeps } from "./github.ts";
import { resolveGitHubAccess } from "./github.ts";
import type { GoldenActor } from "./golden.ts";
import type { GoldenConfig, GoldenRepo } from "./golden-config.ts";
import { GoldenError } from "./golden-config.ts";
import { type GoldenCreateDeps, GoldenCreateService } from "./golden-create-service.ts";
import { goldenGitHubAdapter } from "./golden-github.ts";
import { scanGoldenSandbox } from "./golden-scan.ts";
import { createSqlGoldenStore, type Sql } from "./golden-store.ts";
import { sshStdinCheckout } from "./ssh-executor.ts";

export interface GoldenCreateOptions {
  /** The privileged database connection the server already holds (shared with the control API). */
  sql: Sql;
  /** How the caller's own cached OAuth access token (#492) is resolved for checkout; never an App token. */
  github: GitHubResolveDeps;
  /**
   * The GitHub App's server-only signing credentials, for an optional scoped, one-hour installation
   * token that is revoked right after checkout. Null (no `GITHUB_APP_PRIVATE_KEY`): checkout uses the
   * caller's own cached token instead, which is never rotated or revoked for a build.
   */
  installationApp: GitHubInstallationApp | null;
  /** GitHub REST calls (repos, installations, installation tokens). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** For tests: overrides the pinned SSH stdin transport, which otherwise spawns real `ssh-keygen`/`ssh`. */
  ssh?: GoldenCreateDeps["ssh"];
}

/**
 * Wires `GoldenCreateService` to the real server: the caller's own cached OAuth token resolves and
 * authorizes the requested repos; checkout uses that token, or a scoped installation token when the
 * App is configured; the pinned SSH stdin transport clones over it; a fail-closed secret scan runs
 * before the snapshot; and only a ready snapshot is persisted, with org/private row level security.
 */
export function createGoldenCreateService(options: GoldenCreateOptions): GoldenCreateService {
  const adapter = goldenGitHubAdapter({
    app: options.installationApp,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    async accessToken(actor: GoldenActor) {
      const access = await resolveGitHubAccess(options.github, actor.userId);
      if (access.status !== "connected") throw new GoldenError("forbidden", access.message);
      return access.token;
    },
  });
  const store = createSqlGoldenStore(options.sql);
  const deps: GoldenCreateDeps = {
    authorize: adapter.authorize,
    ssh: options.ssh ?? ((provider, input) => sshStdinCheckout(provider, input)),
    scan: (provider, sandboxId) => scanGoldenSandbox(provider, sandboxId),
    async persist({ actor, name, visibility, repos, snapshot }) {
      const config: GoldenConfig = {
        repos: repos.map(
          (repo): GoldenRepo => ({
            url: `https://github.com/${repo.owner}/${repo.repo}.git`,
            branch: repo.branch ?? "main",
            dir: repo.dir,
          }),
        ),
        init: [],
      };
      const inserted = await store.insert({ orgId: actor.orgId, name, visibility, ownerId: actor.userId, config });
      await store.setSnapshot(inserted.id, snapshot);
    },
  };
  if (adapter.mint) deps.mint = adapter.mint;
  return new GoldenCreateService(deps);
}
