// The credential broker (THE-840): what a signed-in terminal receives from
// the vault, and what the dashboard's own reads use. A terminal receives the
// Linear key: for the project it acts on, the project's own (THE-859), else
// the person's own when they set one, else the organization's; and, when it
// asks, the project's secrets for workers (`releaseWorkerSecrets`). The fleet's live data is never handed out: terminals reach
// it through the Armada API (THE-850). Every call is recorded, never with a
// value. Everything is injected.
import type { Database } from "./db";
import type { Scope } from "./fleet-data";
import {
  type Actor,
  readSecrets,
  readWorkerSecrets,
  recordEvent,
  releasesSince,
  type SecretScope,
  type VaultKey,
} from "./vault";

/** Calls per caller per minute. */
export const RELEASES_PER_MINUTE = 30;

export interface BrokerDeps {
  client: Database;
  vault: VaultKey;
  now?: () => Date;
}

export interface Holder {
  actor: Actor;
  organization: { id: string; name: string; slug: string };
  /** The person, whose own keys win; null for an organization API key. For a worker, who launched it. */
  user: string | null;
  /** The ticket the keys are for, as the terminal names it (a worker's is its own); the audit list shows it. */
  ticket?: string | null;
  /** The project the keys are for (a worker's is its own): its own Linear key wins. */
  project?: string | null;
}

/** The body of `POST /api/cli/credentials`. */
export interface Release {
  schemaVersion: 1;
  organization: { id: string; name: string; slug: string };
  linear: { apiKey: string; scope: "project" | "own" | "organization" } | null;
  /** Why a key the organization set could not be handed out; the CLI prints them. Never a value. */
  warnings: string[];
}

// ------------------------------------------------------------ to a terminal

export type BrokerAnswer = { ok: true; release: Release } | { ok: false; limited: true };

/** Releases the caller's keys, records the release, and refuses beyond the rate limit. */
export async function releaseCredentials(deps: BrokerDeps, holder: Holder): Promise<BrokerAnswer> {
  const now = deps.now?.() ?? new Date();
  if (await limited(deps, holder.actor, now)) return { ok: false, limited: true };

  const { values, own, fromProject, problems } = await readSecrets(deps.client, deps.vault, {
    organization: holder.organization.id,
    user: holder.user,
    project: holder.project ?? null,
  });
  const warnings = [...problems];
  const keys: string[] = [];
  const details: string[] = [];

  const linearKey = values["linear-api-key"] ?? null;
  const scope = fromProject.includes("linear-api-key")
    ? ("project" as const)
    : own.includes("linear-api-key")
      ? ("own" as const)
      : ("organization" as const);
  const linear = linearKey ? { apiKey: linearKey, scope } : null;
  if (linear) {
    keys.push("linear-api-key");
    details.push(
      linear.scope === "project"
        ? "Linear key (the project's)"
        : linear.scope === "own"
          ? "Linear key (their own)"
          : "Linear key (the organization's)",
    );
  } else details.push("nothing to release: no Linear key is set for this organization");

  await recordEvent(deps.client, holder.organization.id, {
    at: now.toISOString(),
    action: "release",
    project: holder.project ?? "",
    keys,
    actor: holder.actor,
    detail: [...(holder.ticket ? [`for ${holder.ticket}`] : []), ...details, ...warnings.map((w) => `! ${w}`)].join(
      "; ",
    ),
  });
  return { ok: true, release: { schemaVersion: 1, organization: holder.organization, linear, warnings } };
}

/** Whether `actor` had its share of releases this minute: shared by every server instance. */
const limited = async (deps: BrokerDeps, actor: Actor, now: Date) =>
  (await releasesSince(deps.client, actor, new Date(now.getTime() - 60_000))) >= RELEASES_PER_MINUTE;

/** The body of `POST /api/cli/secrets/release`: one project's secrets for workers. */
export interface SecretsRelease {
  schemaVersion: 1;
  project: string;
  secrets: { name: string; value: string; scope: SecretScope }[];
  /** Names asked for that are not set. */
  missing: string[];
  /** Why a secret that is set could not be handed out. Never a value. */
  warnings: string[];
}

export type SecretsAnswer = { ok: true; release: SecretsRelease } | { ok: false; limited: true };

/**
 * Releases one project's secrets for workers (its own over the
 * organization's), `names` or every one, and records the release with the
 * project and the names, never a value. The caller checked the holder may
 * have them. Nothing is kept: a deleted or changed secret shows on the next call.
 */
export async function releaseWorkerSecrets(
  deps: BrokerDeps,
  holder: Holder & { project: string },
  names: string[] | null,
): Promise<SecretsAnswer> {
  const now = deps.now?.() ?? new Date();
  if (await limited(deps, holder.actor, now)) return { ok: false, limited: true };
  const { values, scopes, problems } = await readWorkerSecrets(deps.client, deps.vault, {
    organization: holder.organization.id,
    project: holder.project,
    names,
  });
  const secrets = Object.keys(values)
    .sort()
    .map((name) => ({ name, value: values[name] ?? "", scope: scopes[name] ?? ("project" as const) }));
  const missing = (names ?? []).filter((n) => !(n in values));
  await recordEvent(deps.client, holder.organization.id, {
    at: now.toISOString(),
    action: "release",
    project: holder.project,
    keys: secrets.map((s) => s.name),
    actor: holder.actor,
    detail: [
      ...(holder.ticket ? [`for ${holder.ticket}`] : []),
      secrets.length ? `secrets for workers of ${holder.project}` : `no secret for workers of ${holder.project}`,
      ...(missing.length ? [`not set: ${missing.join(", ")}`] : []),
      ...problems.map((w) => `! ${w}`),
    ].join("; "),
  });
  return { ok: true, release: { schemaVersion: 1, project: holder.project, secrets, missing, warnings: problems } };
}

// ------------------------------------------------------------ to the dashboard

/** The dashboard's own reads of one organization's fleet: Linear and GitHub. */
export interface OrganizationKeys {
  linearApiKey: string | null;
  githubToken: string | null;
  warnings: string[];
}

const LOGGED = new Set<string>();

export async function organizationKeys(
  deps: Pick<BrokerDeps, "client" | "vault">,
  organization: string,
): Promise<OrganizationKeys> {
  const { values, problems } = await readSecrets(deps.client, deps.vault, { organization, user: null });
  // Once per problem and process: the Fleet view polls every few seconds.
  for (const w of problems) {
    const key = `${organization}\n${w}`;
    if (LOGGED.has(key)) continue;
    LOGGED.add(key);
    console.error(`armada dashboard: organization ${organization}: ${w}`);
  }
  return {
    linearApiKey: values["linear-api-key"] ?? null,
    githubToken: values["github-token"] ?? null,
    warnings: problems,
  };
}

/**
 * The Linear key one project keeps for itself, for the dashboard's reads of
 * that project; null when it keeps none (the organization's then serves).
 */
export async function projectLinearKey(
  deps: Pick<BrokerDeps, "client" | "vault">,
  organization: string,
  project: string,
): Promise<string | null> {
  const { values, fromProject, problems } = await readSecrets(deps.client, deps.vault, {
    organization,
    user: null,
    project,
  });
  for (const w of problems) {
    const key = `${organization}\n${w}`;
    if (LOGGED.has(key)) continue;
    LOGGED.add(key);
    console.error(`armada dashboard: organization ${organization}: ${w}`);
  }
  return fromProject.includes("linear-api-key") ? (values["linear-api-key"] ?? null) : null;
}

/** The keys one fleet is read with, and whether ARMADA_REPOSITORIES may stand in for its registry. */
export interface FleetKeys {
  linearApiKey: string | null;
  githubToken: string | null;
  envRepositories: boolean;
}

/**
 * What an organization's fleet is read with: its own keys, then, for the
 * deployment's first organization only, the deployment's environment. Any
 * other organization gets none of the environment's keys, nor
 * ARMADA_REPOSITORIES: once terminals register projects through the app, an
 * organization could name another's repository in its registry and read it
 * with the deployment's keys. Under the shared-password gate (no scope) the
 * environment serves every project, as before.
 */
export function fleetKeysOf(
  own: OrganizationKeys | null,
  env: Omit<FleetKeys, "envRepositories">,
  scope: Scope | null,
) {
  const inherit = !scope || scope.home === scope.organization;
  return {
    linearApiKey: own?.linearApiKey ?? (inherit ? env.linearApiKey : null),
    githubToken: own?.githubToken ?? (inherit ? env.githubToken : null),
    envRepositories: inherit,
  } satisfies FleetKeys;
}
