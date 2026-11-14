import { type BoundModelConnection, testModelConnection } from "@armada/agent-runtime";
import {
  AZURE_ACCOUNT_CHECK_TIMEOUT_MS,
  type CredentialKind,
  isAzureResourceHost,
  parseCredentialValue,
  parseOpenCodeEndpoint,
  VaultError,
  validateAzureOpenAIAddress,
} from "@armada/core";
import { publicFetch } from "../../mcp-gateway/src/network.ts";

type Fetcher = Parameters<typeof testModelConnection>[3];

/**
 * Azure account admission only, not a general server-side URL probe. All outbound destinations
 * pass the shared public Microsoft resource-zone/v1 policy; redirects are refused by the wire check.
 * Existing bound-sandbox tests for arbitrary custom endpoints remain runtime-only.
 */
export async function validateAzureModelAccount(kind: CredentialKind, raw: string, fetcher?: Fetcher): Promise<void> {
  if (kind !== "openai" && kind !== "opencode") return;
  const value = parseCredentialValue(kind, raw);
  if (!value.startsWith("{")) return;
  const row = JSON.parse(value);
  const url = new URL(row.endpoint.baseUrl);
  const explicitAzure = kind === "opencode" && row.endpoint.protocol === "azure";
  if (!explicitAzure && !isAzureResourceHost(url.hostname)) return;
  const baseUrl = validateAzureOpenAIAddress(row.endpoint.baseUrl);
  if (kind === "opencode" && !explicitAzure)
    throw new VaultError("invalid", "Choose Azure for OpenCode to use its native Azure Responses connection.");
  const models: string[] = kind === "openai" ? row.models : row.endpoint.models;
  if (!Array.isArray(models) || !models.length)
    throw new VaultError("invalid", "Enter at least one Azure deployment name. The account was not saved.");
  const connection: BoundModelConnection =
    kind === "openai"
      ? { harness: "codex", endpoint: { ...row.endpoint, baseUrl }, apiKey: row.apiKey }
      : {
          harness: "opencode",
          endpoint: { ...parseOpenCodeEndpoint(row.endpoint), baseUrl, protocol: "azure" },
          apiKey: row.apiKey,
        };
  // One tiny billable request per declared deployment. A finite total budget prevents many
  // declarations from holding an account write open indefinitely; no partial save is performed.
  const transport: NonNullable<Fetcher> =
    fetcher ?? ((input, init) => publicFetch(input instanceof Request ? input.url : input, init));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AZURE_ACCOUNT_CHECK_TIMEOUT_MS);
  try {
    for (const model of models) {
      const result = await testModelConnection(connection, model, controller.signal, transport);
      if (controller.signal.aborted)
        throw new VaultError("unavailable", "Azure deployment checks timed out. The account was not saved.");
      if (!result.ok) {
        const detail = result.status === null ? "unavailable or timed out" : `HTTP ${result.status}`;
        throw new VaultError(
          result.status === null ? "unavailable" : "invalid",
          `Azure deployment check failed (${detail}${result.code ? `, ${result.code}` : ""}). Check the deployment name, resource and key. The account was not saved.`,
        );
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
