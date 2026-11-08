import type { CredentialKind, CredentialScope } from "@armada/core";

export type CredentialKindInfo = {
  kind: CredentialKind;
  label: string;
  /** The environment variable Armada injects it as when it launches a sandbox. */
  env: string;
  description: string;
};

/** OpenCode and z.ai keys come with OpenCode support (v1): the schema has no kind for them yet. */
export const CREDENTIAL_KINDS: readonly CredentialKindInfo[] = [
  {
    kind: "claude_oauth",
    label: "Claude Code OAuth token",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    description: "From `claude setup-token`. Runs Claude Code on a Claude subscription.",
  },
  {
    kind: "anthropic",
    label: "Anthropic API key",
    env: "ANTHROPIC_API_KEY",
    description: "Runs Claude Code on pay-as-you-go API billing.",
  },
  {
    kind: "openai",
    label: "Codex / OpenAI API key",
    env: "OPENAI_API_KEY",
    description: "Runs Codex.",
  },
  {
    kind: "boat",
    label: "boat.dev API key",
    env: "BOAT_API_KEY",
    description: "Pays for the sandboxes. An org key covers everyone; a personal key covers your private goldens.",
  },
];

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
