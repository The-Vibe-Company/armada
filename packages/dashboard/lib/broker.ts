// The credential broker (THE-840): what a signed-in terminal receives from
// the vault, and what the dashboard's own reads use. The Linear key is the
// person's own when they set one, else the organization's. Turso access is a
// database token made for the caller through the Turso Platform API, which
// expires on its own after a few hours; without a Platform token the stored
// database token is handed out instead, and the audit list says so. A
// terminal says which token it already holds (its revision and expiry, never
// the token): it keeps it until it nears expiry or the Turso keys change.
// Every call is recorded, never with a value. Everything is injected.
import type { Client } from "@libsql/client";
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
  client: Client;
  vault: VaultKey;
  fetch?: Fetch;
  now?: () => Date;
}

export interface Holder {
  actor: Actor;
  organization: { id: string; name: string; slug: string };
  /** The person, whose own keys win; null for an organization API key. */
  user: string | null;
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
    detail: [...details, ...warnings.map((w) => `! ${w}`)].join("; "),
  });
  return { ok: true, release: { schemaVersion: 1, organization: holder.organization, linear, turso, warnings } };
}

// ------------------------------------------------------------ to the dashboard

/** The dashboard's own reads of one organization's fleet. */
export interface OrganizationKeys {
  linearApiKey: string | null;
  githubToken: string | null;
  turso: { url: string; token: string; expiresAt: Date | null } | null;
  warnings: string[];
}

/** Turso access made for the dashboard, kept per organization in server memory until it nears expiry. */
export type DashboardTursoCache = Map<string, { revision: string; access: TursoAccess; warnings: string[] }>;

export async function organizationKeys(
  deps: BrokerDeps & { cache: DashboardTursoCache },
  organization: string,
): Promise<OrganizationKeys> {
  const now = deps.now?.() ?? new Date();
  const { values, revision, problems } = await readSecrets(deps.client, deps.vault, { organization, user: null });
  let held = deps.cache.get(organization);
  const fresh =
    held?.revision === revision &&
    (held.access?.kind !== "minted" || held.access.expiresAt.getTime() - now.getTime() > RENEW_BEFORE_MS);
  if (!held || !fresh) {
    const { access, warnings } = hasTurso(values)
      ? await tursoAccess(values, deps.fetch ?? globalThis.fetch, now)
      : { access: null, warnings: [] };
    held = { revision, access, warnings };
    deps.cache.set(organization, held);
    for (const w of [...problems, ...warnings]) console.error(`armada dashboard: organization ${organization}: ${w}`);
    if (access)
      await recordEvent(deps.client, organization, {
        at: now.toISOString(),
        action: "release",
        keys: [access.kind === "minted" ? "turso" : "turso-database-token"],
        actor: { kind: "dashboard", id: "", label: "the dashboard" },
        detail:
          access.kind === "minted"
            ? `Turso token made for the dashboard's reads, expires ${hhmm(access.expiresAt)}`
            : "stored Turso database token used by the dashboard's reads (no Turso Platform API token)",
      });
  }
  const access = held.access;
  return {
    linearApiKey: values["linear-api-key"] ?? null,
    githubToken: values["github-token"] ?? null,
    turso: access
      ? { url: access.url, token: access.token, expiresAt: access.kind === "minted" ? access.expiresAt : null }
      : null,
    warnings: [...problems, ...held.warnings],
  };
}
