// Server wiring: the keys (never sent to the browser), the sources behind the
// Fleet view and the cache kept between polls. The fleet's live data is in the
// app's database (THE-849). With accounts and a vault (THE-840), each
// organization's fleet is read with that organization's Linear and GitHub keys
// from the vault, and only the first organization falls back to the
// environment's; otherwise every key comes from the environment, as before.
import "server-only";
import {
  CONFIG_FILE,
  type FleetOverview,
  fetchDefaultBranchFile,
  parseConfig,
  readProjectConfig,
  readStatusSources,
  resolveCredentials,
} from "@armada/core/read";
import { after } from "next/server";
import { type Access, requireFleetAccess, scopeOf } from "./access";
import { accounts } from "./accounts-server";
import { appDatabase } from "./app-db";
import { type FleetKeys, fleetKeysOf, type OrganizationKeys, organizationKeys } from "./broker";
import { demoSources } from "./demo/sources";
import {
  type FleetCache,
  type LoadOptions,
  loadOverview,
  newCache,
  type ProjectRef,
  type Scope,
  type Sources,
} from "./fleet-data";
import { liveStore } from "./fleet-store";
import { isLanguage, type Language } from "./i18n";
import { vaultModeOf } from "./vault";

/** Comma- or space-separated owner/name list, shown when the registry cannot be read. */
function repositoriesFromEnv(): ProjectRef[] {
  return (process.env.ARMADA_REPOSITORIES ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((repository) => ({ repository }));
}

function envKeys(): Omit<FleetKeys, "envRepositories"> {
  const keys = resolveCredentials({ env: process.env });
  return { linearApiKey: keys.linearApiKey, githubToken: keys.githubToken };
}

function realSources(keys: FleetKeys): Sources {
  const { linearApiKey } = keys;
  return {
    live: async () => {
      const db = await appDatabase();
      return db ? liveStore(db) : null;
    },
    fallbackProjects: keys.envRepositories ? repositoriesFromEnv : () => [],
    readConfig: async (p) => {
      if (p.slug && p.name && p.programRoot)
        return readProjectConfig(
          { slug: p.slug, name: p.name, repository: p.repository, programRoot: p.programRoot },
          { githubToken: keys.githubToken },
        );
      // Only a repository is known: its armada.toml is the only description of the project.
      if (!keys.githubToken)
        throw new Error(`GITHUB_TOKEN is not set, so ${p.repository}:${CONFIG_FILE} cannot be read`);
      const text = await fetchDefaultBranchFile({
        token: keys.githubToken,
        repository: p.repository,
        path: CONFIG_FILE,
      });
      if (text === null) throw new Error(`${CONFIG_FILE} is not on the default branch of ${p.repository}`);
      return { config: parseConfig(text, `${p.repository}:${CONFIG_FILE}`), warning: null };
    },
    readSnapshot: async (config) => {
      if (!linearApiKey) throw new Error("LINEAR_API_KEY is not set on the dashboard");
      return readStatusSources(config, { linearApiKey, githubToken: keys.githubToken });
    },
  };
}

const seconds = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// One cache per fleet read with its own keys, per server process, kept across
// requests (and across hot reloads in development): "env", or one per
// organization once the vault is on.
const globalCache = globalThis as unknown as { __armadaFleets?: Map<string, FleetCache> };

/** The keys of the viewer's fleet: with a vault, the organization's, then the environment's (`fleetKeysOf`). */
async function keysOf(access: Access): Promise<{ id: string; keys: FleetKeys; scope: Scope | null }> {
  const env = envKeys();
  const scope = scopeOf(access);
  if (access.kind !== "account") return { id: "env", keys: fleetKeysOf(null, env, scope), scope };
  const vault = vaultModeOf(process.env);
  const a = vault.kind === "on" ? await accounts() : null;
  const organization = access.viewer.organization.id;
  const own: OrganizationKeys | null =
    a && vault.kind === "on" ? await organizationKeys({ client: a.client, vault: vault.key }, organization) : null;
  return { id: `org:${organization}`, keys: fleetKeysOf(own, env, scope), scope };
}

/** How the viewer's reads and requests reach the sources, and whose projects they see. Checks access first. */
export async function fleetOf(access?: Access): Promise<{ opts: LoadOptions; scope: Scope | null }> {
  const { id, keys, scope } = await keysOf(access ?? (await requireFleetAccess()));
  globalCache.__armadaFleets ??= new Map();
  let cache = globalCache.__armadaFleets.get(id);
  if (!cache) {
    cache = newCache();
    globalCache.__armadaFleets.set(id, cache);
  }
  const demo = process.env.ARMADA_DASHBOARD_DEMO;
  return {
    opts: {
      sources: demo ? demoSources(demo, realSources(keys)) : realSources(keys),
      cache,
      now: () => new Date(),
      snapshotMs: seconds(process.env.ARMADA_DASHBOARD_SNAPSHOT_SECONDS, 60) * 1000,
      background: (work) => after(() => work),
    },
    scope,
  };
}

/** The Fleet overview the viewer may read: their organization's projects, or every project under the password gate. */
export async function getOverview(): Promise<FleetOverview> {
  const { opts, scope } = await fleetOf();
  return loadOverview(opts, scope);
}

/**
 * Under the shared-password gate, who signs the requests: the name the viewer
 * gave (cookie), else ARMADA_DASHBOARD_AUTHOR. The password is shared and
 * carries no identity, so the name is declared, not proven. With accounts, the
 * signed-in person signs instead (`signatureOf`).
 */
export function authorOf(cookie: string | undefined): string {
  return (cookie ?? process.env.ARMADA_DASHBOARD_AUTHOR ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The dashboard's language: the viewer's choice (cookie), then ARMADA_DASHBOARD_LANGUAGE, then English. */
export function languageOf(cookie: string | undefined): Language {
  const pick = (v: string | undefined) => {
    const tag = v?.trim().toLowerCase().slice(0, 2);
    return isLanguage(tag) ? tag : null;
  };
  return pick(cookie) ?? pick(process.env.ARMADA_DASHBOARD_LANGUAGE) ?? "en";
}
