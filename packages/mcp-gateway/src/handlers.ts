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
