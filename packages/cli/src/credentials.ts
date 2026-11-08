import type { CredentialScope, CredentialSource, LaunchCredentialKind } from "@armada/core";

const USER_VARS: Record<LaunchCredentialKind, string> = {
  claude_oauth: "ARMADA_CLAUDE_OAUTH_TOKEN",
  openai: "ARMADA_OPENAI_API_KEY",
};

const ORG_VARS: Record<LaunchCredentialKind, string> = {
  claude_oauth: "ARMADA_ORG_CLAUDE_OAUTH_TOKEN",
  openai: "ARMADA_ORG_OPENAI_API_KEY",
};

/**
 * Credentials from the environment, until Armada's encrypted store (#461) can serve them.
 * `ARMADA_*` is the caller's own, `ARMADA_ORG_*` the org default. `ARMADA_OPENAI_API_KEY` may hold
 * an API key or the content of Codex's `auth.json`. The boat.dev account is never read for these.
 */
export function envCredentials(env: Record<string, string | undefined>): CredentialSource {
  return {
    async get(scope: CredentialScope, _ownerId: string, kind: LaunchCredentialKind): Promise<string | null> {
      const name = (scope === "user" ? USER_VARS : ORG_VARS)[kind];
      return env[name] ?? null;
    },
  };
}
