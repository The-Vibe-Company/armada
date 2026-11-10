import type { OrchestratorDetail } from "@armada/core";
import type { Sql } from "@armada/core/server";
import { createOrchestratorBackendResolver } from "./orchestrator-backend-resolver.ts";
import { OrchestratorRuntime, type OrchestratorRuntimeOptions } from "./orchestrator-runtime.ts";
import type { OrchestratorRuntimeFoundation } from "./orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeStore, type RuntimeLifecycleHooks } from "./orchestrator-runtime-store.ts";

export interface OrchestratorWorkerLane {
  reconcileOne(signal?: AbortSignal): Promise<boolean>;
  drain(): Promise<void>;
}
/** Actual #663 callbacks, not duplicate lifecycle tables/admission decisions. Detail
 * is the published v2 projection; v1 did not export it. No native enablement default. */
export interface OrchestratorLifecyclePorts extends RuntimeLifecycleHooks {
  /** Assembly adapter for the actual v2 class method, not a new producer API. */
  ownerCompletion(
    sql: Sql,
    reserve: OrchestratorRuntimeFoundation["reserveOperation"],
  ): OrchestratorRuntimeStore["complete"];
  detail(
    sql: Sql,
  ): (
    ownerId: string,
    orgId: string,
    id: string,
  ) => Promise<Pick<OrchestratorDetail, "waits" | "delegation" | "childSandboxIds" | "usage">>;
  worker(sql: Sql, runtime: NonNullable<OrchestratorRuntime["lifecycleRuntime"]>): OrchestratorWorkerLane;
}
export function createOrchestratorServices(input: {
  sql: Sql;
  reserveOperation: OrchestratorRuntimeFoundation["reserveOperation"];
  options: Omit<OrchestratorRuntimeOptions, "store" | "lifecycleDetail" | "managed"> & {
    managed: Omit<NonNullable<OrchestratorRuntimeOptions["managed"]>, "sql">;
  };
  lifecycle: OrchestratorLifecyclePorts;
}) {
  const store = new OrchestratorRuntimeStore(input.sql, input.reserveOperation, {
    ...input.lifecycle,
    completeOwner: input.lifecycle.ownerCompletion(input.sql, input.reserveOperation),
  });
  const runtime = new OrchestratorRuntime({
    ...input.options,
    managed: { ...input.options.managed, sql: input.sql },
    store,
    lifecycleDetail: input.lifecycle.detail(input.sql),
  });
  if (!runtime.lifecycleRuntime) throw Error("Trusted managed runtime is required for orchestrator composition.");
  const lifecycle = input.lifecycle.worker(input.sql, runtime.lifecycleRuntime);
  return { runtime, store, lifecycle };
}

/** Production account/golden/provider selection, with the ACTUAL lifecycle-aware
 * resolver and native adapters supplied by server composition. No legacy allocator. */
export function createProductionOrchestratorServices(input: {
  selection: Parameters<typeof createOrchestratorBackendResolver>[0];
  authority: OrchestratorRuntimeOptions["authority"];
  reserveOperation: OrchestratorRuntimeFoundation["reserveOperation"];
  skillRevision: string;
  lifecycle: OrchestratorLifecyclePorts;
}) {
  const selection = createOrchestratorBackendResolver(input.selection);
  return createOrchestratorServices({
    sql: input.selection.sql,
    reserveOperation: input.reserveOperation,
    lifecycle: input.lifecycle,
    options: {
      authority: input.authority,
      skillRevision: input.skillRevision,
      resolveBackend: selection.resolveBackend,
      managed: { resolveManaged: selection.resolveManaged },
    },
  });
}
