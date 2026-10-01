// The credential broker (THE-840): what a signed-in terminal receives from
// the vault, and what the dashboard's own reads use. The Linear key is the
// person's own when they set one, else the organization's. Turso access is a
// database token made for the caller through the Turso Platform API, which
// expires on its own after a few hours; without a Platform token the stored
// database token is handed out instead, and the audit list says so. A
// terminal says which token it already holds (its revision and expiry, never
// the token): it keeps it until it nears expiry or the Turso keys change.
// Every call is recorded, never with a value. Everything is injected.
//
// Turso is for the CLI only, until it reaches fleet data through the app
// (THE-850): the dashboard reads the fleet from its own database (THE-849).
import type { Database } from "./db";
import type { Scope } from "./fleet-data";
import {
  type Actor,
  readSecrets,
  recordEvent,
  releasesSince,
  type SecretName,
  TURSO_SECRETS,
  type VaultKey,
} from "./vault";

/** How long a Turso token made for a caller lasts. */
export const TURSO_TOKEN_HOURS = 4;
/** A held token with less than this left is replaced. */
export const RENEW_BEFORE_MS = 60 * 60 * 1000;
/** Calls per caller per minute. */
export const RELEASES_PER_MINUTE = 30;

export const TURSO_API = "https://api.turso.tech";
const TIMEOUT_MS = 10_000;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface BrokerDeps {
  client: Database;
  vault: VaultKey;
  fetch?: Fetch;
  now?: () => Date;
}

export interface Holder {
  actor: Actor;
  organization: { id: string; name: string; slug: string };
  /** The person, whose own keys win; null for an organization API key. For a worker, who launched it. */
  user: string | null;
  /** The ticket the keys are for, as the terminal names it (a worker's is its own); the audit list shows it. */
  ticket?: string | null;
}

/** What the terminal already holds: never the token, only which one. */
export interface HeldTurso {
  revision: string;
  expiresAt: string;
}

export type TursoRelease =
  | { kind: "minted"; url: string; token: string; expiresAt: string; revision: string }
  | { kind: "kept"; expiresAt: string; revision: string }
  | { kind: "stored"; url: string; token: string; expiresAt: null; revision: string };

/** The body of `POST /api/cli/credentials`. */
export interface Release {
  schemaVersion: 1;
  organization: { id: string; name: string; slug: string };
  linear: { apiKey: string; scope: "own" | "organization" } | null;
  turso: TursoRelease | null;
  /** Why a key the organization set could not be handed out; the CLI prints them. Never a value. */
  warnings: string[];
}

// ------------------------------------------------------------ Turso Platform API

interface PlatformAccess {
  token: string;
  organization: string;
  database: string;
}

/** A Turso Platform API refusal. Quotes Turso's message, never a token. */
class TursoPlatformError extends Error {}

async function platformCall(fetch: Fetch, p: PlatformAccess, method: string, path: string) {
  const url = `${TURSO_API}/v1/organizations/${encodeURIComponent(p.organization)}/databases/${encodeURIComponent(p.database)}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${p.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new TursoPlatformError(
      `the Turso Platform API is unreachable (${err instanceof Error ? err.name : "network error"})`,
    );
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const said = typeof body?.error === "string" ? `: ${body.error.split(p.token).join("***").slice(0, 200)}` : "";
    throw new TursoPlatformError(`the Turso Platform API answered HTTP ${res.status}${said}`);
  }
  return body ?? {};
}

/** A database token that expires after `hours`, with full access (workers record events). */
async function mintDatabaseToken(fetch: Fetch, p: PlatformAccess, hours: number): Promise<string> {
  const body = await platformCall(fetch, p, "POST", `/auth/tokens?expiration=${hours}h&authorization=full-access`);
  if (typeof body.jwt !== "string" || !body.jwt) throw new TursoPlatformError("the Turso Platform API gave no token");
  return body.jwt;
}

/** The database's libSQL URL, from its hostname. */
async function databaseUrl(fetch: Fetch, p: PlatformAccess): Promise<string> {
  const body = await platformCall(fetch, p, "GET", "");
  const host = (body.database as { Hostname?: unknown } | undefined)?.Hostname;
  if (typeof host !== "string" || !host) throw new TursoPlatformError("the Turso Platform API gave no hostname");
  return `libsql://${host}`;
}

type TursoAccess =
  | { kind: "minted"; url: string; token: string; expiresAt: Date }
  | { kind: "stored"; url: string; token: string }
  | null;

/**
 * The Turso access the organization's keys give: a fresh token through the
 * Platform API, else the stored database token. `warnings` say what was set
 * but could not be used.
 */
async function tursoAccess(
  values: Partial<Record<SecretName, string>>,
  fetch: Fetch,
  now: Date,
): Promise<{ access: TursoAccess; warnings: string[] }> {
  const warnings: string[] = [];
  const url = values["turso-url"] ?? null;
  const stored = values["turso-database-token"] ?? null;
  const platform =
    values["turso-platform-token"] && values["turso-organization"] && values["turso-database"]
      ? {
          token: values["turso-platform-token"],
          organization: values["turso-organization"],
          database: values["turso-database"],
        }
      : null;
  if (platform) {
    try {
      const [token, found] = await Promise.all([
        mintDatabaseToken(fetch, platform, TURSO_TOKEN_HOURS),
        url ? Promise.resolve(url) : databaseUrl(fetch, platform),
      ]);
      return {
        access: {
          kind: "minted",
          url: found,
          token,
          expiresAt: new Date(now.getTime() + TURSO_TOKEN_HOURS * 3_600_000),
        },
        warnings,
      };
    } catch (err) {
      warnings.push(
        `no Turso token could be made: ${err instanceof Error ? err.message : String(err)}; check the Turso keys on the Keys page`,
      );
    }
  } else if (values["turso-platform-token"] || values["turso-organization"] || values["turso-database"])
    warnings.push(
      "the Turso Platform API needs its token, the Turso organization and the database name: one is missing on the Keys page",
    );
  if (stored && url) return { access: { kind: "stored", url, token: stored }, warnings };
  if (stored && !url) warnings.push("a Turso database token is set without the database URL on the Keys page");
  return { access: null, warnings };
}

const hasTurso = (values: Partial<Record<SecretName, string>>) => TURSO_SECRETS.some((n) => values[n]);

// ------------------------------------------------------------ to a terminal

export type BrokerAnswer = { ok: true; release: Release } | { ok: false; limited: true };

const hhmm = (d: Date) => `${d.toISOString().slice(0, 16)}Z`;

/** Releases the caller's keys, records the release, and refuses beyond the rate limit. */
export async function releaseCredentials(
  deps: BrokerDeps,
  holder: Holder,
  held: HeldTurso | null,
): Promise<BrokerAnswer> {
  const now = deps.now?.() ?? new Date();
  const fetch = deps.fetch ?? globalThis.fetch;
  if ((await releasesSince(deps.client, holder.actor, new Date(now.getTime() - 60_000))) >= RELEASES_PER_MINUTE)
    return { ok: false, limited: true };

  const { values, own, revision, problems } = await readSecrets(deps.client, deps.vault, {
    organization: holder.organization.id,
    user: holder.user,
  });
  const warnings = [...problems];
  const keys: string[] = [];
  const details: string[] = [];

  const linearKey = values["linear-api-key"] ?? null;
  const linear = linearKey
    ? { apiKey: linearKey, scope: own.includes("linear-api-key") ? ("own" as const) : ("organization" as const) }
    : null;
  if (linear) {
    keys.push("linear-api-key");
    details.push(linear.scope === "own" ? "Linear key (their own)" : "Linear key (the organization's)");
  }

  let turso: TursoRelease | null = null;
  const heldUntil = held ? Date.parse(held.expiresAt) : Number.NaN;
  const keep =
    held !== null &&
    held.revision === revision &&
    values["turso-platform-token"] !== undefined &&
    heldUntil - now.getTime() > RENEW_BEFORE_MS &&
    // A claimed expiry beyond what Armada ever hands out is not one of its tokens.
    heldUntil <= now.getTime() + TURSO_TOKEN_HOURS * 3_600_000;
  if (keep && held) {
    turso = { kind: "kept", expiresAt: held.expiresAt, revision };
    details.push(`Turso token kept (expires ${hhmm(new Date(heldUntil))})`);
  } else if (hasTurso(values)) {
    const { access, warnings: more } = await tursoAccess(values, fetch, now);
    warnings.push(...more);
    if (access?.kind === "minted") {
      turso = {
        kind: "minted",
        url: access.url,
        token: access.token,
        expiresAt: access.expiresAt.toISOString(),
        revision,
      };
      keys.push("turso");
      details.push(`Turso token made, expires ${hhmm(access.expiresAt)}`);
    } else if (access?.kind === "stored") {
      turso = { kind: "stored", url: access.url, token: access.token, expiresAt: null, revision };
      keys.push("turso-database-token");
      details.push("stored Turso database token handed out (no Turso Platform API token, so it does not expire)");
    }
  }
  if (!keys.length && !turso) details.push("nothing to release: no key is set for this organization");

  await recordEvent(deps.client, holder.organization.id, {
    at: now.toISOString(),
    action: "release",
    keys,
    actor: holder.actor,
    detail: [...(holder.ticket ? [`for ${holder.ticket}`] : []), ...details, ...warnings.map((w) => `! ${w}`)].join(
      "; ",
    ),
  });
  return { ok: true, release: { schemaVersion: 1, organization: holder.organization, linear, turso, warnings } };
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
