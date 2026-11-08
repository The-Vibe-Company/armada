import type { Harness } from "./contract.ts";
import type { CredentialScope } from "./database.types.ts";
import type { GoldenActor } from "./golden.ts";
import { LaunchError } from "./launch-error.ts";

/** The credential kinds a launch injects. Claude Code takes a subscription token, Codex an OpenAI key or `auth.json`. */
export type LaunchCredentialKind = "claude_oauth" | "openai";

/**
 * Where decrypted credentials come from. The database holds ciphertext a user JWT cannot read,
 * so the real source (#461) runs where the encryption key is. Returns null when none is set.
 */
export interface CredentialSource {
  get(scope: CredentialScope, ownerId: string, kind: LaunchCredentialKind): Promise<string | null>;
}

/** The variable that carries the content of Codex's `auth.json` into the sandbox, where launch writes it to disk. */
export const CODEX_AUTH_ENV = "ARMADA_CODEX_AUTH_JSON";

/** What a launch hands to the sandbox: its environment, and every value in it that must never be printed. */
export interface HarnessCredentials {
  env: Record<string, string>;
  secrets: string[];
  /** The harness reads its login from this file, which launch writes from {@link CODEX_AUTH_ENV}. */
  codexAuthJson: boolean;
}

/** The user's own credential wins over the org's default. A blank value counts as not set. */
export async function resolveCredential(
  source: CredentialSource,
  actor: GoldenActor,
  kind: LaunchCredentialKind,
): Promise<string | null> {
  const own = clean(await source.get("user", actor.userId, kind));
  if (own) return own;
  return clean(await source.get("org", actor.orgId, kind));
}

/**
 * Resolves the credentials of one harness and nothing else: no other model key, and never an
 * account-level secret of the provider. Throws before anything starts when the harness has none.
 */
export async function harnessCredentials(
  source: CredentialSource,
  actor: GoldenActor,
  harness: Harness,
): Promise<HarnessCredentials> {
  if (harness === "claude") {
    const token = await resolveCredential(source, actor, "claude_oauth");
    if (!token) {
      throw new LaunchError(
        "no_credentials",
        "No Claude Code token is set for you or your org. Connect Claude through Anthropic SSO first.",
      );
    }
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, secrets: [token], codexAuthJson: false };
  }
  const value = await resolveCredential(source, actor, "openai");
  if (!value) {
    throw new LaunchError(
      "no_credentials",
      "No OpenAI key or Codex auth.json is set for you or your org. Add one before launching Codex.",
    );
  }
  if (value.startsWith("{")) {
    const leaves = authJsonSecrets(value);
    return { env: { [CODEX_AUTH_ENV]: value }, secrets: [value, ...leaves], codexAuthJson: true };
  }
  return { env: { OPENAI_API_KEY: value }, secrets: [value], codexAuthJson: false };
}

/** Replaces every secret in `text`, so command output and error messages are safe to show. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret !== "") out = out.split(secret).join("***");
  }
  return out;
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function authJsonSecrets(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LaunchError("no_credentials", "The stored Codex auth.json is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LaunchError("no_credentials", "The stored Codex auth.json is not a JSON object.");
  }
  const leaves: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (node.length >= 8) leaves.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (typeof node === "object" && node !== null) {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(parsed);
  return leaves;
}
