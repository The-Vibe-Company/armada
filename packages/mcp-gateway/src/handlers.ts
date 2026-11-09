import { GatewayError } from "./network.ts";
import type { OAuthBroker } from "./oauth.ts";

/** Mount at the exact redirectUri configured on the broker, behind signed-in browser auth.
 * No return URL is accepted from the request, and upstream errors are never reflected.
 */
export function createOAuthCallbackHandler(options: {
  broker: OAuthBroker;
  redirectUri: string;
  actor(request: Request): Promise<string>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
    try {
      const url = new URL(request.url);
      if (request.method !== "GET" || `${url.origin}${url.pathname}` !== options.redirectUri)
        return new Response(null, { status: 404, headers });
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const issuer = url.searchParams.get("iss");
      if (
        !state ||
        !code ||
        state.length > 1024 ||
        code.length > 8192 ||
        ["state", "code", "iss", "error"].some((key) => url.searchParams.getAll(key).length > 1) ||
        url.searchParams.has("error")
      )
        throw new GatewayError("needs_reconnect", "Authorization was not completed. Reconnect.");
      await options.broker.callback({
        actorId: await options.actor(request),
        state,
        code,
        ...(issuer === null ? {} : { issuer }),
      });
      return Response.json({ status: "connected" }, { headers });
    } catch (error) {
      const failure = error instanceof GatewayError ? error : new GatewayError("denied", "Sign in and reconnect.");
      return Response.json({ code: failure.code, action: failure.action }, { status: 400, headers });
    }
  };
}

/** Public, static CIMD document: no credentials or request-selected redirect targets. */
export function createClientMetadataHandler(options: {
  clientMetadataUrl: string;
  redirectUri: string;
}): (request: Request) => Response {
  const clientId = new URL(options.clientMetadataUrl).href;
  return (request) => {
    if (request.method !== "GET" || request.url !== clientId) return new Response(null, { status: 404 });
    return Response.json(
      {
        client_id: clientId,
        client_name: "Armada",
        redirect_uris: [options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  };
}
