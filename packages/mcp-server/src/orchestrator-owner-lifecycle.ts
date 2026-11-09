import type { AuthStore } from "@armada/auth";
import type { Sql } from "@armada/core/server";
import { z } from "zod";
import { AuthUnavailable, authenticateCaller, type SupabaseProject } from "./caller.ts";
import type { Route } from "./http.ts";
import { InvalidOrchestratorBody, readOrchestratorBody } from "./orchestrator-http-body.ts";
import { OrchestratorLifecycleError } from "./orchestrator-lifecycle-contract.ts";
import type { LifecycleRuntimeStore } from "./orchestrator-lifecycle-integration.ts";
import { lifecycleDetail } from "./orchestrator-lifecycle-integration.ts";
import { configureOrchestratorLifecycle } from "./orchestrator-lifecycle-settings.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";
import type { createOrchestratorWaits } from "./orchestrator-waits.ts";

export interface OwnerLifecycleAuthentication {
  authStore: AuthStore;
  supabase: SupabaseProject;
}
const key = z.string().regex(/^[ -~]{1,128}$/);
const fence = z.number().int().nonnegative().safe();
const settings = z
  .object({
    orgId: z.uuid(),
    expectedRevision: fence,
    idleSeconds: z.number().int().min(900).max(86400),
    maxActiveChildren: z.number().int().positive().safe().nullable(),
  })
  .strict();
const wait = z
  .object({
    orgId: z.uuid(),
    expectedRevision: fence,
    kind: z.enum(["child", "task", "ci", "external"]),
    reference: z.string().min(1).max(512),
    reason: z.string().min(1).max(512),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const renewal = z
  .object({ orgId: z.uuid(), expectedRevision: fence, expiresAt: z.iso.datetime({ offset: true }) })
  .strict();
const release = z.object({ orgId: z.uuid(), expectedRevision: fence }).strict();
const fail = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status, headers: { "cache-control": "no-store" } });
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** Owner namespace only. Every ownerId comes from real bearer verification and fresh SQL;
 * an epoch cannot be converted into Caller or invoke this surface, even with matching IDs. */
export function createOrchestratorOwnerLifecycleRoute(
  sql: Sql,
  store: LifecycleRuntimeStore,
  waits: ReturnType<typeof createOrchestratorWaits>,
  auth: OwnerLifecycleAuthentication,
): Route {
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/api\/v1\/orchestrators\/([^/]+)\/(settings|waits)(?:\/([^/]+)\/(renew|release))?$/.exec(
      url.pathname,
    );
    if (!match) return null;
    if (/^Bearer\s+armada_epoch_/i.test(request.headers.get("authorization") ?? ""))
      return fail(401, "owner_authentication_required");
    try {
      const identity = await authenticateCaller(request.headers.get("authorization"), {
        store: auth.authStore,
        supabase: auth.supabase,
        now: new Date(),
      });
      if (!identity.ok) return fail(401, "owner_authentication_required");
      const id = z.uuid().parse(match[1]);
      const resource = match[2];
      const waitId = match[3];
      const action = match[4];
      if ((resource === "settings" && (waitId || action)) || (request.method !== "GET" && request.method !== "POST"))
        return fail(405, "invalid_lifecycle_method");
      let input: Record<string, unknown>;
      if (request.method === "GET") {
        if (waitId || action || [...url.searchParams.keys()].some((k) => k !== "orgId"))
          return fail(400, "invalid_request");
        input = { orgId: z.uuid().parse(url.searchParams.get("orgId")) };
      } else {
        const decoded: unknown = JSON.parse(await readOrchestratorBody(request));
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return fail(400, "invalid_request");
        input = decoded as Record<string, unknown>;
      }
      const orgId = z.uuid().parse(input.orgId);
      const caller = identity.caller;
      if (!caller.orgs.some((o) => o.orgId === orgId)) return fail(404, "not_found");
      const parent = await store.read(caller.userId, orgId, id); // Fresh owner/member SQL; no provider activation.
      if (request.method === "GET")
        return resource === "settings"
          ? reply({
              version: 1,
              orchestratorId: id,
              revision: parent.revision,
              idleSeconds: parent.configuration.idleSeconds ?? 7200,
              maxActiveChildren: parent.configuration.maxActiveChildren ?? null,
              idleDeadline: parent.idleDeadline,
            })
          : reply({
              version: 1,
              orchestratorId: id,
              waits: (await lifecycleDetail(sql)(caller.userId, orgId, id)).waits,
            });
      const idempotencyKey = key.parse(request.headers.get("idempotency-key"));
      if (resource === "settings") {
        const selected = settings.parse(input);
        await configureOrchestratorLifecycle(sql, {
          key: idempotencyKey,
          orchestratorId: id,
          ownerId: caller.userId,
          expectedRevision: selected.expectedRevision,
          idleSeconds: selected.idleSeconds,
          maxActiveChildren: selected.maxActiveChildren,
        });
        const current = await store.read(caller.userId, orgId, id);
        return reply({
          version: 1,
          orchestratorId: id,
          revision: current.revision,
          idleSeconds: current.configuration.idleSeconds,
          maxActiveChildren: current.configuration.maxActiveChildren ?? null,
        });
      }
      if (parent.generation === null) return fail(409, "machine_identity_unavailable");
      let selected: z.infer<typeof wait>;
      let leaseAction: { id: string; action: "renew" | "release" } | undefined;
      if (waitId) {
        const leaseId = z.uuid().parse(waitId);
        const lease = (
          await sql.query<{ kind: z.infer<typeof wait>["kind"]; reference: string; reason: string }>(
            "select kind,reference,reason from orchestrator_waits where id=$1 and orchestrator_id=$2",
            [leaseId, id],
          )
        ).rows[0];
        if (!lease) return fail(404, "not_found");
        if (action === "renew") {
          const parsed = renewal.parse(input);
          selected = { ...parsed, ...lease };
          leaseAction = { id: leaseId, action: "renew" };
        } else {
          const parsed = release.parse(input);
          selected = { ...parsed, ...lease, expiresAt: new Date().toISOString() };
          leaseAction = { id: leaseId, action: "release" };
        }
      } else selected = wait.parse(input);
      const result = await waits.record({
        key: idempotencyKey,
        orchestratorId: id,
        ownerId: caller.userId,
        expectedRevision: selected.expectedRevision,
        generation: String(parent.generation),
        kind: selected.kind,
        reference: selected.reference,
        reason: selected.reason,
        ...(action === "release" ? {} : { expiresAt: selected.expiresAt }),
        ...(leaseAction ? { leaseAction } : {}),
      });
      return reply({ version: 1, orchestratorId: id, ...result }, action === "release" ? 200 : 201);
    } catch (error) {
      if (error instanceof AuthUnavailable) return fail(503, "authentication_unavailable");
      if (error instanceof z.ZodError || error instanceof InvalidOrchestratorBody || error instanceof SyntaxError)
        return fail(400, "invalid_request");
      if (error instanceof OrchestratorLifecycleError || error instanceof OrchestratorRuntimeError) {
        const code = error.code;
        return fail(
          code === "not_found" ? 404 : code === "conflict" ? 409 : code === "invalid_request" ? 400 : 503,
          code,
        );
      }
      return fail(503, "lifecycle_unavailable");
    }
  };
}
