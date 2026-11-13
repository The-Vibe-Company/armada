import { readBoundedText } from "@armada/auth";
import type { CallerResult } from "./caller.ts";
import { type createDockerHostStore, DockerHostDenied } from "./docker-host-store.ts";
import type { Route } from "./http.ts";

const machinePaths = ["/api/docker-host/register", "/api/docker-host/poll", "/api/docker-host/results"];
const ownerPaths = ["/api/v1/docker/hosts/list", "/api/v1/docker/hosts/register-token", "/api/v1/docker/hosts/revoke"];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
class InvalidInput extends Error {}
function fields(value: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(value).length !== names.length || names.some((name) => !(name in value))) throw new InvalidInput();
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInput();
  return value;
}

/** Mounted only by ARMADA_DOCKER_HOSTS=1. Machine authority never authenticates a user API. */
export function createDockerHostRoutes(
  store: ReturnType<typeof createDockerHostStore>,
  authenticate: (request: Request) => Promise<CallerResult>,
  options: { placement?: boolean } = {},
): Route {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const owner = ownerPaths.includes(path);
    if (!owner && !machinePaths.includes(path)) return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    try {
      // Explicit bearer authority only, including dashboard server-side user sessions.
      if (request.headers.has("origin")) throw new InvalidInput();
      let actor: { userId: string; orgId: string } | undefined;
      if (owner) {
        const result = await authenticate(request);
        if (!result.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
        const body: unknown = JSON.parse(await readBoundedText(request, 4096));
        if (!object(body)) throw new InvalidInput();
        fields(body, path.endsWith("/revoke") ? ["org", "hostId"] : ["org"]);
        const orgId = string(body.org);
        const listing = path.endsWith("/list");
        if (
          !uuid.test(orgId) ||
          !result.caller.orgs.some((org) => org.orgId === orgId && (listing || org.role === "admin"))
        )
          throw new DockerHostDenied();
        actor = { userId: result.caller.userId, orgId };
        if (listing)
          return Response.json({ placement: options.placement === true, hosts: await store.list(actor) }, { headers });
        if (path.endsWith("/register-token")) return Response.json(await store.issueRegistration(actor), { headers });
        await store.revoke(actor, string(body.hostId));
        return Response.json({ revoked: true }, { headers });
      }
      const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) throw new DockerHostDenied();
      const body: unknown = JSON.parse(await readBoundedText(request, 4096));
      if (!object(body)) throw new InvalidInput();
      fields(body, path.endsWith("/results") ? ["installationId", "requestId", "outcome"] : ["installationId"]);
      const installationId = string(body.installationId);
      if (path.endsWith("/register"))
        return Response.json(await store.exchangeRegistration(token, installationId), { headers });
      if (path.endsWith("/poll")) return Response.json({ job: await store.poll(token, installationId) }, { headers });
      const outcome = string(body.outcome);
      if (outcome !== "completed" && outcome !== "failed") throw new InvalidInput();
      const requestId = string(body.requestId);
      await store.complete(token, installationId, { requestId, outcome });
      return Response.json({ requestId }, { headers });
    } catch (error) {
      return Response.json(
        { error: error instanceof DockerHostDenied ? "docker_host_denied" : "docker_host_unavailable" },
        {
          status:
            error instanceof DockerHostDenied
              ? owner
                ? 403
                : 401
              : error instanceof InvalidInput || error instanceof SyntaxError
                ? 400
                : 503,
          headers,
        },
      );
    }
  };
}
