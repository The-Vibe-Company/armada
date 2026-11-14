import type { Sql } from "../golden-store.ts";

export interface OttoRepositoryScope {
  orgId: string;
  repository: string;
}

export function isOttoUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** GitHub identities are case-insensitive; retain one identity across snapshots and observations. */
export function canonicalOttoRepository(value: string): string | null {
  const name = value.trim().replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/i, "");
  const match = name.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Observation configuration selects connected repositories; it never grants caller visibility. */
export function ottoRepositoryScopes(env: Record<string, string | undefined>): OttoRepositoryScope[] {
  const names =
    env.ARMADA_OTTO_REPOSITORIES?.split(",") ?? (env.ARMADA_OTTO_REPOSITORY ? [env.ARMADA_OTTO_REPOSITORY] : []);
  const orgId = env.ARMADA_OTTO_ORG_ID;
  if (!names.length && !orgId) return [];
  if (!orgId || !isOttoUuid(orgId) || !names.length || names.length > 20)
    throw Error("Invalid Otto repository bindings");
  const repositories = names.map(canonicalOttoRepository);
  if (
    names.some((name) => !/^[\w.-]+\/[\w.-]+$/.test(name.trim())) ||
    repositories.some((name) => name === null) ||
    new Set(repositories).size !== repositories.length
  )
    throw Error("Invalid Otto repository bindings");
  // Preserve partition spelling: existing observation history is keyed by configured repository.
  return names.map((repository) => ({ orgId, repository: repository.trim() }));
}

/** SQL bypasses RLS: membership and golden visibility are both required, even for internal consumers. */
export async function resolveOttoRepositories(
  sql: Sql,
  caller: { userId: string; orgs: readonly { orgId: string }[] },
  orgId: string,
  allowlist?: readonly OttoRepositoryScope[],
): Promise<string[]> {
  if (!caller.orgs.some((org) => org.orgId === orgId)) return [];
  const { rows } = await sql.query<{ config: { repos?: { url?: string }[] } }>(
    `select config from public.goldens where org_id=$1 and (visibility='org' or owner_id=$2)`,
    [orgId, caller.userId],
  );
  const names = new Set<string>();
  for (const row of rows)
    for (const repo of row.config?.repos ?? []) {
      const name = typeof repo.url === "string" ? canonicalOttoRepository(repo.url) : null;
      if (!name) continue;
      const configured = allowlist?.find(
        (scope) => scope.orgId === orgId && canonicalOttoRepository(scope.repository) === name,
      );
      if (!allowlist || configured) names.add(configured?.repository ?? name);
    }
  return [...names].sort();
}
