import type { Sql } from "@armada/core/server";
import { createOrchestratorChildren, type OrchestratorChildExecutor } from "./orchestrator-children.ts";
import { createOrchestratorLifecycle } from "./orchestrator-lifecycle.ts";
import type { ChildAuthority, OrchestratorLifecycleRuntime } from "./orchestrator-lifecycle-contract.ts";
import { createLifecycleAwareOrchestratorRuntime } from "./orchestrator-lifecycle-integration.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import { createOrchestratorWaits, type WaitEvidenceSource } from "./orchestrator-waits.ts";
import type { ServerLifecycleLane } from "./server-workers.ts";

/** Trusted Node composition only, never an HTTP/guest opt-in. Pairing is mandatory:
 * the live API must not be installed without both background reconciliation lanes.
 * There is deliberately no default native backend, broker, account resolver or fixture. */
export interface OrchestratorServiceBundle {
  runtime: OrchestratorRuntime;
  lifecycleWorker: ServerLifecycleLane;
  childWorker: ServerLifecycleLane;
}
export function createOrchestratorServices(
  sql: Sql,
  input: {
    runtime: Parameters<typeof createLifecycleAwareOrchestratorRuntime>[1];
    childAuthority: ChildAuthority;
    childExecutor: OrchestratorChildExecutor;
    lifecycleRuntime: OrchestratorLifecycleRuntime;
    evidence: WaitEvidenceSource;
  },
) {
  const { runtime, store } = createLifecycleAwareOrchestratorRuntime(sql, input.runtime);
  const children = createOrchestratorChildren(sql, input.childAuthority, input.childExecutor);
  return {
    runtime,
    store,
    children,
    waits: createOrchestratorWaits(sql, input.evidence),
    lifecycleWorker: createOrchestratorLifecycle(sql, input.lifecycleRuntime),
    childWorker: children,
  };
}
