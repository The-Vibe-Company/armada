import {
  fetchGitHubInstallations,
  GitHubAuthError,
  type GitHubInstallation,
  type GitHubInstallationApp,
} from "./github.ts";
import { mintInstallationToken, revokeInstallationToken } from "./github-installation.ts";
import type { GoldenActor } from "./golden.ts";
import { GoldenError } from "./golden-config.ts";
import type { AuthorizedRepo, GoldenCreateDeps } from "./golden-create-service.ts";

const API = "https://api.github.com";
const TIMEOUT = 15_000;

export interface GoldenGitHubAdapterOptions {
  /** Resolves the caller's cached OAuth access token. It must be the caller's token, never an app token. */
  accessToken(actor: GoldenActor): Promise<string>;
  /** The GitHub App's server-only signing credentials. Null: checkout falls back to the caller's own token. */
  app: GitHubInstallationApp | null;
  fetch?: typeof fetch;
}

/**
 * Creates the GitHub-facing parts of GoldenCreateService. Repository discovery is deliberately made
 * with the caller's OAuth token: an App installation can see more than the person who requested a
 * golden, and must never be used to elevate that person's repository access.
 */
export function goldenGitHubAdapter(options: GoldenGitHubAdapterOptions): Pick<GoldenCreateDeps, "authorize" | "mint"> {
  const fetchImpl = options.fetch ?? fetch;
  const adapter: Pick<GoldenCreateDeps, "authorize" | "mint"> = {
    async authorize(actor, _visibility, requested) {
      const token = await options.accessToken(actor);
      const installations = await fetchGitHubInstallations(token, { fetch: fetchImpl });
      const repos: AuthorizedRepo[] = [];
      for (const value of requested) {
        const { owner, repo } = requestedRepo(value);
        const repository = await userRepository(token, owner, repo, fetchImpl);
        let installation = installationFor(repository, installations, options.app?.appId);
        if (!installation && repository.private) {
          throw repositoryAccessError(owner, repo);
        }
        if (
          options.app &&
          installation?.repositorySelection === "selected" &&
          !(await installationCanRead(token, installation.id, repository.id, fetchImpl))
        ) {
          if (repository.private) throw repositoryAccessError(owner, repo);
          installation = undefined; // Public checkout can safely use the caller token.
        }
        repos.push({
          owner: repository.owner.login,
          repo: repository.name,
          id: repository.id,
          // Public repositories are verified through the caller's GitHub request but need no App
          // installation; zero prevents the scoped issuer from being selected for mixed sets.
          installationId: installation?.id ?? 0,
          branch: repository.default_branch,
        });
      }
      return { repos, token };
    },
  };
  // Without the App's signing key, checkout falls back to the caller's own token from `authorize`,
  // which `GoldenCreateService` never rotates or revokes. Only present `mint` when it can act.
  if (options.app) {
    const app = options.app;
    adapter.mint = async (installationId, repoIds) => {
      const issued = await mintInstallationToken(app, installationId, repoIds, { fetch: fetchImpl });
      return { token: issued.token, revoke: () => revokeInstallationToken(issued.token, { fetch: fetchImpl }) };
    };
  }
  return adapter;
}

interface UserRepository {
  private: boolean;
  id: number;
  name: string;
  default_branch: string;
  owner: { login: string };
}

function requestedRepo(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(value);
  if (!match?.[1] || !match[2])
    throw new GoldenError("invalid_config", `Invalid repository '${value}'. Use owner/repo.`);
  return { owner: match[1], repo: match[2] };
}

function repositoryAccessError(owner: string, repo: string): GoldenError {
  const message = `GitHub cannot read ${owner}/${repo} with your connection — grant the Armada GitHub App access to it and ensure your account can read it, then rebuild.`;
  return new GoldenError("forbidden", message, { safeMessage: message });
}

async function installationCanRead(
  token: string,
  installationId: number,
  repositoryId: number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  for (let page = 1; page <= 100; page++) {
    const response = await fetchImpl(
      `${API}/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      {
        headers: headers(token),
        signal: AbortSignal.timeout(TIMEOUT),
      },
    );
    if (!response.ok)
      throw new GitHubAuthError(
        "unavailable",
        "GitHub App repository access could not be checked. Retry when GitHub is available.",
      );
    const body: unknown = await response.json();
    const rows = body && typeof body === "object" && "repositories" in body ? body.repositories : null;
    if (!Array.isArray(rows))
      throw new GitHubAuthError("unavailable", "GitHub App repository access could not be checked.");
    if (rows.some((row) => row && typeof row === "object" && row.id === repositoryId)) return true;
    if (rows.length < 100) return false;
  }
  throw new GitHubAuthError(
    "unavailable",
    "GitHub App repository listing exceeded its limit. Ask an administrator to check access.",
  );
}

async function userRepository(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
): Promise<UserRepository> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (cause) {
    throw new GitHubAuthError("unavailable", "GitHub could not be reached.", { cause });
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403 || response.status === 404)
    throw repositoryAccessError(owner, repo);
  if (!response.ok || !isRepository(body))
    throw new GitHubAuthError("unavailable", `GitHub did not return repository '${owner}/${repo}'.`);
  return body;
}

function installationFor(
  repo: UserRepository,
  installations: readonly GitHubInstallation[],
  signingAppId?: string,
): GitHubInstallation | undefined {
  // /repos/{owner}/{repo}/installation is intentionally not called: with a user token GitHub can
  // reveal an installation the caller cannot administer. Match only installations already listed to them.
  return installations.find(
    (installation) =>
      installation.accountLogin.toLowerCase() === repo.owner.login.toLowerCase() &&
      (signingAppId === undefined || String(installation.appId) === signingAppId),
  );
}

function headers(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "armada" };
}

function isRepository(value: unknown): value is UserRepository {
  if (!value || typeof value !== "object") return false;
  const repo = value as Record<string, unknown>;
  return (
    typeof repo.private === "boolean" &&
    typeof repo.id === "number" &&
    Number.isSafeInteger(repo.id) &&
    repo.id > 0 &&
    typeof repo.name === "string" &&
    repo.name.length > 0 &&
    typeof repo.default_branch === "string" &&
    repo.default_branch.length > 0 &&
    typeof repo.owner === "object" &&
    repo.owner !== null &&
    typeof (repo.owner as Record<string, unknown>).login === "string"
  );
}
