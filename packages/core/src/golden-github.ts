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
  /** The GitHub App's server-only signing credentials; absent credentials are a configuration error. */
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
  return {
    async authorize(actor, _visibility, requested) {
      const token = await options.accessToken(actor);
      const installations = await fetchGitHubInstallations(token, { fetch: fetchImpl });
      const result: AuthorizedRepo[] = [];
      for (const value of requested) {
        const { owner, repo } = requestedRepo(value);
        const repository = await userRepository(token, owner, repo, fetchImpl);
        const installation = installationFor(repository, installations);
        if (!installation) {
          throw new GoldenError(
            "forbidden",
            `You cannot create a golden from '${owner}/${repo}' with this GitHub App installation.`,
          );
        }
        result.push({
          owner: repository.owner.login,
          repo: repository.name,
          id: repository.id,
          installationId: installation.id,
          branch: repository.default_branch,
        });
      }
      return result;
    },
    async mint(installationId, repoIds) {
      if (!options.app) {
        throw new GitHubAuthError(
          "misconfigured",
          "Secure golden checkout requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY; OAuth client credentials cannot mint installation tokens.",
        );
      }
      const issued = await mintInstallationToken(options.app, installationId, repoIds, { fetch: fetchImpl });
      return { token: issued.token, revoke: () => revokeInstallationToken(issued.token, { fetch: fetchImpl }) };
    },
  };
}

interface UserRepository {
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
    throw new GoldenError("forbidden", `You cannot access repository '${owner}/${repo}'.`);
  if (!response.ok || !isRepository(body))
    throw new GitHubAuthError("unavailable", `GitHub did not return repository '${owner}/${repo}'.`);
  return body;
}

function installationFor(
  repo: UserRepository,
  installations: readonly GitHubInstallation[],
): GitHubInstallation | undefined {
  // /repos/{owner}/{repo}/installation is intentionally not called: with a user token GitHub can
  // reveal an installation the caller cannot administer. Match only installations already listed to them.
  return installations.find(
    (installation) => installation.accountLogin.toLowerCase() === repo.owner.login.toLowerCase(),
  );
}

function headers(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "armada" };
}

function isRepository(value: unknown): value is UserRepository {
  if (!value || typeof value !== "object") return false;
  const repo = value as Record<string, unknown>;
  return (
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
