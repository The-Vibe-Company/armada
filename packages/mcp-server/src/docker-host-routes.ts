import { readBoundedText } from "@armada/auth";
import {
  DOCKER_HOST_SNAPSHOT_BASELINE_HEADER,
  DOCKER_JOB_FAILURE_REASONS,
  type DockerJobFailureReason,
} from "@armada/core";
import { isSnapshotBaselineTool } from "@armada/core/server";
import { DOCKER_HOST_UPDATE_FAILURE_HEADER, stableDockerHostVersion } from "../../core/src/docker-host-upgrade.ts";
import { type DockerHostResources, validDockerAvailability } from "../../core/src/docker-resource-policy.ts";
import { dockerResourceLimits } from "../../core/src/docker-resources.ts";
import { VERSION } from "../../core/src/version.ts";
import type { CallerResult } from "./caller.ts";
import { DockerHostDraining, DockerLimitsRefused } from "./docker-capacity.ts";
import { type createDockerHostStore, DockerHostDenied } from "./docker-host-store.ts";
import { dockerHostVersions } from "./docker-host-version.ts";
import { DockerSnapshotHostUpgradeRequired, type DockerSnapshots } from "./docker-snapshots.ts";
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
  "/api/v1/docker/hosts/retention",
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
function snapshotBaselineHeader(request: Request): number | undefined {
  const header = request.headers.get(DOCKER_HOST_SNAPSHOT_BASELINE_HEADER);
  if (header === null) return undefined;
  const version = Number(header);
  if (!/^[1-9][0-9]{0,9}$/.test(header) || version > 2147483647) throw new InvalidInput();
  return version;
}
function deadlinesOf(value: unknown): { sandboxId: string; generation: string; deadline: string }[] {
  if (!Array.isArray(value) || value.length > 4096) throw new InvalidInput();
  return value.map((entry) => {
    if (!object(entry)) throw new InvalidInput();
    fields(entry, ["sandboxId", "generation", "deadline"]);
    const sandboxId = string(entry.sandboxId);
    const generation = string(entry.generation);
    const deadline = string(entry.deadline);
    if (!uuid.test(sandboxId) || !uuid.test(generation) || !Number.isFinite(Date.parse(deadline)))
      throw new InvalidInput();
    return { sandboxId, generation, deadline };
  });
}

/** Longest a daemon poll is held open waiting for work (#2561). */
export const DOCKER_HOST_POLL_HOLD_SECONDS = 20;
/** Most machine operations a daemon may report as still executing. */
export const DOCKER_HOST_MAX_RUNNING = 16;
export interface DockerHostPollClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
const pollClock: DockerHostPollClock = {
  now: () => Date.now(),
  async wait(ms, signal) {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  },
};

/** Mounted only by ARMADA_DOCKER_HOSTS=1. Machine authority never authenticates a user API. */
export function createDockerHostRoutes(
  store: ReturnType<typeof createDockerHostStore>,
  authenticate: (request: Request) => Promise<CallerResult>,
  options: { placement?: boolean; publicUrl?: string; snapshots?: DockerSnapshots; clock?: DockerHostPollClock } = {},
): Route {
  const clock = options.clock ?? pollClock;
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
          path.endsWith("/retention")
            ? ["org", "hostId", "retentionSeconds"]
            : path.endsWith("/limits")
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
        const retention = path.endsWith("/retention");
        if (
          !uuid.test(orgId) ||
          !result.caller.orgs.some(
            (org) => org.orgId === orgId && (listing || limits || retention || org.role === "admin"),
          )
        )
          throw new DockerHostDenied();
        actor = { userId: result.caller.userId, orgId };
        if (retention)
          return Response.json(await store.setRetention(actor, string(body.hostId), body.retentionSeconds as number), {
            headers,
          });
        if (limits) {
          const { org: _org, hostId, ...patch } = body;
          return Response.json(await store.setLimits(actor, string(hostId), patch), { headers });
        }
        if (listing)
          return Response.json(
            {
              ...dockerHostVersions,
              serverVersion: VERSION,
              placement: options.placement === true,
              hosts: await store.list(actor),
            },
            { headers },
          );
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
      // The poll carries the host's per-generation retention deadlines, so its
      // body grows with the number of retained sandboxes; other machine calls
      // stay small. Bound it well above a full host's deadline list.
      const body: unknown = JSON.parse(await readBoundedText(request, path.endsWith("/poll") ? 1048576 : 4096));
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
              ...("claimed" in body
                ? ["claimed"]
                : "cleaned" in body
                  ? ["cleaned", ...("cleanupReason" in body ? ["cleanupReason"] : [])]
                  : "expired" in body
                    ? ["expired"]
                    : "reason" in body
                      ? ["outcome", "reason"]
                      : ["outcome"]),
              ...("imageId" in body ? ["imageId"] : []),
              ...("baselineVersion" in body ? ["baselineVersion"] : []),
              ...("baselineTool" in body ? ["baselineTool"] : []),
              ...("missingRefIndex" in body ? ["missingRefIndex"] : []),
            ]
          : path.endsWith("/poll") && "version" in body
            ? [
                "installationId",
                "version",
                ...("resumeClaimProtocol" in body ? ["resumeClaimProtocol"] : []),
                ...("resources" in body ? ["resources"] : []),
                ...("resourcePolicyVersion" in body ? ["resourcePolicyVersion"] : []),
                ...("skipSnapshots" in body ? ["skipSnapshots"] : []),
                ...("retentionSeconds" in body ? ["retentionSeconds", "nextCleanupAt"] : []),
                ...("deadlines" in body ? ["deadlines"] : []),
                ...("diskFreeBytes" in body ? ["diskFreeBytes"] : []),
                ...("stoppedSandboxBytes" in body ? ["stoppedSandboxBytes"] : []),
                ...("waitSeconds" in body ? ["waitSeconds"] : []),
                ...("running" in body ? ["running"] : []),
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
          fields(body.resources, [
            "cpus",
            "memoryBytes",
            ...("availableCpus" in body.resources ? ["availableCpus", "availableMemoryBytes"] : []),
          ]);
          if (!validDockerAvailability(body.resources as DockerHostResources)) throw new InvalidInput();
          try {
            dockerResourceLimits(body.resources as { cpus: number; memoryBytes: number });
          } catch {
            throw new InvalidInput();
          }
        }
        if (body.resourcePolicyVersion !== undefined && body.resourcePolicyVersion !== 1) throw new InvalidInput();
        const baseline = snapshotBaselineHeader(request);
        const version = body.version === undefined ? undefined : string(body.version);
        if (version !== undefined && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new InvalidInput();
        if (body.skipSnapshots !== undefined && body.skipSnapshots !== true) throw new InvalidInput();
        if (
          "retentionSeconds" in body &&
          (!Number.isInteger(body.retentionSeconds) ||
            Number(body.retentionSeconds) < 0 ||
            Number(body.retentionSeconds) > 31536000 ||
            !(
              body.nextCleanupAt === null ||
              (typeof body.nextCleanupAt === "string" && Number.isFinite(Date.parse(body.nextCleanupAt)))
            ))
        )
          throw new InvalidInput();
        if (
          body.stoppedSandboxBytes !== undefined &&
          body.stoppedSandboxBytes !== null &&
          (!Number.isSafeInteger(body.stoppedSandboxBytes) || Number(body.stoppedSandboxBytes) < 0)
        )
          throw new InvalidInput();
        if (
          body.diskFreeBytes !== undefined &&
          body.diskFreeBytes !== null &&
          (!Number.isSafeInteger(body.diskFreeBytes) || Number(body.diskFreeBytes) < 0)
        )
          throw new InvalidInput();
        // Deadlines are the per-generation detail of the retention report; they
        // are meaningless without the policy they belong to.
        if ("deadlines" in body && !("retentionSeconds" in body)) throw new InvalidInput();
        const deadlines = "deadlines" in body ? deadlinesOf(body.deadlines) : undefined;
        // A daemon may opt into a held poll: the response waits until a job or an
        // unacknowledged resume claim exists, so a launch never waits out the
        // daemon's idle period, and the host still needs no inbound port (#2561).
        // Validated before any write, as a daemon retries a refused poll without them.
        const wait = body.waitSeconds;
        if (wait !== undefined && (!Number.isSafeInteger(wait) || Number(wait) < 1)) throw new InvalidInput();
        const holdUntil = clock.now() + Math.min(Number(wait ?? 0), DOCKER_HOST_POLL_HOLD_SECONDS) * 1000;
        // Machine operations the daemon is still executing. Their sandboxes stay
        // serial; jobs of other sandboxes are handed out while they run.
        const running = body.running;
        if (
          running !== undefined &&
          (!Array.isArray(running) ||
            running.length > DOCKER_HOST_MAX_RUNNING ||
            running.some((item) => typeof item !== "string" || !uuid.test(item)))
        )
          throw new InvalidInput();
        const retentionSeconds = await store.retentionForHost(
          token,
          installationId,
          "retentionSeconds" in body
            ? {
                retentionSeconds: body.retentionSeconds as number,
                nextCleanupAt: body.nextCleanupAt as string | null,
                ...(deadlines === undefined ? {} : { deadlines }),
              }
            : undefined,
        );
        let resumeClaims: Awaited<ReturnType<typeof store.resumeClaimsForHost>>;
        let job: Awaited<ReturnType<typeof store.poll>>;
        const skipSnapshots = body.skipSnapshots === true;
        const runningIds = (running as string[] | undefined) ?? [];
        let probed = false;
        for (;;) {
          resumeClaims = body.resumeClaimProtocol === 1 ? await store.resumeClaimsForHost(token, installationId) : [];
          job = await store.poll(
            token,
            installationId,
            version,
            skipSnapshots,
            body.resources as DockerHostResources | undefined,
            body.resourcePolicyVersion as 1 | undefined,
            body.diskFreeBytes as number | null | undefined,
            body.stoppedSandboxBytes as number | null | undefined,
            runningIds,
            baseline,
          );
          if (job || resumeClaims.length) break;
          // The probe is broader than the poll (admission refusals, job order). A
          // probe the full poll could not serve is not retried within this hold,
          // so such a job costs one more full poll per hold, not one per second.
          if (probed) {
            const remaining = holdUntil - clock.now();
            if (remaining > 0) await clock.wait(remaining, request.signal);
            break;
          }
          // Recheck every second with a read-only probe; the full poll above
          // (host reconciliation, heartbeat and claim writes) runs again only
          // when something may be ready, not once a second per idle host.
          let ready = false;
          while (!ready) {
            const remaining = holdUntil - clock.now();
            if (remaining <= 0 || request.signal.aborted) break;
            await clock.wait(Math.min(1000, remaining), request.signal);
            if (request.signal.aborted) break;
            ready = await store.mayHaveWork(
              token,
              installationId,
              skipSnapshots,
              runningIds,
              body.resumeClaimProtocol === 1,
            );
          }
          if (!ready) break;
          probed = true;
        }
        const failedUpdate = request.headers.get(DOCKER_HOST_UPDATE_FAILURE_HEADER);
        if (stableDockerHostVersion(failedUpdate)) {
          console.warn(
            JSON.stringify({ event: "docker_host_update_failed", installationId, targetVersion: failedUpdate }),
          );
        }
        return Response.json(
          {
            ...(retentionSeconds === undefined ? {} : { retentionSeconds }),
            ...(wait === undefined ? {} : { held: true }),
            minimumVersion: dockerHostVersions.minimumVersion,
            ...((await store.canOfferUpdate(token, installationId))
              ? { targetVersion: dockerHostVersions.targetVersion }
              : {}),
            resumeClaims,
            job,
            // Every generation with a queued resume/bootstrap, so the daemon
            // fences all of them, not only the single job it was handed.
            pendingStarts: await store.pendingStartsForHost(token, installationId),
            ...(body.resourcePolicyVersion === 1 ? { limits: await store.limitsForHost(token, installationId) } : {}),
          },
          {
            headers: {
              ...headers,
              ...(stableDockerHostVersion(failedUpdate) ? { [DOCKER_HOST_UPDATE_FAILURE_HEADER]: failedUpdate } : {}),
            },
          },
        );
      }
      if ("claimed" in body) {
        if (typeof body.claimed !== "boolean") throw new InvalidInput();
        const requestId = string(body.requestId);
        await store.claimResume(token, installationId, requestId, body.claimed);
        return Response.json({ requestId }, { headers });
      }
      if ("cleaned" in body) {
        if (body.cleaned !== true) throw new InvalidInput();
        const requestId = string(body.requestId);
        if (
          body.cleanupReason !== undefined &&
          body.cleanupReason !== "retention_elapsed" &&
          body.cleanupReason !== "disk_pressure"
        )
          throw new InvalidInput();
        await store.cleaned(token, installationId, {
          requestId,
          ...(body.cleanupReason === undefined ? {} : { cleanupReason: body.cleanupReason }),
        });
        return Response.json({ requestId }, { headers });
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
      const baselineTool = body.baselineTool;
      if ("baselineTool" in body && (reason !== "snapshot_build_failed" || !isSnapshotBaselineTool(baselineTool)))
        throw new InvalidInput();
      const missingRefIndex = body.missingRefIndex;
      if (
        "missingRefIndex" in body &&
        (reason !== "snapshot_build_failed" ||
          "baselineTool" in body ||
          typeof missingRefIndex !== "number" ||
          !Number.isInteger(missingRefIndex) ||
          missingRefIndex < 1 ||
          missingRefIndex > 16)
      )
        throw new InvalidInput();
      const baselineHeader = snapshotBaselineHeader(request);
      const baselineVersion = "baselineVersion" in body ? body.baselineVersion : baselineHeader;
      if (
        baselineVersion !== undefined &&
        (outcome !== "completed" ||
          typeof baselineVersion !== "number" ||
          !Number.isSafeInteger(baselineVersion) ||
          baselineVersion < 1 ||
          baselineVersion > 2147483647 ||
          (baselineHeader !== undefined && baselineHeader !== baselineVersion))
      )
        throw new InvalidInput();
      await store.complete(token, installationId, {
        requestId,
        outcome,
        ...(reason === undefined ? {} : { reason: reason as DockerJobFailureReason }),
        ...("imageId" in body ? { imageId: string(body.imageId) } : {}),
        ...(typeof baselineVersion === "number" ? { baselineVersion } : {}),
        ...(isSnapshotBaselineTool(baselineTool) ? { baselineTool } : {}),
        ...(typeof missingRefIndex === "number" ? { missingRefIndex } : {}),
      });
      return Response.json({ requestId }, { headers });
    } catch (error) {
      if (error instanceof DockerLimitsRefused)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.code === "invalid_request" ? 400 : 409, headers },
        );
      // A drain is a typed state refusal so the dashboard can show the uninstall reason, not a generic conflict.
      if (error instanceof DockerHostDraining || error instanceof DockerSnapshotHostUpgradeRequired)
        return Response.json({ error: { code: error.code, message: error.message } }, { status: 409, headers });
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
