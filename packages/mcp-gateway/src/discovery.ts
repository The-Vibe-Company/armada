import {
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { endpoint, GatewayError, publicFetch, restrictedFetch } from "./network.ts";
import { discoverOAuthIssuer } from "./oauth.ts";

/** Registry request/DTO contract: omitted authType means auto. Overrides remain write-only. */
export type RemoteAuthType = "auto" | "none" | "oauth" | "bearer" | "headers";
export type RemoteDiscoveryResult =
  | { authType: "none"; state: "reachable"; serverInfo: Implementation; capabilities: ServerCapabilities }
  | {
      authType: "oauth";
      state: "authorization_required";
      issuer: string;
      resource: string;
      scope?: string;
      resourceMetadataUrl?: string;
    };

/** Auto-discovery never creates a grant or persists a connected state. Public success
 * requires a real MCP initialize exchange, not merely a 200/405 HTTP response.
 */
export function createRemoteAuthResolver(options: { fetch?: FetchLike } = {}) {
  return async (input: {
    url: string;
    transport: "http" | "sse";
    signal?: AbortSignal;
  }): Promise<RemoteDiscoveryResult> => {
    const url = endpoint(input.url);
    const fetcher = options.fetch ?? publicFetch;
    const resourceFetch = restrictedFetch(
      fetcher,
      (target) => target.origin === url.origin && (input.transport === "sse" || target.href === url.href),
    );
    let challenge: ReturnType<typeof extractWWWAuthenticateParams> | undefined;
    const probeFetch: FetchLike = async (target, init) => {
      const response = await resourceFetch(target, { ...init, ...(input.signal ? { signal: input.signal } : {}) });
      if (response.status === 401) challenge = extractWWWAuthenticateParams(response);
      return response;
    };
    const transport =
      input.transport === "sse"
        ? new SSEClientTransport(url, { fetch: probeFetch })
        : new StreamableHTTPClientTransport(url, {
            fetch: probeFetch,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 0,
              maxReconnectionDelay: 0,
              reconnectionDelayGrowFactor: 1,
            },
          });
    const client = new Client({ name: "Armada discovery", version: "1" });
    try {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      const capabilities = client.getServerCapabilities();
      if (!serverInfo || !capabilities) throw new GatewayError("upstream", "MCP initialization was incomplete.");
      return { authType: "none", state: "reachable", serverInfo, capabilities };
    } catch (error) {
      if (!challenge) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(
          "upstream",
          "MCP initialization failed. Verify endpoint and transport; no connected state was stored.",
        );
      }
    } finally {
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId)
        await transport.terminateSession().catch(() => {});
      await client.close();
    }
    try {
      const metadataFetch = restrictedFetch(fetcher, (target) => target.origin === url.origin);
      const prm = await discoverOAuthProtectedResourceMetadata(
        url,
        challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {},
        metadataFetch,
      );
      if (prm.resource !== input.url && prm.resource !== url.href)
        throw new GatewayError("unsafe_endpoint", "Protected resource identifier mismatch.");
      const issuer = prm.authorization_servers?.[0];
      if (!issuer || !(await discoverOAuthIssuer(issuer, fetcher)))
        throw new GatewayError("unsupported", "OAuth discovery is unavailable; provider configuration is required.");
      const scope = challenge?.scope ?? prm.scopes_supported?.join(" ");
      return {
        authType: "oauth",
        state: "authorization_required",
        issuer,
        resource: prm.resource,
        ...(scope ? { scope } : {}),
        ...(challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl.href } : {}),
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        "unsupported",
        "Authorization is required but OAuth discovery failed. Configure a reviewed provider or an explicit write-only bearer/header override.",
      );
    }
  };
}
