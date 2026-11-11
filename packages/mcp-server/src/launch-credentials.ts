import {
  type CredentialKind,
  type CredentialReader,
  decryptSecret,
  type GitHubApp,
  type GitHubConnectionStore,
  type GoldenActor,
  type Harness,
  type HarnessCredentials,
  type LaunchCredentialResolver,
  resolveCredentials,
  resolveGitHubAccess,
  resolveSkillpackCredential,
  toHarnessCredentials,
} from "@armada/core";

import {
  installPrivateSkill,
  PrivateSkillError,
  sshHydrateAuthState,
  sshHydrateGitHubToken,
  VaultError,
} from "@armada/core/server";
import { refreshLegacyGitHub } from "./github-legacy.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";

/** The stored kinds whose value must never reach a command's output. */
const SECRET_KINDS: readonly CredentialKind[] = ["claude_oauth", "anthropic", "openai", "codex_auth"];

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
): LaunchCredentialResolver {
  return {
    installPrivateSkill,
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
    async admit(actor, credentials, sandboxId) {
      if (!credentials.codexAuthJson) return;
      if (!ownership) return; // Embedders without managed auth retain their legacy native path.
      try {
        const source = JSON.parse(credentials.env.ARMADA_CODEX_AUTH_JSON ?? "{}");
        if (typeof source.tokens?.refresh_token !== "string") return;
      } catch {
        return;
      }
      const binding = "binding" in credentials ? credentials.binding : undefined;
      if (
        !binding ||
        typeof binding !== "object" ||
        !("credentialId" in binding) ||
        !("credentialVersion" in binding) ||
        typeof binding.credentialId !== "string" ||
        typeof binding.credentialVersion !== "number"
      )
        return; // Unknown legacy bindings are not silently claimed or rehydrated.
      await ownership.claim(actor, binding.credentialId, binding.credentialVersion, sandboxId);
    },
    async hydrateNative(actor, credentials, sandboxId, provider, providerSandboxId) {
      const binding =
        "binding" in credentials
          ? (credentials.binding as { credentialId: string; credentialVersion: number } | undefined)
          : undefined;
      if (!ownership || !binding || !(await ownership.managed(sandboxId))) return false;
      const saved = await ownership.bootstrap(actor, binding.credentialId, binding.credentialVersion, sandboxId);
      if (!saved?.authJson) throw new Error("Native hydration state is unavailable.");
      if (provider.id === "boat") await sshHydrateAuthState(provider, providerSandboxId, saved.authJson);
      // Modal already hydrates this exact sealed state in its private stdin bootstrap.
      return true;
    },
    async releaseUnallocated(_actor, credentials, sandboxId) {
      const binding =
        "binding" in credentials
          ? (credentials.binding as { credentialId: string; credentialVersion: number } | undefined)
          : undefined;
      if (ownership && binding)
        await ownership.releaseUnallocated(binding.credentialId, binding.credentialVersion, sandboxId);
    },
    async nativeSecrets(actor, sandboxId, provider, providerSandboxId, phase = "after") {
      if (!ownership) return [];
      await ownership.assertSandbox(actor, sandboxId, false, true);
      const managed = await ownership.managed(sandboxId);
      if (phase === "before") await ownership.state.invalidateRedaction(actor, sandboxId);
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
      if (ownership) await ownership.assertSandbox(actor, sandboxId, resuming);
    },
    async resolve(
      actor: GoldenActor,
      harness: Harness,
      credentialId?: string,
      credentialVersion?: number,
    ): Promise<HarnessCredentials> {
      const resolved = await resolveCredentials(reader, encryptionKey, {
        userId: actor.userId,
        orgId: actor.orgId,
        harness,
        ...(credentialId !== undefined ? { credentialId } : {}),
        ...(credentialVersion !== undefined ? { credentialVersion } : {}),
      });
      const access = github
        ? await resolveGitHubAccess(
            { ...github, caller: "launch", encryptionKey, minimumLifetimeMs: 60 * 60 * 1000 },
            actor.userId,
          )
        : undefined;
      return toHarnessCredentials(resolved, access);
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
      values.push(value, ...jsonLeaves(value));
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
