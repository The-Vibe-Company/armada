// Server wiring: keys from the environment (never sent to the browser), the
// sources behind the Fleet view and the cache kept between polls.
import "server-only";
import {
  CONFIG_FILE,
  type FleetOverview,
  fetchDefaultBranchFile,
  openTurso,
  parseConfig,
  readProjectConfig,
  readStatusSources,
  resolveCredentials,
} from "@armada/core/read";
import { after } from "next/server";
import { requireSession } from "./auth-server";
import { demoSources } from "./demo/sources";
import { type FleetCache, type LoadOptions, loadOverview, newCache, type ProjectRef, type Sources } from "./fleet-data";
import { isLanguage, type Language } from "./i18n";

/** Comma- or space-separated owner/name list, shown when the registry cannot be read. */
function repositoriesFromEnv(): ProjectRef[] {
  return (process.env.ARMADA_REPOSITORIES ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((repository) => ({ repository }));
}

function realSources(): Sources {
  const keys = resolveCredentials({ env: process.env });
  const linearApiKey = keys.linearApiKey;
  return {
    openLive: async () => (keys.tursoUrl ? openTurso({ url: keys.tursoUrl, token: keys.tursoToken }) : null),
    fallbackProjects: repositoriesFromEnv,
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

// One cache per server process, kept across requests (and across hot reloads in development).
const globalCache = globalThis as unknown as { __armadaFleet?: FleetCache };

/** How every read and request of this server process reaches the sources. Callers check the session first. */
export function loadOptions(): LoadOptions {
  globalCache.__armadaFleet ??= newCache();
  const demo = process.env.ARMADA_DASHBOARD_DEMO;
  return {
    sources: demo ? demoSources(demo, realSources()) : realSources(),
    cache: globalCache.__armadaFleet,
    now: () => new Date(),
    snapshotMs: seconds(process.env.ARMADA_DASHBOARD_SNAPSHOT_SECONDS, 60) * 1000,
    background: (work) => after(() => work),
  };
}

export async function getOverview(): Promise<FleetOverview> {
  await requireSession();
  return loadOverview(loadOptions());
}

/**
 * Who signs the requests: the name the viewer gave (cookie), else
 * ARMADA_DASHBOARD_AUTHOR. The dashboard password is shared and carries no
 * identity, so the name is declared, not proven.
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
