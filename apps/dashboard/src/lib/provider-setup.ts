import type { MemberRole, SandboxProviderId } from "@armada/core";
import { checkModalToken, checkSecretValue, type SecretCheck } from "./credentials.ts";

/**
 * An organization's sandbox provider onboarding (#576), as the Armada server derives it (`org/provider/status`,
 * `org/provider/connect`). `ready` means the organization itself holds a provider credential (its Boat key column,
 * or an org-scoped Modal credential); a member's personal key never counts. The dashboard keeps no
 * flag, cookie or query of its own: every page reads this from the server again.
 */
export type ProviderStatus = {
  org: { id: string; name: string; role: MemberRole };
  ready: boolean;
  providers: { provider: SandboxProviderId; configured: boolean }[];
};

export const SETUP_PROVIDERS = ["boat", "modal"] as const satisfies readonly SandboxProviderId[];

export function isSetupProvider(value: unknown): value is SandboxProviderId {
  return value === "boat" || value === "modal";
}

export const SETUP_PROVIDER_INFO: Record<
  SandboxProviderId,
  { label: string; summary: string; docs: string; docsLabel: string }
> = {
  boat: {
    label: "Boat",
    summary: "One API key",
    docs: "https://docs.boat.dev",
    docsLabel: "Get a Boat API key",
  },
  modal: {
    label: "Modal",
    summary: "A token and its secret",
    docs: "https://modal.com/docs/reference/cli/token",
    docsLabel: "Get a Modal token",
  },
};

/** Where an organization's provider setup lives. */
export const providerSetupPath = (org: string) => `/orgs/${org}/setup`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The server's status, accepted only for the organization asked about and only when it is self-consistent (ready
 * exactly when a provider is configured, each provider listed once). Anything else is null: an unexpected answer,
 * never a guess at readiness.
 */
export function parseProviderStatus(value: unknown, org: string): ProviderStatus | null {
  if (!isRecord(value) || !isRecord(value.org) || typeof value.ready !== "boolean") return null;
  const { id, name, role } = value.org;
  if (id !== org || typeof name !== "string" || (role !== "admin" && role !== "member")) return null;
  if (!Array.isArray(value.providers)) return null;
  const providers: ProviderStatus["providers"] = [];
  for (const item of value.providers) {
    if (!isRecord(item) || !isSetupProvider(item.provider) || typeof item.configured !== "boolean") return null;
    if (providers.some((seen) => seen.provider === item.provider)) return null;
    providers.push({ provider: item.provider, configured: item.configured });
  }
  // Every provider is reported, configured or not: a partial list is an unexpected answer, not a pending setup.
  if (SETUP_PROVIDERS.some((provider) => !providers.some((item) => item.provider === provider))) return null;
  if (value.ready !== providers.some((item) => item.configured)) return null;
  return { org: { id, name, role }, ready: value.ready, providers };
}

export function isConfigured(status: ProviderStatus, provider: SandboxProviderId): boolean {
  return status.providers.some((item) => item.provider === provider && item.configured);
}

/**
 * The `value` sent to `org/provider/connect`: the Boat key as pasted (trimmed), or the Modal pair as its canonical
 * `{"token_id","token_secret"}` JSON. Errors never repeat what was typed.
 */
export function providerSetupValue(
  provider: SandboxProviderId,
  fields: { boatKey: unknown; modalTokenId: unknown; modalTokenSecret: unknown },
): SecretCheck {
  if (provider === "modal") return checkModalToken(fields.modalTokenId, fields.modalTokenSecret);
  const checked = checkSecretValue(fields.boatKey);
  return checked.ok ? checked : { ok: false, error: checked.error.replace("the value to store", "the Boat API key") };
}

/**
 * A server message about a refused connection, shown to the person. If it ever contained part of what they typed,
 * it is replaced: a secret is never echoed back into the page.
 */
export function safeConnectMessage(message: string, secrets: string[]): string {
  const leaked = secrets.some((secret) => secret.length >= 4 && message.includes(secret));
  return leaked ? "The provider refused these credentials. Check them and try again." : message;
}
