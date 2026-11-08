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
  toHarnessCredentials,
} from "@armada/core";

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
): LaunchCredentialResolver {
  return {
    async resolve(actor: GoldenActor, harness: Harness): Promise<HarnessCredentials> {
      const resolved = await resolveCredentials(reader, encryptionKey, {
        userId: actor.userId,
        orgId: actor.orgId,
        harness,
      });
      const access = github ? await resolveGitHubAccess({ ...github, encryptionKey }, actor.userId) : undefined;
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
