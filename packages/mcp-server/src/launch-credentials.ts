import {
  CLAUDE_ENDPOINT_ENV,
  CODEX_ENDPOINT_ENV,
  type CredentialKind,
  type CredentialReader,
  decryptSecret,
  type GitHubApp,
  type GitHubConnectionStore,
  type GoldenActor,
  type Harness,
  type HarnessCredentials,
  type LaunchCredentialResolver,
  LaunchError,
  MODEL_CREDENTIAL_KINDS,
  normalizeGitHubGoldenConfig,
  OPENCODE_ENDPOINT_ENV,
  parseCredentialValue,
  resolveCredentials,
  resolveGitHubAccess,
  resolveSkillpackCredential,
  toHarnessCredentials,
} from "@armada/core";

import { createUsagePricingContext, PrivateSkillError, sshHydrateGitHubToken, VaultError } from "@armada/core/server";
import { refreshLegacyGitHub } from "./github-legacy.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { currentRequestId } from "./request-observability.ts";

/** The stored kinds whose value must never reach a command's output. */
const SECRET_KINDS: readonly CredentialKind[] = MODEL_CREDENTIAL_KINDS;

/** The GitHub App and the connections it refreshes. Without it a launch reports GitHub as not connected. */
export interface GitHubLaunchOptions {
  store: GitHubConnectionStore;
  /** Null when the server has no GitHub App configured. */
  app: GitHubApp | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

type RepositoryDenial =
  | "metadata_denied"
  | "metadata_unverified"
  | "private_without_connection"
  | "branch_denied"
  | "repository_access_token_rejected";

/**
 * What a launch hands to the sandbox, resolved in this process with the same rules as `armada launch`:
 * the caller's own credential for the harness, else the org's of the golden. The org is the actor's.
 * GitHub is the caller's own connection only: it is who the commits are by.
 */
export function launchCredentials(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  github?: GitHubLaunchOptions,
  ownership?: ModelAuthOwnership,
  /** Runtime preflight only: never add this GitHub token to harness credentials/env. */
  repositoryGithub?: GitHubLaunchOptions,
): LaunchCredentialResolver & {
  launchAccountDefault?: ModelAuthOwnership["launchAccountDefault"];
  admitExistingSandbox: NonNullable<LaunchCredentialResolver["admit"]>;
  resolveModel: (...args: Parameters<LaunchCredentialResolver["resolve"]>) => ReturnType<typeof resolveCredentials>;
} {
  async function resolveModel(actor: GoldenActor, harness: Harness, credentialId?: string, credentialVersion?: number) {
    if (ownership && credentialId === undefined && credentialVersion === undefined) {
      const preference = await ownership.launchAccountDefault(actor.userId, harness);
      if (preference?.credentialIds.length) {
        const selected = await ownership.chooseLaunchPoolAccount(actor.userId, harness, preference);
        credentialId = selected.credentialId;
        credentialVersion = selected.credentialVersion;
      } else {
        credentialId = preference?.credentialId ?? undefined;
      }
    }
    return resolveCredentials(reader, encryptionKey, {
      userId: actor.userId,
      orgId: actor.orgId,
      harness,
      ...(credentialId !== undefined ? { credentialId } : {}),
      ...(credentialVersion !== undefined ? { credentialVersion } : {}),
    });
  }
  const enrollAccount: NonNullable<LaunchCredentialResolver["enrollAccount"]> = async (actor, credentials) => {
    if (credentials.codexAuthJson && ownership?.broker && credentials.binding)
      await ownership.broker.enroll(actor, credentials.binding.credentialId, credentials.binding.credentialVersion);
  };
  const repositoryAccess = github ?? repositoryGithub;
  return {
    resolveModel,
    ...(ownership ? { launchAccountDefault: ownership.launchAccountDefault } : {}),
    ...(repositoryAccess
      ? ({
          async authorizeRepositories(actor, credentials, repositories) {
            const resolveAccess = () =>
              resolveGitHubAccess(
                { ...repositoryAccess, encryptionKey, caller: "launch", minimumLifetimeMs: 3_600_000 },
                actor.userId,
              );
            const access = credentials.github ?? (await resolveAccess());
            let connected = access.status === "connected" ? access : undefined;
            let rechecked = false;
            const reportDenial = (reason: RepositoryDenial) => {
              try {
                const event = "launch_repository_github_denied";
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    event,
                    message: event,
                    requestId: currentRequestId(),
                    reason,
                    connectionStatus: access.status,
                  }),
                );
              } catch {}
            };
            for (const repository of repositories) {
              let identity: { owner: string; repo: string };
              try {
                identity = normalizeGitHubGoldenConfig({ repos: [repository], init: [] }).repos[0]!;
              } catch {
                continue;
              } // Legacy non-GitHub sources retain their existing refresh path.
              const denied = (reason: RepositoryDenial) => {
                reportDenial(reason);
                return new LaunchError(
                  "no_credentials",
                  `Repository ${repository.dir} needs a GitHub connection with read access. Run armada account login github, grant your account and the Armada GitHub App access, then launch again.`,
                );
              };
              const unknown = () => {
                reportDenial("metadata_unverified");
                return new LaunchError(
                  "no_credentials",
                  `Repository ${repository.dir} could not be verified as public before launch. Run armada account login github or retry when GitHub is available.`,
                );
              };
              const fetchRepository = async (suffix: string) => {
                try {
                  return await (repositoryAccess.fetch ?? fetch)(
                    `https://api.github.com/repos/${identity.owner}/${identity.repo}${suffix}`,
                    {
                      redirect: "error",
                      signal: AbortSignal.timeout(2000),
                      headers: {
                        accept: "application/vnd.github+json",
                        ...(connected ? { authorization: `Bearer ${connected.token}` } : {}),
                      },
                    },
                  );
                } catch {
                  return undefined;
                } // No cheap evidence: refresh still classifies its own outcome.
              };
              const request = async (suffix = "") => {
                const response = await fetchRepository(suffix);
                if (!repositoryGithub || github || rechecked || !connected || response?.status !== 401) return response;
                rechecked = true;
                const previous = connected;
                const latest = await resolveAccess();
                if (
                  latest.status !== "connected" ||
                  latest.identity.id !== previous.identity.id ||
                  latest.connectionEpoch !== previous.connectionEpoch ||
                  latest.token === previous.token
                )
                  return response;
                connected = latest;
                const retried = await fetchRepository(suffix);
                return retried?.ok ? retried : response;
              };
              const response = await request();
              if (
                !response ||
                response.status >= 500 ||
                response.status === 429 ||
                response.headers.get("x-ratelimit-remaining") === "0" ||
                response.headers.has("retry-after")
              ) {
                if (!connected) throw unknown();
                continue;
              }
              if (response.status === 401) throw denied("repository_access_token_rejected");
              if ([403, 404].includes(response.status)) throw denied("metadata_denied");
              if (!response.ok) {
                if (!connected) throw unknown();
                continue;
              }
              const metadata: unknown = await response.json().catch(() => null);
              if (
                !metadata ||
                typeof metadata !== "object" ||
                !("private" in metadata) ||
                typeof metadata.private !== "boolean"
              ) {
                if (!connected) throw unknown();
                continue;
              }
              if (!metadata.private) continue;
              if (!connected) throw denied("private_without_connection");
              const contents = await request(`/git/ref/heads/${encodeURIComponent(repository.branch)}`);
              if (
                contents &&
                [401, 403, 404].includes(contents.status) &&
                contents.headers.get("x-ratelimit-remaining") !== "0" &&
                !contents.headers.has("retry-after")
              )
                throw denied(contents.status === 401 ? "repository_access_token_rejected" : "branch_denied");
            }
          },
        } satisfies Pick<LaunchCredentialResolver, "authorizeRepositories">)
      : {}),
    async skillpackKey(actor) {
      try {
        return (await resolveSkillpackCredential(reader, encryptionKey, actor))?.key ?? null;
      } catch (error) {
        throw new PrivateSkillError(
          error instanceof VaultError && error.code === "credential_refused"
            ? "skillpack_credential_refused"
            : "skillpack_credential_unreadable",
        );
      }
    },
    async refreshGitHub(actor, provider, sandboxId) {
      if (!github) throw new VaultError("unavailable", "GitHub authorization is not configured.");
      const repaired = await refreshLegacyGitHub(
        provider,
        sandboxId,
        actor.userId,
        { ...github, encryptionKey },
        sshHydrateGitHubToken,
      );
      if (!repaired) throw new VaultError("unavailable", "GitHub is not connected for the sandbox owner.");
      return repaired;
    },
    enrollAccount,
    async admit(actor, credentials, sandboxId, model) {
      if (credentials.binding) await ownership?.admitLaunch(credentials.binding, sandboxId, model);
      await enrollAccount(actor, credentials);
    },
    async admitExistingSandbox(actor, credentials, sandboxId, model) {
      if (credentials.binding) await ownership?.admitCapacity(credentials.binding.credentialId, sandboxId, model);
      await enrollAccount(actor, credentials);
    },
    async releaseAdmission(sandboxId) {
      await ownership?.releaseCapacity(sandboxId);
    },
    async nativeSecrets(actor, sandboxId, provider, providerSandboxId, phase = "after") {
      if (!ownership) return [];
      await ownership.assertSandbox(actor, sandboxId, false, true);
      const managed = await ownership.managed(sandboxId);
      if (phase === "before" && !(await ownership.shared(sandboxId)))
        await ownership.state.invalidateRedaction(actor, sandboxId);
      const values = await ownership.capture(
        provider,
        providerSandboxId,
        { userId: actor.userId, orgId: actor.orgId },
        false,
        phase === "before",
      );
      if (managed && values.length === 0)
        throw new Error("Private native auth redaction is unavailable; no output may be returned.");
      // Exec may be invoked by an org peer; actor is the stored sandbox owner.
      return [
        ...values,
        ...(await exposedSecrets(reader, encryptionKey, { userId: actor.userId, orgId: actor.orgId })),
      ];
    },
    async assertExec(actor, sandboxId) {
      if (ownership) await ownership.assertSandbox(actor, sandboxId, false, true);
      return ownership ? ownership.managed(sandboxId) : false;
    },
    async assertTurn(actor, sandboxId, resuming) {
      if (ownership) {
        await ownership.assertSandbox(actor, sandboxId, resuming);
        await ownership.admitSandboxCapacity(sandboxId);
      }
    },
    async defaults(actor, harness) {
      if (ownership) {
        const preference = await ownership.launchAccountDefault(actor.userId, harness);
        if (!preference) return undefined;
        return {
          harness,
          credentialId: preference.credentialIds.length ? null : preference.credentialId,
          model: preference.model,
        };
      }
      return (await reader.agentDefaults?.(actor.userId))?.find((row) => row.harness === harness);
    },
    async resolve(
      actor: GoldenActor,
      harness: Harness,
      credentialId?: string,
      credentialVersion?: number,
    ): Promise<HarnessCredentials> {
      const resolved = await resolveModel(actor, harness, credentialId, credentialVersion);
      const access = github
        ? await resolveGitHubAccess(
            { ...github, caller: "launch", encryptionKey, minimumLifetimeMs: 60 * 60 * 1000 },
            actor.userId,
          )
        : undefined;
      const result = toHarnessCredentials(resolved, access);
      result.usagePricing = createUsagePricingContext({
        harness,
        credentialKind: resolved.sources[0]?.kind ?? null,
        ...(result.binding ?? {}),
        ...(result.modelPrices ? { modelPrices: result.modelPrices } : {}),
        customEndpoint: Boolean(
          result.env[CODEX_ENDPOINT_ENV] || result.env[CLAUDE_ENDPOINT_ENV] || result.env[OPENCODE_ENDPOINT_ENV],
        ),
      });
      if (ownership?.broker && result.codexAuthJson) {
        delete result.env.ARMADA_CODEX_AUTH_JSON;
        result.env.ARMADA_SERVER_CODEX = "1";
      }
      return result;
    },
  };
}

/**
 * Every model credential the caller and one org can use, decrypted, with the leaves of any auth.json:
 * what exec output is redacted of. A value that cannot be decrypted is an error, never skipped.
 */
export async function exposedSecrets(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  scopes: { userId: string; orgId: string },
): Promise<string[]> {
  const values: string[] = [];
  for (const [scope, owner] of [
    ["user", scopes.userId],
    ["org", scopes.orgId],
  ] as const) {
    for (const row of await reader.credentials(scope, owner)) {
      if (!SECRET_KINDS.includes(row.kind)) continue;
      const value = await decryptSecret(new Uint8Array(row.valueEnc), encryptionKey);
      if (row.kind === "morph" && value.trimStart().startsWith("{")) {
        try {
          const { apiKey } = JSON.parse(parseCredentialValue(row.kind, value));
          values.push(value, apiKey);
        } catch {
          values.push(value, ...jsonLeaves(value));
        }
      } else if (
        (row.kind === "openai" || row.kind === "anthropic" || row.kind === "opencode") &&
        value.startsWith("{")
      ) {
        const connection = JSON.parse(parseCredentialValue(row.kind, value));
        // Keep full-secret and endpoint/key redaction, not unrelated non-secret numeric prices.
        values.push(
          value,
          ...jsonLeaves(JSON.stringify({ endpoint: connection.endpoint, apiKey: connection.apiKey })),
          connection.apiKey,
        );
      } else values.push(value, ...jsonLeaves(value));
    }
  }
  return values;
}

function jsonLeaves(value: string): string[] {
  if (!value.startsWith("{")) return [];
  const leaves: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string" && node.length >= 8) leaves.push(node);
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (typeof node === "object" && node !== null) for (const item of Object.values(node)) walk(item);
  };
  try {
    walk(JSON.parse(value));
  } catch {}
  return leaves;
}
