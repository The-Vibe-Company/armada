import { createSign } from "node:crypto";
import { GitHubAuthError, type GitHubInstallationApp } from "./github.ts";

const API = "https://api.github.com";
const TIMEOUT = 15_000;

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
}

/** A GitHub App JWT has a deliberately short lifetime and is used only to mint installation tokens. */
export function githubAppJwt(app: GitHubInstallationApp, now = new Date()): string {
  const b64 = (value: string) => Buffer.from(value).toString("base64url");
  const iat = Math.floor(now.getTime() / 1000) - 30;
  const body = b64(JSON.stringify({ iat, exp: iat + 9 * 60, iss: app.appId }));
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${body}`);
    signer.end();
    return `${head}.${body}.${signer.sign(app.privateKey).toString("base64url")}`;
  } catch (cause) {
    throw new GitHubAuthError("misconfigured", "GITHUB_APP_PRIVATE_KEY cannot sign GitHub App requests.", { cause });
  }
}

/** Mints GitHub's one-hour installation token. It is intentionally returned only in memory. */
export async function mintInstallationToken(
  app: GitHubInstallationApp,
  installationId: number,
  repositoryIds: number[],
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<InstallationToken> {
  if (!Number.isSafeInteger(installationId) || installationId < 1 || repositoryIds.length < 1) {
    throw new GitHubAuthError("misconfigured", "A valid installation and at least one repository are required.");
  }
  const jwt = githubAppJwt(app, options.now?.());
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "user-agent": "armada" },
      body: JSON.stringify({ repository_ids: repositoryIds }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (cause) {
    throw new GitHubAuthError("unavailable", "GitHub could not mint a repository token.", { cause });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object") {
    throw new GitHubAuthError(
      response.status === 401 || response.status === 403 ? "misconfigured" : "unavailable",
      "GitHub refused the installation token request.",
    );
  }
  const data = body as { token?: unknown; expires_at?: unknown };
  if (typeof data.token !== "string" || typeof data.expires_at !== "string") {
    throw new GitHubAuthError("unavailable", "GitHub did not return an installation token.");
  }
  const expiresAt = new Date(data.expires_at);
  const lifetime = expiresAt.getTime() - (options.now?.() ?? new Date()).getTime();
  if (!Number.isFinite(expiresAt.getTime()) || lifetime <= 0 || lifetime > 61 * 60 * 1000) {
    throw new GitHubAuthError("unavailable", "GitHub returned an invalid installation token lifetime.");
  }
  return { token: data.token, expiresAt, installationId };
}

/** Installation tokens are explicitly revoked as soon as checkout finishes. */
export async function revokeInstallationToken(token: string, options: { fetch?: typeof fetch } = {}): Promise<void> {
  try {
    const response = await (options.fetch ?? fetch)(`${API}/installation/token`, {
      method: "DELETE",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "armada" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
  } catch (cause) {
    throw new GitHubAuthError("unavailable", "GitHub could not revoke the installation token.", { cause });
  }
}
