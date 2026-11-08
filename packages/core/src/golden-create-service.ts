import type { GoldenActor } from "./golden.ts";
import type { Provider } from "./provider.ts";
import type { Visibility } from "./contract.ts";
import { GoldenError, parseGoldenName } from "./golden-config.ts";

export interface AuthorizedRepo {
  owner: string;
  repo: string;
  id: number;
  installationId: number;
  branch?: string;
}
export interface GoldenCreateDeps {
  authorize(actor: GoldenActor, visibility: Visibility, repos: string[]): Promise<AuthorizedRepo[]>;
  mint(installationId: number, repoIds: number[]): Promise<{ token: string; revoke(): Promise<void> }>;
  ssh(provider: Provider, input: { sandboxId: string; token: string; script: string }): Promise<void>;
  scan(sandboxId: string): Promise<void>;
  persist(input: {
    actor: GoldenActor;
    name: string;
    visibility: Visibility;
    repos: AuthorizedRepo[];
    snapshot: string;
  }): Promise<void>;
}
/** Coordinates a disposable no-env builder; only a fully scanned snapshot is persisted. */
export class GoldenCreateService {
  constructor(private readonly deps: GoldenCreateDeps) {}
  async create(
    provider: Provider,
    actor: GoldenActor,
    input: { name: string; visibility: Visibility; repos: string[] },
  ): Promise<{ snapshot: string }> {
    if (input.visibility === "org" && actor.role !== "admin")
      throw new GoldenError("forbidden", "Only an admin can create an org golden.");
    const name = parseGoldenName(input.name);
    const repos = await this.deps.authorize(actor, input.visibility, input.repos);
    if (!repos.length) throw new GoldenError("invalid_config", "A golden needs at least one authorized repository.");
    const installations = new Set(repos.map((r) => r.installationId));
    if (installations.size !== 1)
      throw new GoldenError("invalid_config", "Repositories must belong to one GitHub App installation.");
    const builder = await provider.createGolden({ name, ttlSeconds: 86400, labels: { armada: "golden-builder" } });
    let issued: { token: string; revoke(): Promise<void> } | undefined;
    try {
      issued = await this.deps.mint(
        repos[0]!.installationId,
        repos.map((r) => r.id),
      );
      await this.deps.ssh(provider, { sandboxId: builder.id, token: issued.token, script: goldenScript(repos) });
      await this.deps.scan(builder.id);
      const snapshot = `golden-${builder.id}`;
      const saved = await provider.snapshot({ sandboxId: builder.id, name: snapshot });
      if (saved.status === "failed") throw new GoldenError("snapshot_failed", "Golden snapshot failed.");
      await this.deps.persist({ actor, name, visibility: input.visibility, repos, snapshot });
      return { snapshot };
    } catch (e) {
      throw e;
    } finally {
      await issued?.revoke().catch(() => {});
      await provider.stop({ sandboxId: builder.id }).catch(() => {});
    }
  }
}
export function goldenScript(repos: AuthorizedRepo[]): string {
  const lines = [
    "set -euo pipefail",
    "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$ARMADA_GIT_TOKEN; }; f'",
    ...repos.map(
      (r) =>
        `mkdir -p /home/user/${safe(r.owner)} && git clone --branch ${safe(r.branch ?? "main")} --single-branch https://github.com/${safe(r.owner)}/${safe(r.repo)}.git /home/user/${safe(r.owner)}/${safe(r.repo)}`,
    ),
    "git config --global --unset credential.helper || true",
    "unset ARMADA_GIT_TOKEN",
    "export PATH=$HOME/.bun/bin:$PATH",
    "command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash",
    "command -v playwright >/dev/null 2>&1 || true",
    "find /home/user -type f -not -path '*/.git/*' -print0 | xargs -0 grep -IlE 'gh[su]_[A-Za-z0-9_-]+' >/dev/null && exit 97 || true",
  ];
  return lines.join("\n") + "\n";
}
function safe(v: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) throw new GoldenError("invalid_config", "Unsafe repository path.");
  return v;
}
