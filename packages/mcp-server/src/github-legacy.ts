import { type GitHubResolveDeps, type Provider, resolveGitHubAccess, type Sql, VaultError } from "@armada/core/server";

/** Shared by explicit repair and next-prompt preparation: do not rotate a healthy sibling token. */
export async function refreshLegacyGitHub(
  provider: Provider,
  providerSandboxId: string,
  ownerId: string,
  github: GitHubResolveDeps,
  hydrate: (provider: Provider, id: string, token: string, expiresAt: Date) => Promise<void>,
): Promise<{ login: string } | null> {
  if (provider.id !== "boat" || provider.configureGitHub)
    throw new VaultError("unavailable", "Use the next prompt to reconcile this provider's managed GitHub runtime.");
  const access = await resolveGitHubAccess({ ...github, minimumLifetimeMs: 0 }, ownerId);
  if (access.status === "not_connected") return null;
  if (access.status !== "connected" || !access.expiresAt)
    throw new VaultError(
      "unavailable",
      access.status === "connected" ? "GitHub expiry is unavailable." : access.message,
    );
  await hydrate(provider, providerSandboxId, access.token, access.expiresAt);
  return { login: access.identity.login };
}

/** Called only after the normal prompt authorization/physical-readiness hooks. */
export function createLegacyGitHubPreparation(options: {
  sql: Sql;
  github: GitHubResolveDeps;
  /** Private transport supplied by the server composition root, never provider exec. */
  hydrate(provider: Provider, id: string, token: string, expiresAt: Date): Promise<void>;
}) {
  return async (provider: Provider, id: string): Promise<void> => {
    if (provider.id !== "boat" || provider.configureGitHub) return;
    const row = (
      await options.sql.query<{ owner_id: string; provider_sandbox_id: string }>(
        `select s.owner_id,s.provider_sandbox_id from public.sandboxes s
       join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       where s.id=$1::uuid and s.provider='boat' and s.deleted_at is null
         and s.status in ('starting','ready','running')`,
        [id],
      )
    ).rows[0];
    if (!row) throw new VaultError("forbidden", "The sandbox owner is no longer authorized for GitHub preparation.");
    // Owner identity comes from storage after normal prompt authorization, never guest input.
    await refreshLegacyGitHub(provider, row.provider_sandbox_id, row.owner_id, options.github, options.hydrate);
  };
}
