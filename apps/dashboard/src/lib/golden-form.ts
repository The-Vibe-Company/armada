import {
  type Golden,
  type GoldenConfig,
  GoldenError,
  isSandboxProvider,
  normalizeGitHubGoldenConfig,
  parseGoldenConfig,
  parseGoldenName,
  SANDBOX_PROVIDERS,
  type SandboxProviderId,
} from "@armada/core";
import type { GoldenCapabilities } from "./control.ts";

/** One repository row of the golden form, as typed. */
export type RepoRow = { url: string; branch: string; dir: string };

/** The backends a golden can be built on, in the order the form offers them. */
export const GOLDEN_PROVIDERS = SANDBOX_PROVIDERS;
export const PROVIDER_LABELS: Record<SandboxProviderId, string> = { boat: "Boat", modal: "Modal" };

/** The fields of the golden form, as strings, before any check. */
export type GoldenFormFields = {
  mode: string;
  name: string;
  org: string;
  /** Create: the backend chosen in the form. Update: the stored golden's own provider, never the form's. */
  provider: string;
  visibility: string;
  repos: RepoRow[];
  init: string;
  setup: string;
};

/** What `golden/create` and `golden/update` of the control API take. Never a token. */
export type GoldenRequest =
  | {
      mode: "create";
      body: {
        name: string;
        org: string;
        private: boolean;
        provider: SandboxProviderId;
        config: { repos: { url: string; branch: string; dir?: string }[]; init: string[] };
        setup?: string;
      };
    }
  | {
      mode: "update";
      body: {
        name: string;
        org: string;
        /** Picks this golden among same-name goldens of another provider; the server never changes it. */
        provider: SandboxProviderId;
        config: { repos: { url: string; branch: string; dir?: string }[]; init: string[] };
        setup?: string;
      };
    };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The control API accepts at most this many repositories in one golden (core's `MAX_REPOS`). */
export const MAX_GOLDEN_REPOS = 16;

/**
 * Checks the form with the same rules the server applies (`parseGoldenConfig`, GitHub identities only) so an
 * obvious mistake is reported before a builder is started. The server checks everything again.
 */
export function goldenRequest(fields: GoldenFormFields): Parsed<GoldenRequest> {
  const mode = fields.mode === "update" ? "update" : fields.mode === "create" ? "create" : null;
  if (!mode || !fields.org.trim()) return { ok: false, error: "That request is not valid." };
  if (!isSandboxProvider(fields.provider)) return { ok: false, error: "Choose where the golden is built." };
  const provider = fields.provider;
  let name: string;
  try {
    name = parseGoldenName(fields.name);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  const rows = fields.repos
    .map((row) => ({ url: row.url.trim(), branch: row.branch.trim(), dir: row.dir.trim() }))
    .filter((row) => row.url || row.branch || row.dir);
  if (rows.length === 0) return { ok: false, error: "Add at least one repository." };
  if (rows.length > MAX_GOLDEN_REPOS)
    return { ok: false, error: `A golden holds at most ${MAX_GOLDEN_REPOS} repositories.` };
  const blank = rows.findIndex((row) => !row.url);
  if (blank !== -1) return { ok: false, error: `Repository ${blank + 1} needs a GitHub repository.` };
  const repos = rows.map((row) => ({
    url: githubUrl(row.url),
    branch: row.branch || "main",
    ...(row.dir ? { dir: row.dir } : {}),
  }));
  const init = lines(fields.init);
  const config = { repos, init };
  try {
    // Same validation as the server: GitHub repositories only, branch and directory syntax, no secret keys.
    normalizeGitHubGoldenConfig(parseGoldenConfig(config));
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  const setup = fields.setup.trim() ? fields.setup : undefined;
  if (mode === "update") {
    return {
      ok: true,
      value: { mode, body: { name, org: fields.org, provider, config, ...(setup ? { setup } : {}) } },
    };
  }
  if (fields.visibility !== "org" && fields.visibility !== "private")
    return { ok: false, error: "Choose who sees the golden." };
  return {
    ok: true,
    value: {
      mode,
      body: {
        name,
        org: fields.org,
        private: fields.visibility === "private",
        provider,
        config,
        ...(setup ? { setup } : {}),
      },
    },
  };
}

/** `owner/repo` becomes the https URL the config stores; any other form is passed on for the server to judge. */
function githubUrl(value: string): string {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? `https://github.com/${value}.git` : value;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function message(error: unknown): string {
  if (error instanceof GoldenError) return error.message;
  throw error;
}

/** `owner/repo` of a stored GitHub URL (https, ssh or scp form), or null for anything else. */
export function repoSlug(url: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

export type GoldenRepoView = { url: string; slug: string | null; branch: string; dir: string };

/** The repositories recorded in a golden row, read defensively: legacy rows may carry an empty or odd config. */
export function goldenRepos(config: Golden["config"]): GoldenRepoView[] {
  const repos = isRecord(config) && Array.isArray(config.repos) ? config.repos : [];
  return repos.flatMap((repo) => {
    if (!isRecord(repo) || typeof repo.url !== "string") return [];
    return [
      {
        url: repo.url,
        slug: repoSlug(repo.url),
        branch: typeof repo.branch === "string" ? repo.branch : "main",
        dir: typeof repo.dir === "string" ? repo.dir : "",
      },
    ];
  });
}

export function goldenInit(config: Golden["config"]): string[] {
  const init = isRecord(config) && Array.isArray(config.init) ? config.init : [];
  return init.filter((command): command is string => typeof command === "string");
}

/** The launch form's repository choices: distinct `owner/repo` recorded in the golden, in order. */
export function launchRepoOptions(config: Golden["config"]): string[] {
  return [...new Set(goldenRepos(config).flatMap((repo) => (repo.slug ? [repo.slug] : [])))];
}

/** The form's starting values when rebuilding a golden: what it records today. */
export function editDefaults(golden: Pick<Golden, "config">): { repos: RepoRow[]; init: string } {
  const repos = goldenRepos(golden.config).map((repo) => ({
    url: repo.slug ?? repo.url,
    branch: repo.branch,
    dir: repo.dir,
  }));
  return {
    repos: repos.length ? repos : [{ url: "", branch: "", dir: "" }],
    init: goldenInit(golden.config).join("\n"),
  };
}

export type GoldenRowState = {
  /** Another visible row of the same provider has this name: `golden/update` selects by name and cannot tell them apart. */
  duplicateName: boolean;
  canRebuild: boolean;
  /** Why rebuild is not offered, when it is not. */
  reason: string | null;
};

/**
 * What the dashboard offers for one golden. A hint only: the server checks the owner/admin rule and the
 * provider's capacity again, and those checks are the ones that count.
 */
export function goldenRowState(
  golden: Pick<Golden, "name" | "provider" | "visibility" | "owner_id">,
  visible: readonly Pick<Golden, "name" | "provider">[],
  viewer: { id: string; isAdmin: boolean },
): GoldenRowState {
  const duplicateName =
    visible.filter((row) => row.name === golden.name && row.provider === golden.provider).length > 1;
  const reason = duplicateName
    ? `Two visible ${PROVIDER_LABELS[golden.provider]} goldens share this name; the rebuild API cannot tell them apart.`
    : golden.visibility === "private" && golden.owner_id !== viewer.id
      ? "Only the owner rebuilds a private golden."
      : golden.visibility === "org" && !viewer.isAdmin
        ? "Only an org admin rebuilds an org golden."
        : null;
  return { duplicateName, canRebuild: reason === null, reason };
}

/**
 * Why the viewer may not remove this golden, or null when they may: the owner removes a private golden, an org
 * admin an org golden. A hint for the page; the server's `golden/remove` applies the same rule and is the authority.
 */
export function goldenRemoveBlocker(
  golden: Pick<Golden, "visibility" | "owner_id">,
  viewer: { id: string; isAdmin: boolean },
): string | null {
  if (golden.visibility === "private") return golden.owner_id === viewer.id ? null : "Only its owner removes it.";
  return viewer.isAdmin ? null : "Only an org admin removes an org golden.";
}

export type CapacityState =
  | { kind: "unavailable"; reason: string }
  | { kind: "unknown" }
  | { kind: "available"; capacity: number; used: number }
  | { kind: "full"; capacity: number; used: number }
  | { kind: "legacy"; capacity: number; used: number };

/** Visible authoritative current-backend usage only; missing metadata never falls back to row counts. */
export function providerCapacity(
  _goldens: readonly Pick<Golden, "provider">[],
  read: GoldenCapabilities,
  _provider: SandboxProviderId,
): CapacityState {
  if (!read.ok) return { kind: "unavailable", reason: read.reason };
  const capacity = read.maxGoldens;
  if (capacity === null) return { kind: "unknown" };
  if (!read.bindings) return { kind: "unavailable", reason: "This Armada server does not report golden usage yet." };
  const used = read.bindings.filter((binding) => binding.relation === "current_backend").length;
  if (used > capacity) return { kind: "legacy", capacity, used };
  if (used === capacity) return { kind: "full", capacity, used };
  return { kind: "available", capacity, used };
}

export type { GoldenConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
