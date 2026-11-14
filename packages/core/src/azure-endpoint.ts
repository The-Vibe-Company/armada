import { VaultError } from "./vault-error.ts";

export const AZURE_ACCOUNT_CHECK_TIMEOUT_MS = 25_000;
export const MODEL_ACCOUNT_WRITE_TIMEOUT_MS = 45_000;

/** Public Azure resource zones only; never arbitrary custom hosts or a caller-controlled port. */
export function isAzureResourceHost(hostname: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}\.(?:openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/.test(
    hostname.toLowerCase().replace(/\.$/, ""),
  );
}

/** Shared owner-facing preset and server-side network destination policy. No request is made here. */
export function validateAzureOpenAIAddress(baseUrl: string): string {
  const invalid = () =>
    new VaultError("invalid", "Use your public Azure OpenAI or Foundry HTTPS resource address ending in /openai/v1.");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.hostname.endsWith(".") ||
    !isAzureResourceHost(url.hostname)
  )
    throw invalid();
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
  if (!url.pathname.endsWith("/openai/v1")) throw invalid();
  return url.toString().replace(/\/$/, "");
}
