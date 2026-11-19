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

import {
  createUsagePricingContext,
  installPrivateSkill,
  PrivateSkillError,
  sshHydrateAuthState,
  sshHydrateGitHubToken,
  VaultError,
} from "@armada/core/server";
import { refreshLegacyGitHub } from "./github-legacy.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { configureBoatSubscription } from "./subscription-boat.ts";

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
  admitExistingSandbox: NonNullable<LaunchCredentialResolver["admit"]>;
  resolveModel: (...args: Parameters<LaunchCredentialResolver["resolve"]>) => ReturnType<typeof resolveCredentials>;
} {
  async function resolveModel(actor: GoldenActor, harness: Harness, credentialId?: string, credentialVersion?: number) {
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
    installPrivateSkill,
    ...(repositoryAccess
      ? ({
          async authorizeRepositories(actor, credentials, repositories) {
            const access =
              credentials.github ??
              (await resolveGitHubAccess(
                { ...repositoryAccess, encryptionKey, caller: "launch", minimumLifetimeMs: 3_600_000 },
                actor.userId,
              ));
            const connected = access?.status === "connected" ? access : undefined;
            for (const repository of repositories) {
              let identity: { owner: string; repo: string };
              try {
                identity = normalizeGitHubGoldenConfig({ repos: [repository], init: [] }).repos[0]!;
              } catch {
                continue;
              } // Legacy non-GitHub sources retain their existing refresh path.
              const denied = () =>
                new LaunchError(
                  "no_credentials",
                  `Repository ${repository.dir} needs a GitHub connection with read access. Run armada github connect, grant your account and the Armada GitHub App access, then launch again.`,
                );
              const unknown = () =>
                new LaunchError(
                  "no_credentials",
                  `Repository ${repository.dir} could not be verified as public before launch. Run armada github connect or retry when GitHub is available.`,
                );
              const request = async (suffix = "") => {
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
              if ([401, 403, 404].includes(response.status)) throw denied();
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
              if (!connected) throw denied();
              const contents = await request(`/git/ref/heads/${encodeURIComponent(repository.branch)}`);
              if (
                contents &&
                [401, 403, 404].includes(contents.status) &&
                contents.headers.get("x-ratelimit-remaining") !== "0" &&
                !contents.headers.has("retry-after")
              )
                throw denied();
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
    async hydrateNative(actor, credentials, sandboxId, provider, providerSandboxId) {
      const binding =
        "binding" in credentials
          ? (credentials.binding as { credentialId: string; credentialVersion: number } | undefined)
          : undefined;
      if (
        ownership?.broker &&
        binding &&
        (await ownership.broker.enrolled(binding.credentialId, binding.credentialVersion))
      ) {
        if (provider.id === "boat")
          await configureBoatSubscription(
            provider,
            providerSandboxId,
            ownership.broker.configuration(actor, binding.credentialId, binding.credentialVersion, sandboxId),
          );
        return true;
      }
      if (!ownership || !binding || !(await ownership.managed(sandboxId))) return false;
      const saved = await ownership.bootstrap(actor, binding.credentialId, binding.credentialVersion, sandboxId);
      if (!saved?.authJson) throw new Error("Native hydration state is unavailable.");
      if (provider.id === "boat") await sshHydrateAuthState(provider, providerSandboxId, saved.authJson);
      // Modal already hydrates this exact sealed state in its private stdin bootstrap.
      return true;
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
