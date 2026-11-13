import type { Route } from "./http.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied, type RuntimeSessionScope } from "./runtime-enrolment.ts";

const bootstrap = new Set(["bootstrap_started", "artifact_verified", "bootstrap_failed"]);
const runtime = new Set(["enrolled", "harness_started", "runtime_failed"]);
/** Only fixed stage names and authenticated identities; never request/exception text. */
export function logRuntimeStage(scope: RuntimeSessionScope, stage: string) {
  try {
    console.info(
      JSON.stringify({ event: "armada.runtime.stage", sandboxId: scope.sandboxId, epoch: scope.epoch, stage }),
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
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join() !== "stage")
        throw Error();
      const stage = (body as { stage: unknown }).stage;
      if (typeof stage !== "string" || (!bootstrap.has(stage) && !runtime.has(stage))) throw Error();
      const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
      const scope = await (bootstrap.has(stage)
        ? authority.withBootstrap(token, async (tx, scope) => {
            if (stage === "bootstrap_failed")
              await tx.query(
                "update public.sandboxes set status='failed',status_reason='Armada runtime bootstrap failed.' where id=$1",
                [scope.sandboxId],
              );
            return scope;
          })
        : authority.withSession(token, request.headers.get("x-armada-runtime-epoch") ?? "", async (tx, scope) => {
            if (stage === "runtime_failed")
              await tx.query(
                "update public.sandboxes set status='failed',status_reason='Armada runtime process failed.' where id=$1",
                [scope.sandboxId],
              );
            return scope;
          }));
      logRuntimeStage(scope, stage);
      return Response.json({ accepted: true, epoch: scope.epoch }, { headers });
    } catch (error) {
      return Response.json(
        { error: "runtime_progress_refused" },
        { status: error instanceof RuntimeEnrolmentDenied ? 401 : 400, headers },
      );
    }
  };
}
