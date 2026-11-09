import { type CredentialKind, type CredentialScope, parseCredentialValue, VaultError } from "@armada/core";

export type CredentialKindInfo = {
  kind: CredentialKind;
  label: string;
  /**
   * `model`: the agent's own key, injected into the sandboxes it launches under `env`. `hosting`: pays for and
   * runs the sandboxes; it stays on the Armada server and never enters a sandbox.
   */
  use: "model" | "hosting";
  /** Model credentials: the environment variable a sandbox gets it as. Hosting credentials have none. */
  env: string | null;
  description: string;
};

/** OpenCode and z.ai keys come with OpenCode support (v1): the schema has no kind for them yet. */
export const CREDENTIAL_KINDS: readonly CredentialKindInfo[] = [
  {
    kind: "claude_oauth",
    label: "Claude Code OAuth token",
    use: "model",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    description: "From `claude setup-token`. Runs Claude Code on a Claude subscription.",
  },
  {
    kind: "anthropic",
    label: "Anthropic API key",
    use: "model",
    env: "ANTHROPIC_API_KEY",
    description: "Runs Claude Code on pay-as-you-go API billing.",
  },
  {
    kind: "openai",
    label: "Codex / OpenAI API key",
    use: "model",
    env: "OPENAI_API_KEY",
    description: "Runs Codex.",
  },
  {
    kind: "boat",
    label: "boat.dev API key",
    use: "hosting",
    env: null,
    description: "Hosts sandboxes on Boat. An org key covers everyone; a personal key covers your private goldens.",
  },
  {
    kind: "modal",
    label: "Modal token",
    use: "hosting",
    env: null,
    description: "Hosts sandboxes on Modal: a token ID and its secret, stored together.",
  },
];

/** The kinds stored from one pasted value; the Modal token has its own two-field form. */
export const SINGLE_VALUE_KINDS = CREDENTIAL_KINDS.filter((info) => info.kind !== "modal");

export const MAX_SECRET_LENGTH = 8192;

export function credentialKindInfo(kind: CredentialKind): CredentialKindInfo {
  const info = CREDENTIAL_KINDS.find((item) => item.kind === kind);
  if (!info) throw new Error(`unknown credential kind ${kind}`);
  return info;
}

export function isCredentialKind(value: string): value is CredentialKind {
  return CREDENTIAL_KINDS.some((item) => item.kind === value);
}

export function isCredentialScope(value: string): value is CredentialScope {
  return value === "user" || value === "org";
}

export type SecretCheck = { ok: true; value: string } | { ok: false; error: string };

/** A pasted key is trimmed. Whitespace inside one is almost always a bad paste, so it is refused. */
export function checkSecretValue(raw: unknown): SecretCheck {
  if (typeof raw !== "string") return { ok: false, error: "Enter the value to store." };
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter the value to store." };
  if (value.length > MAX_SECRET_LENGTH) return { ok: false, error: "That value is too long to be a key." };
  if (/\s/.test(value)) return { ok: false, error: "A key has no spaces or line breaks. Check what you pasted." };
  return { ok: true, value };
}

/**
 * A Modal token from its two fields. Both halves are required; the server's own parser (`parseCredentialValue`,
 * over `parseModalTokenPair`) checks them together and gives the canonical `{"token_id", "token_secret"}` JSON
 * that is encrypted and stored. Errors never repeat a value.
 */
export function checkModalToken(rawId: unknown, rawSecret: unknown): SecretCheck {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  const secret = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (!id) return { ok: false, error: "Enter the Modal token ID (ak-…)." };
  if (!secret) return { ok: false, error: "Enter the Modal token secret (as-…)." };
  try {
    return { ok: true, value: parseCredentialValue("modal", JSON.stringify({ token_id: id, token_secret: secret })) };
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
}
