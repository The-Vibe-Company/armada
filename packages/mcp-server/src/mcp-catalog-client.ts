import { decryptSecret, type McpCatalogId, VaultError } from "@armada/core/server";
import type { OAuthServiceBinding } from "../../mcp-gateway/src/oauth.ts";
import { dashboardOrigin } from "./config.ts";

/** Slack advertises an origin audience, not its /mcp transport URL. No DCR. */
export const SLACK_OAUTH_BINDING: OAuthServiceBinding = {
  endpoint: "https://mcp.slack.com/mcp",
  resource: "https://mcp.slack.com",
  issuer: "https://mcp.slack.com",
  authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
  tokenFormat: "slack-user",
};
const scopes = new Set([
  "canvases:read",
  "canvases:write",
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "lists:read",
  "lists:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read.files",
  "search:read.im",
  "search:read.mpim",
  "search:read.private",
  "search:read.public",
  "search:read.users",
  "users:read",
  "users:read.email",
]);
/** Error messages must never interpolate configuration or parser failures. */
export function validateSlackRegistration(value: unknown, redirectUri: string): string {
  const c = value as Record<string, unknown> | null;
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    c.issuer !== SLACK_OAUTH_BINDING.issuer ||
    c.resource !== SLACK_OAUTH_BINDING.resource ||
    c.token_endpoint_auth_method !== "client_secret_post" ||
    typeof c.client_id !== "string" ||
    !/^[!-~]{1,200}$/.test(c.client_id) ||
    typeof c.client_secret !== "string" ||
    !/^[!-~]{1,1024}$/.test(c.client_secret) ||
    !Array.isArray(c.redirect_uris) ||
    c.redirect_uris.length !== 1 ||
    c.redirect_uris[0] !== redirectUri ||
    typeof c.scope !== "string" ||
    !c.scope.trim() ||
    c.scope.length > 2000 ||
    c.scope
      .trim()
      .split(/\s+/)
      .some((s) => !scopes.has(s))
  )
    throw new VaultError(
      "unavailable",
      "Invalid ARMADA_SLACK_MCP_CLIENT_ENC registration; verify issuer, resource, callback, client authentication and scopes.",
    );
  return JSON.stringify({
    client_id: c.client_id,
    client_secret: c.client_secret,
    issuer: c.issuer,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "client_secret_post",
    scope: [...new Set(c.scope.trim().split(/\s+/))].join(" "),
  });
}
/** Deployment ciphertext only; plaintext is confined to server memory and sealed per-instance grants/state. */
export function catalogAuthenticationFromEnv(
  env: Record<string, string | undefined>,
  key: string | undefined,
  dashboardUrl?: string,
  development = false,
) {
  const sealed = env.ARMADA_SLACK_MCP_CLIENT_ENC;
  const redirectUri = `${dashboardOrigin(dashboardUrl, development)}/auth/mcp/callback`;
  let registration: Promise<string> | undefined;
  return async (serviceId: McpCatalogId): Promise<string | undefined> => {
    if (serviceId !== "slack" || !sealed) return undefined;
    registration ??= (async () => {
      try {
        return validateSlackRegistration(
          JSON.parse(await decryptSecret(Buffer.from(sealed, "base64"), key)),
          redirectUri,
        );
      } catch {
        throw new VaultError(
          "unavailable",
          "Invalid ARMADA_SLACK_MCP_CLIENT_ENC registration; verify deployment configuration.",
        );
      }
    })();
    return registration;
  };
}
