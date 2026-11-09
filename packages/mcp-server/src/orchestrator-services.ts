import type { Sql } from "@armada/core/server";
import type { Route } from "./http.ts";
import { createOrchestratorChildren, type OrchestratorChildExecutor } from "./orchestrator-children.ts";
import { createOrchestratorLifecycle } from "./orchestrator-lifecycle.ts";
import type { ChildAuthority, OrchestratorLifecycleRuntime } from "./orchestrator-lifecycle-contract.ts";
import { createLifecycleAwareOrchestratorRuntime } from "./orchestrator-lifecycle-integration.ts";
import {
  createOrchestratorOwnerLifecycleRoute,
  type OwnerLifecycleAuthentication,
} from "./orchestrator-owner-lifecycle.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import { createOrchestratorScopedGateway, orchestratorScopedMcpUrl } from "./orchestrator-scoped-gateway.ts";
import { createOrchestratorWaits, type WaitEvidenceSource } from "./orchestrator-waits.ts";
import type { ServerLifecycleLane } from "./server-workers.ts";

/** Trusted Node composition only, never an HTTP/guest opt-in. Pairing is mandatory:
 * the live API must not be installed without both background reconciliation lanes.
 * There is deliberately no default native backend, broker, account resolver or fixture. */
export interface OrchestratorServiceBundle {
  runtime: OrchestratorRuntime;
  scopedToolsRoute: Route;
  ownerLifecycleRoute: (auth: OwnerLifecycleAuthentication) => Route;
  lifecycleWorker: ServerLifecycleLane;
  childWorker: ServerLifecycleLane;
}
export function createOrchestratorServices(
  sql: Sql,
  input: {
    scopedMcpUrl: string;
    runtime: Parameters<typeof createLifecycleAwareOrchestratorRuntime>[1];
    childAuthority: ChildAuthority;
    childExecutor: OrchestratorChildExecutor;
    lifecycleRuntime?: OrchestratorLifecycleRuntime;
    evidence: WaitEvidenceSource;
  },
) {
  if (input.scopedMcpUrl !== orchestratorScopedMcpUrl(input.scopedMcpUrl))
    throw new Error("Scoped gateway path must not target owner MCP.");
  const { runtime, store } = createLifecycleAwareOrchestratorRuntime(sql, {
    ...input.runtime,
    async resolveBackend(...args) {
      const backend = await input.runtime.resolveBackend(...args);
      if (backend.mcpUrl !== input.scopedMcpUrl)
        throw new Error("Scoped epoch gateway URL mismatch; owner MCP fallback denied.");
      return backend;
    },
  });
  const children = createOrchestratorChildren(sql, input.childAuthority, input.childExecutor);
  const waits = createOrchestratorWaits(sql, input.evidence);
  return {
    runtime,
    ownerLifecycleRoute: (auth: OwnerLifecycleAuthentication) =>
      createOrchestratorOwnerLifecycleRoute(sql, store, waits, auth),
    scopedToolsRoute: createOrchestratorScopedGateway(children),
    store,
    children,
    waits,
    lifecycleWorker: createOrchestratorLifecycle(sql, input.lifecycleRuntime ?? requiredManagedRuntime(runtime)),
    childWorker: children,
  };
}

function requiredManagedRuntime(runtime: OrchestratorRuntime): OrchestratorLifecycleRuntime {
  if (!runtime.lifecycleRuntime) throw new Error("Managed orchestrator lifecycle runtime required.");
  return runtime.lifecycleRuntime;
}
