import type { LaunchStage } from "@armada/core";
import { isRuntimeOperatorDiagnostic } from "../../core/src/runtime-operator-diagnostic.ts";
import {
  isRuntimeHarnessFailureStage,
  isRuntimeStartupFailure,
  RUNTIME_STARTUP_FAILURES,
} from "../../core/src/runtime-startup-failure.ts";
import type { Route } from "./http.ts";
import { recordLaunchStage } from "./launch-stage-record.ts";
import { recordOperatorDiagnostic } from "./request-observability.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied, type RuntimeSessionScope } from "./runtime-enrolment.ts";
import { runtimeHttpFailure } from "./runtime-http-failure.ts";

const bootstrap = new Set(["bootstrap_started", "artifact_verified", "bootstrap_failed"]);
const runtime = new Set(["enrolled", "harness_started", "runtime_failed"]);
/**
 * Reported progress persisted as launch stages (#2560); failures stay in sandbox status. A bootstrap report runs
 * inside the machine, so it is also the earliest machine-start evidence where the server observed none before (a
 * Docker resume is restored by the host after its ticket is issued). harness_started is not readiness: only Codex
 * reports it, when its first prompt starts the app-server; readiness is recorded where the launch publishes.
 */
const launchStages: Record<string, readonly LaunchStage[]> = {
  bootstrap_started: ["machine_started", "bootstrap_started"],
  enrolled: ["enrolled"],
};
/** Only fixed stage names and authenticated identities; never request/exception text. */
export function logRuntimeStage(scope: RuntimeSessionScope, stage: string, reason?: string) {
  try {
    console.info(
      JSON.stringify({
        event: "armada.runtime.stage",
        sandboxId: scope.sandboxId,
        epoch: scope.epoch,
        stage,
        ...(reason ? { reason } : {}),
      }),
    );
  } catch {
    /* Diagnostics cannot change accepted work. */
  }
}

export function createRuntimeProgress(authority: ReturnType<typeof createRuntimeEnrolments>): Route {
  return async (request) => {
    if (new URL(request.url).pathname !== "/api/runtime/progress") return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    try {
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (!request.body) throw Error();
      for await (const chunk of request.body) {
        size += chunk.byteLength;
        if (size > 1024) throw Error();
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["stage", "reason", "diagnostic", "commandId"].includes(key))
      )
        throw Error();
      const stage = (body as { stage: unknown }).stage;
      const harnessFailure = isRuntimeHarnessFailureStage(stage);
      if (typeof stage !== "string" || (!bootstrap.has(stage) && !runtime.has(stage) && !harnessFailure)) throw Error();
      const diagnostic = (body as { diagnostic?: unknown }).diagnostic;
      if (
        diagnostic !== undefined &&
        ((!harnessFailure && stage !== "runtime_failed") || !isRuntimeOperatorDiagnostic(diagnostic))
      )
        throw Error();
      const commandId = (body as { commandId?: unknown }).commandId;
      if (harnessFailure) {
        if (diagnostic === undefined || typeof commandId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(commandId))
          throw Error();
      } else if (commandId !== undefined) throw Error();
      const correlation = async (tx: import("@armada/core/server").Sql, scope: RuntimeSessionScope) => {
        const result = harnessFailure
          ? await tx.query<{ correlation_id: string | null }>(
              "select correlation_id from public.runtime_commands where sandbox_id=$1 and epoch=$2 and request_id=$3",
              [scope.sandboxId, scope.epoch, commandId],
            )
          : await tx.query<{ correlation_id: string | null }>(
              "select correlation_id from public.runtime_enrolments where sandbox_id=$1",
              [scope.sandboxId],
            );
        if (harnessFailure && !result.rows.length) throw Error();
        return result.rows[0]?.correlation_id ?? null;
      };
      const reason = (body as { reason?: unknown }).reason;
      if (reason !== undefined && (stage !== "runtime_failed" || !isRuntimeStartupFailure(reason))) throw Error();
      const message = isRuntimeStartupFailure(reason)
        ? RUNTIME_STARTUP_FAILURES[reason]
        : "Armada runtime process failed. Ask the server operator to inspect runtime startup before launching again.";
      const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
      const { scope, correlationId } = await (bootstrap.has(stage)
        ? authority.withBootstrap(token, async (tx, scope) => {
            for (const launch of launchStages[stage] ?? []) await recordLaunchStage(tx, scope.sandboxId, launch);
            if (stage === "bootstrap_failed")
              await tx.query(
                "update public.sandboxes set status='failed',status_reason='Armada runtime bootstrap failed.' where id=$1",
                [scope.sandboxId],
              );
            return { scope, correlationId: stage === "bootstrap_failed" ? await correlation(tx, scope) : null };
          })
        : authority.withSession(token, request.headers.get("x-armada-runtime-epoch") ?? "", async (tx, scope) => {
            for (const launch of launchStages[stage] ?? []) await recordLaunchStage(tx, scope.sandboxId, launch);
            const correlationId = stage === "runtime_failed" || harnessFailure ? await correlation(tx, scope) : null;
            if (stage === "runtime_failed")
              await tx.query("update public.sandboxes set status='failed',status_reason=$2 where id=$1", [
                scope.sandboxId,
                message,
              ]);
            return { scope, correlationId };
          }));
      if (stage === "runtime_failed" || stage === "bootstrap_failed" || harnessFailure) {
        const safe = isRuntimeOperatorDiagnostic(diagnostic) ? diagnostic : undefined;
        recordOperatorDiagnostic(
          stage === "runtime_failed" ? "runtime.boot" : `runtime.${stage}`,
          {
            errorClass: safe?.errorClass ?? "Error",
            message: stage === "runtime_failed" && isRuntimeStartupFailure(reason) ? reason : (safe?.reason ?? stage),
            stack: safe?.stack ?? [],
          },
          { sandboxId: scope.sandboxId, correlationId },
        );
      }
      logRuntimeStage(scope, stage, typeof reason === "string" ? reason : undefined);
      return Response.json({ accepted: true, epoch: scope.epoch }, { headers });
    } catch (error) {
      return runtimeHttpFailure(error instanceof RuntimeEnrolmentDenied ? 401 : 400, "runtime_progress_refused");
    }
  };
}
