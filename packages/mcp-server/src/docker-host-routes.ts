import { readBoundedText } from "@armada/auth";
import { DOCKER_JOB_FAILURE_REASONS, type DockerJobFailureReason } from "@armada/core";
import { dockerResourceLimits } from "../../core/src/docker-resources.ts";
import type { CallerResult } from "./caller.ts";
import { DockerLimitsRefused } from "./docker-capacity.ts";
import { type createDockerHostStore, DockerHostDenied } from "./docker-host-store.ts";
import type { DockerSnapshots } from "./docker-snapshots.ts";
import type { Route } from "./http.ts";

const machinePaths = [
  "/api/docker-host/register",
  "/api/docker-host/poll",
  "/api/docker-host/results",
  "/api/docker-host/unregister",
];
const reusePath = "/api/docker-host/reuse-registration";
const ownerPaths = [
  "/api/v1/docker/snapshots/list",
  "/api/v1/docker/snapshots/get",
  "/api/v1/docker/snapshots/create",
  "/api/v1/docker/snapshots/rebuild",
  "/api/v1/docker/hosts/list",
  "/api/v1/docker/hosts/limits",
  "/api/v1/docker/hosts/register-token",
  "/api/v1/docker/hosts/revoke",
];
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
  options: { placement?: boolean; publicUrl?: string; snapshots?: DockerSnapshots } = {},
): Route {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const owner = ownerPaths.includes(path);
    if (!owner && path !== reusePath && !machinePaths.includes(path)) return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    try {
      // Explicit bearer authority only, including dashboard server-side user sessions.
      if (request.headers.has("origin")) throw new InvalidInput();
      let actor: { userId: string; orgId: string } | undefined;
      if (owner) {
        const result = await authenticate(request);
        if (!result.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
        const body: unknown = JSON.parse(await readBoundedText(request, path.includes("/snapshots/") ? 1048576 : 4096));
        if (!object(body)) throw new InvalidInput();
        if (path.includes("/snapshots/")) {
          if (!options.snapshots) throw new InvalidInput();
          return Response.json(await options.snapshots.command(result.caller, path.split("/").at(-1) ?? "", body), {
            headers,
          });
        }
        fields(
          body,
          path.endsWith("/limits")
            ? ["org", "hostId", ...["cpus", "memoryBytes", "maxSandboxes", "auto"].filter((k) => k in body)]
            : path.endsWith("/revoke")
              ? ["org", "hostId"]
              : path.endsWith("/register-token") && "name" in body
                ? ["org", "name"]
                : ["org"],
        );
        const orgId = string(body.org);
        const listing = path.endsWith("/list");
        const limits = path.endsWith("/limits");
        if (
          !uuid.test(orgId) ||
          !result.caller.orgs.some((org) => org.orgId === orgId && (listing || limits || org.role === "admin"))
        )
          throw new DockerHostDenied();
        actor = { userId: result.caller.userId, orgId };
        if (limits) {
          const { org: _org, hostId, ...patch } = body;
          return Response.json(await store.setLimits(actor, string(hostId), patch), { headers });
        }
        if (listing)
          return Response.json({ placement: options.placement === true, hosts: await store.list(actor) }, { headers });
        if (path.endsWith("/register-token")) {
          const origin = new URL(options.publicUrl ?? request.url).origin;
          if (!origin.startsWith("https://")) throw new InvalidInput();
          const ticket = await store.issueRegistration(actor, "name" in body ? string(body.name) : undefined);
          const scriptUrl = `${origin}/install-host.sh`.replaceAll("'", "'\\''");
          const command = `curl -fsSL --proto '=https' --proto-redir '=https' '${scriptUrl}' | sh -s -- --token ${ticket.registrationToken}`;
          return Response.json({ ...ticket, command }, { headers });
        }
        await store.revoke(actor, string(body.hostId));
        return Response.json({ revoked: true }, { headers });
      }
      const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) throw new DockerHostDenied();
      const body: unknown = JSON.parse(await readBoundedText(request, 4096));
      if (!object(body)) throw new InvalidInput();
      // Registration-token capability, not user or installed-machine authority.
      if (path === reusePath) {
        fields(body, ["hostId"]);
        const hostId = string(body.hostId);
        if (!uuid.test(hostId)) throw new InvalidInput();
        return Response.json(await store.reuseRegistration(token, hostId), { headers });
      }
      fields(
        body,
        path.endsWith("/results")
          ? [
              "installationId",
              "requestId",
              ...("expired" in body ? ["expired"] : "reason" in body ? ["outcome", "reason"] : ["outcome"]),
              ...("imageId" in body ? ["imageId"] : []),
            ]
          : path.endsWith("/poll") && "version" in body
            ? [
                "installationId",
                "version",
                ...("resources" in body ? ["resources"] : []),
                ...("resourcePolicyVersion" in body ? ["resourcePolicyVersion"] : []),
                ...("skipSnapshots" in body ? ["skipSnapshots"] : []),
              ]
            : ["installationId"],
      );
      const installationId = string(body.installationId);
      if (path.endsWith("/register"))
        return Response.json(await store.exchangeRegistration(token, installationId), { headers });
      if (path.endsWith("/unregister")) {
        return Response.json({ revoked: await store.unregister(token, installationId) }, { headers });
      }
      if (path.endsWith("/poll")) {
        if (body.resources !== undefined) {
          if (!object(body.resources)) throw new InvalidInput();
          fields(body.resources, ["cpus", "memoryBytes"]);
          try {
            dockerResourceLimits(body.resources as { cpus: number; memoryBytes: number });
          } catch {
            throw new InvalidInput();
          }
        }
        if (body.resourcePolicyVersion !== undefined && body.resourcePolicyVersion !== 1) throw new InvalidInput();
        const version = body.version === undefined ? undefined : string(body.version);
        if (version !== undefined && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new InvalidInput();
        if (body.skipSnapshots !== undefined && body.skipSnapshots !== true) throw new InvalidInput();
        return Response.json(
          {
            job: await store.poll(
              token,
              installationId,
              version,
              body.skipSnapshots === true,
              body.resources as { cpus: number; memoryBytes: number } | undefined,
              body.resourcePolicyVersion as 1 | undefined,
            ),
            ...(body.resourcePolicyVersion === 1 ? { limits: await store.limitsForHost(token, installationId) } : {}),
          },
          { headers },
        );
      }
      if ("expired" in body) {
        if (body.expired !== true) throw new InvalidInput();
        const requestId = string(body.requestId);
        await store.expired(token, installationId, { requestId });
        return Response.json({ requestId }, { headers });
      }
      const outcome = string(body.outcome);
      if (outcome !== "completed" && outcome !== "failed") throw new InvalidInput();
      const requestId = string(body.requestId);
      // A reason explains a failure; it never accompanies a success.
      const reason = body.reason === undefined ? undefined : string(body.reason);
      if (
        reason !== undefined &&
        (outcome !== "failed" || !DOCKER_JOB_FAILURE_REASONS.includes(reason as DockerJobFailureReason))
      )
        throw new InvalidInput();
      await store.complete(token, installationId, {
        requestId,
        outcome,
        ...(reason === undefined ? {} : { reason: reason as DockerJobFailureReason }),
        ...("imageId" in body ? { imageId: string(body.imageId) } : {}),
      });
      return Response.json({ requestId }, { headers });
    } catch (error) {
      if (error instanceof DockerLimitsRefused)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.code === "invalid_request" ? 400 : 409, headers },
        );
      return Response.json(
        {
          error:
            error instanceof DockerHostDenied
              ? "docker_host_denied"
              : error instanceof Error && "code" in error
                ? "snapshot_request_refused"
                : "docker_host_unavailable",
        },
        {
          status:
            error instanceof DockerHostDenied
              ? owner
                ? 403
                : 401
              : error instanceof InvalidInput || error instanceof SyntaxError
                ? 400
                : error instanceof Error && "code" in error
                  ? ((
                      { invalid: 400, invalid_config: 400, forbidden: 403, not_found: 404, conflict: 409 } as Record<
                        string,
                        number
                      >
                    )[String(error.code)] ?? 503)
                  : 503,
          headers,
        },
      );
    }
  };
}
