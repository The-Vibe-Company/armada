import { BodyTooLargeError, readBoundedText } from "@armada/auth";
import type { CallerResult } from "./caller.ts";
import { type createDockerBootstrapService, DockerBootstrapDenied } from "./docker-bootstrap-service.ts";
import { DockerHostDenied } from "./docker-host-store.ts";
import { type createDockerRuntimeLifecycle, DockerRuntimeDenied } from "./docker-runtime-lifecycle.ts";
import { type createDockerSandboxService, DockerSandboxDenied } from "./docker-sandbox-service.ts";
import type { Route } from "./http.ts";

const prefix = "/api/v1/docker/sandboxes/";
const operations = new Set(["launch", "get", "bootstrap", "ready", "prompt", "journal", "stop", "delete", "job"]);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
class InvalidInput extends Error {}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function string(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInput();
  return value;
}
function fields(body: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !(key in body)) ||
    Object.keys(body).some((key) => ![...required, ...optional].includes(key))
  )
    throw new InvalidInput();
}

/** Explicit API-only preview lane. No public provider default or native/host agent fallback. */
export function createDockerSandboxRoutes(
  services: {
    sandboxes: ReturnType<typeof createDockerSandboxService>;
    bootstrap?: ReturnType<typeof createDockerBootstrapService>;
    runtime: ReturnType<typeof createDockerRuntimeLifecycle>;
  },
  authenticate: (request: Request) => Promise<CallerResult>,
): Route {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return null;
    const operation = path.slice(prefix.length);
    if (!operations.has(operation)) return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    try {
      // Like host registration: bearer-only, not cookie/browser-origin authority.
      if (request.headers.has("origin")) throw new InvalidInput();
      const identity = await authenticate(request);
      if (!identity.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
      const body: unknown = JSON.parse(await readBoundedText(request, 32768));
      if (!object(body)) throw new InvalidInput();
      const orgId = string(body.org);
      if (!uuid.test(orgId) || !identity.caller.orgs.some((org) => org.orgId === orgId))
        throw new DockerSandboxDenied();
      const actor = { userId: identity.caller.userId, orgId };
      if (operation === "launch") {
        fields(
          body,
          ["org", "requestId", "hostId", "image", "credentialId", "credentialVersion"],
          ["ttlSeconds", "model", "reasoningEffort"],
        );
        const { org: _org, ...input } = body;
        return Response.json(
          await services.sandboxes.reserve(actor, input as Parameters<typeof services.sandboxes.reserve>[1]),
          {
            status: 201,
            headers,
          },
        );
      }
      const sandboxId = string(body.sandboxId);
      if (operation === "get") {
        fields(body, ["org", "sandboxId"]);
        return Response.json(await services.sandboxes.get(actor, sandboxId), { headers });
      }
      if (operation === "journal") {
        fields(body, ["org", "sandboxId"], ["cursor", "limit"]);
        if (
          (body.cursor !== undefined && typeof body.cursor !== "string") ||
          (body.limit !== undefined && typeof body.limit !== "number")
        )
          throw new InvalidInput();
        return Response.json(
          await services.runtime.journal(actor, sandboxId, {
            ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
            ...(body.limit === undefined ? {} : { limit: body.limit }),
          }),
          { headers },
        );
      }
      fields(body, ["org", "sandboxId", "requestId", ...(operation === "prompt" ? ["text"] : [])]);
      const requestId = string(body.requestId);
      if (!uuid.test(requestId)) throw new InvalidInput();
      if (operation === "bootstrap") {
        if (!services.bootstrap) return Response.json({ error: "docker_placement_disabled" }, { status: 503, headers });
        return Response.json(await services.bootstrap.bootstrap(actor, sandboxId, requestId), { status: 202, headers });
      }
      if (operation === "ready" || operation === "prompt") {
        const result =
          operation === "ready"
            ? await services.runtime.ready(actor, sandboxId, requestId)
            : await services.runtime.prompt(actor, sandboxId, { requestId, text: string(body.text) });
        return Response.json(result, { status: result.state === "pending" ? 202 : 200, headers });
      }
      if (operation === "job")
        return Response.json(await services.sandboxes.job(actor, sandboxId, requestId), { headers });
      const result =
        operation === "stop"
          ? await services.sandboxes.stop(actor, sandboxId, requestId)
          : await services.sandboxes.delete(actor, sandboxId, requestId);
      return Response.json(result, { status: 202, headers });
    } catch (error) {
      const denied =
        error instanceof DockerSandboxDenied ||
        error instanceof DockerHostDenied ||
        error instanceof DockerBootstrapDenied ||
        error instanceof DockerRuntimeDenied;
      return Response.json(
        { error: denied ? "docker_sandbox_denied" : "docker_sandbox_unavailable" },
        {
          status: denied
            ? 403
            : error instanceof BodyTooLargeError
              ? 413
              : error instanceof InvalidInput || error instanceof SyntaxError
                ? 400
                : 503,
          headers,
        },
      );
    }
  };
}
