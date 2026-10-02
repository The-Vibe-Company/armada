// Server wiring: the keys (never sent to the browser), the sources behind the
// Fleet view and the cache kept between polls. The fleet's live data is in the
// app's database (THE-849). With accounts and a vault (THE-840), each
// organization's fleet is read with that organization's Linear and GitHub keys
// from the vault, and only the first organization falls back to the
// environment's; otherwise every key comes from the environment, as before.
// A project that keeps its own Linear key (THE-859) is read with it.
// GitHub is read through the Armada GitHub App when it is configured
// (THE-851): each repository with its installation's token
// (`github-app.ts`); a stored GitHub token is only the fallback of a
// deployment without the app.
import { createHash } from "node:crypto";
import "server-only";
import {
  awayWindow,
  CONFIG_FILE,
  type FleetOverview,
  fetchDefaultBranchFile,
  insightsSummary,
  parseConfig,
  readProjectConfig,
  readStatusSources,
  refreshStatusSources,
  resolveCredentials,
  type SinceSummary,
  showSummary,
} from "@armada/core/read";
import { after } from "next/server";
import { cache } from "react";
import { type Access, requireFleetAccess, scopeOf } from "./access";
import { accounts, homeOrganization } from "./accounts-server";
import { appDatabase } from "./app-db";
import { type FleetKeys, fleetKeysOf, type OrganizationKeys, organizationKeys, projectLinearKey } from "./broker";
import { demoSources } from "./demo/sources";
import {
  type FleetCache,
  type LoadOptions,
  loadAgentActivity,
  loadCatchup,
  loadInsights,
  loadOverview,
  MARK_GAP_MS,
  newCache,
  type ProjectRef,
  refreshProject,
  type Scope,
  type Sources,
  type TaggedActivity,
} from "./fleet-data";
import { listProjects, liveStore } from "./fleet-store";
import {
  createGithubApp,
  GITHUB_APP_VARIABLES,
  type GithubApp,
  githubAppModeOf,
  type InstallationAccess,
  linkedInstallations,
  repositoryToken,
} from "./github-app";
import { isLanguage, type Language } from "./i18n";
import type { InsightsLineReading } from "./insights-view";
import { jsonTag, withoutTimeline } from "./live-http";
import { dbSnapshots } from "./snapshots";
import { vaultModeOf } from "./vault";
import { viewerKey } from "./viewer";
import { readVisit } from "./visits";
import { isTicketId } from "./workers";

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

// One client per server process, so installation tokens are shared by every
// fleet; built again if the app's variables change.
const appHolder = globalThis as unknown as { __armadaGithubApp?: { key: string; app: GithubApp | null } };

/** The deployment's GitHub App; null when it is not configured. An invalid one is logged once and left off. */
export function githubApp(): GithubApp | null {
  const V = GITHUB_APP_VARIABLES;
  const key = createHash("sha256")
    .update(`${process.env[V.id] ?? ""}\n${process.env[V.privateKey] ?? ""}`)
    .digest("hex");
  if (appHolder.__armadaGithubApp?.key !== key) {
    const mode = githubAppModeOf(process.env);
    if (mode.kind === "invalid") console.error(`armada dashboard: GitHub App off: ${mode.reason}`);
    appHolder.__armadaGithubApp = {
      key,
      app: mode.kind === "on" ? createGithubApp({ settings: mode.settings }) : null,
    };
  }
  return appHolder.__armadaGithubApp.app;
}

/** What one fleet reads Linear and GitHub with: resolved only when a refresh runs, never on a poll. */
interface ReadKeys {
  keys: FleetKeys;
  installations: InstallationAccess;
  /** The Linear key a project keeps for itself; null when it keeps none. */
  projectLinear: (project: string) => Promise<string | null>;
}

function realSources(scope: Scope | null, resolve: () => Promise<ReadKeys>): Sources {
  let resolving: Promise<ReadKeys> | null = null;
  const read = () => {
    resolving ??= resolve();
    return resolving;
  };
  const app = githubApp();
  const tokenFor = async (repository: string) => {
    const { keys, installations } = await read();
    return repositoryToken(app, installations, keys.githubToken, repository);
  };
  const linearKey = async (project: string) => {
    const { keys, projectLinear } = await read();
    const linearApiKey = (await projectLinear(project)) ?? keys.linearApiKey;
    if (!linearApiKey) throw new Error("LINEAR_API_KEY is not set on the dashboard");
    return linearApiKey;
  };
  // Only the first organization, and the password gate, may stand ARMADA_REPOSITORIES in for the registry.
  const envRepositories = !scope || scope.home === scope.organization;
  return {
    live: async () => {
      const db = await appDatabase();
      return db ? liveStore(db) : null;
    },
    database: appDatabase,
    fallbackProjects: envRepositories ? repositoriesFromEnv : () => [],
    readConfig: async (p) => {
      const github = await tokenFor(p.repository);
      if (p.slug && p.name && p.programRoot)
        return readProjectConfig(
          { slug: p.slug, name: p.name, repository: p.repository, programRoot: p.programRoot },
          { githubToken: github.token },
        );
      // Only a repository is known: its armada.toml is the only description of the project.
      if (!github.token) throw new Error(`${p.repository}:${CONFIG_FILE} cannot be read: ${github.reason}`);
      const text = await fetchDefaultBranchFile({
        token: github.token,
        repository: p.repository,
        path: CONFIG_FILE,
      });
      if (text === null) throw new Error(`${CONFIG_FILE} is not on the default branch of ${p.repository}`);
      return { config: parseConfig(text, `${p.repository}:${CONFIG_FILE}`), warning: null };
    },
    readSnapshot: async (config) => {
      const linearApiKey = await linearKey(config.project.slug);
      const github = await tokenFor(config.github.repository);
      const sources = await readStatusSources(config, { linearApiKey, githubToken: github.token });
      return github.token === null ? { ...sources, forgeError: github.reason } : sources;
    },
    readChanges: async (config, previous, ask) => {
      const linearApiKey = await linearKey(config.project.slug);
      const github = ask.forge ? await tokenFor(config.github.repository) : null;
      const sources = await refreshStatusSources(config, previous, ask, {
        linearApiKey,
        githubToken: github?.token ?? null,
      });
      return github?.token === null ? { ...sources, forgeError: github.reason } : sources;
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

/**
 * The keys a fleet reads with: with a vault, the organization's, then the
 * environment's (`fleetKeysOf`); and the GitHub App's installations it reads
 * through: any for the first organization and under the password gate, else
 * those linked to the organization.
 */
async function readKeysOf(scope: Scope | null): Promise<ReadKeys> {
  const env = envKeys();
  const none = async () => null;
  if (!scope) return { keys: fleetKeysOf(null, env, scope), installations: { kind: "any" }, projectLinear: none };
  const vault = vaultModeOf(process.env);
  const a = await accounts();
  const deps = a && vault.kind === "on" ? { client: a.client, vault: vault.key } : null;
  const own: OrganizationKeys | null = deps ? await organizationKeys(deps, scope.organization) : null;
  // Read once per project and refresh, never kept beyond it: a changed key serves the next one.
  const perProject = new Map<string, Promise<string | null>>();
  const projectLinear = (project: string) => {
    if (!deps) return none();
    let found = perProject.get(project);
    if (!found) {
      found = projectLinearKey(deps, scope.organization, project);
      perProject.set(project, found);
    }
    return found;
  };
  const installations: InstallationAccess =
    scope.home === scope.organization
      ? { kind: "any" }
      : {
          kind: "linked",
          installations: new Set(
            a && githubApp() ? (await linkedInstallations(a.client, scope.organization)).map((i) => i.id) : [],
          ),
        };
  return { keys: fleetKeysOf(own, env, scope), installations, projectLinear };
}

/** The fleet one scope reads: its process cache (shared by its viewers) and its sources. */
function fleetFor(scope: Scope | null): LoadOptions {
  const id = scope ? `org:${scope.organization}` : "env";
  globalCache.__armadaFleets ??= new Map();
  let cache = globalCache.__armadaFleets.get(id);
  if (!cache) {
    cache = newCache();
    globalCache.__armadaFleets.set(id, cache);
  }
  const real = realSources(scope, () => readKeysOf(scope));
  const demo = process.env.ARMADA_DASHBOARD_DEMO;
  return {
    sources: demo ? demoSources(demo, real) : real,
    cache,
    now: () => new Date(),
    // A reading both webhooks keep fresh is refreshed on view every 10 minutes instead (`fleet-data.ts`).
    snapshotMs: seconds(process.env.ARMADA_DASHBOARD_SNAPSHOT_SECONDS, 60) * 1000,
    background: (work) => after(() => work),
  };
}

/** How the viewer's reads and requests reach the sources, and whose projects they see. Checks access first. */
export async function fleetOf(access?: Access): Promise<{ opts: LoadOptions; scope: Scope | null }> {
  const scope = scopeOf(access ?? (await requireFleetAccess()));
  return { opts: fleetFor(scope), scope };
}

/**
 * Refreshes the readings a webhook marked, each with its own organization's
 * keys, as a viewer of that organization would. Runs after the webhook's
 * answer; never throws.
 */
export async function refreshMarked(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const db = await appDatabase();
    if (!db) return;
    const registry = await listProjects(db);
    const signedIn = (await accounts()) !== null;
    const home = signedIn ? await homeOrganization() : null;
    await Promise.all(
      keys.map(async (key) => {
        // A registered project by its slug; one known only by its repository (ARMADA_REPOSITORIES) by owner/name.
        const p: ProjectRef | undefined =
          registry.find((r) => r.slug === key) ?? (key.includes("/") ? { repository: key } : undefined);
        if (!p) return;
        const organization = p.organization ?? home;
        // A project no organization holds yet is read by nobody's keys.
        if (signedIn && !organization) return;
        const opts = fleetFor(signedIn && organization ? { organization, home } : null);
        // A burst of deliveries makes one read: the marks of the others wait for it, or for the next view.
        // After a failure, the snapshot period passes first, as for a view.
        await refreshProject(p, dbSnapshots(db, opts.cache.snapshots), opts, {
          gapMs: MARK_GAP_MS,
          retryMs: opts.snapshotMs,
        });
      }),
    );
  } catch (err) {
    console.error(`armada dashboard: refresh after a webhook failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The Fleet overview the viewer may read: their organization's projects, or
 * every project under the password gate. `timeline` keeps the live
 * timeline's history, which pages leave out (`withoutTimeline`).
 */
export async function getOverview(opts: { timeline?: boolean } = {}): Promise<FleetOverview> {
  const overview = await overviewOfRequest();
  return opts.timeline ? overview : withoutTimeline(overview);
}

// Read once per render: the shell and an agent's page both need it.
const overviewOfRequest = cache(async () => {
  const fleet = await fleetOf();
  return loadOverview(fleet.opts, fleet.scope);
});

/** The overview's insights line for its first render, so it neither arrives late nor moves the page (THE-892). */
export async function initialInsightsLine(): Promise<InsightsLineReading | null> {
  const { opts, scope } = await fleetOf();
  const reading = await loadInsights(opts, scope, { range: "7d", project: null }).catch(() => null);
  if (!reading) return null;
  const body = { range: "7d" as const, project: null, live: reading.live, summary: insightsSummary(reading.insights) };
  return { body, tag: jsonTag(body) };
}

/**
 * "Since you were away" for the overview's first render (THE-899, after
 * THE-894): read with the page, before the shell's beacon records this
 * visit, so the welcome sentence and its strip are there at once and move
 * nothing (THE-892's CLS 0). Null when there is none to show; never throws.
 */
export async function initialSince(): Promise<SinceSummary | null> {
  try {
    const access = await requireFleetAccess();
    const db = await appDatabase();
    const key = db && (await viewerKey(access, false));
    if (!db || !key) return null;
    const now = new Date();
    const visit = await readVisit(db, key);
    const window = showSummary(visit, now) ? awayWindow(visit, now) : null;
    if (!window) return null;
    const { opts, scope } = await fleetOf(access);
    return await loadCatchup(opts, scope, { since: new Date(window.since), until: new Date(window.until) });
  } catch {
    return null;
  }
}

/** The ticket's activity for its page's first render; null when the viewer cannot see it or it cannot be read. */
export async function initialActivity(ticket: string): Promise<TaggedActivity | null> {
  const id = ticket.toUpperCase();
  if (!isTicketId(id)) return null;
  const [overview, { opts, scope }] = await Promise.all([getOverview(), fleetOf()]);
  const row = overview.rows.find((r) => r.id.toUpperCase() === id);
  if (!row) return null;
  const activity = await loadAgentActivity(opts, scope, row.project, row.id).catch(() => null);
  return activity && { activity, tag: jsonTag(activity) };
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
