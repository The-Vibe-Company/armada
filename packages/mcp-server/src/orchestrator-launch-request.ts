import type { OrchestratorCreate } from "@armada/core";
import type { LaunchRequest } from "@armada/core/server";

/** Public orchestrator selectors are authoritative. The real launcher resolves its
 * merged machine-size policy; no guessed default size or legacy allocator fallback.
 * In particular, backend convenience defaults cannot invent a repo/size override. */
export function orchestratorParentLaunchRequest(
  configuration: OrchestratorCreate,
  request: LaunchRequest,
): LaunchRequest {
  const { size: _backendSize, repo: _backendRepo, ...base } = request;
  return {
    ...base,
    ...(configuration.size === undefined ? {} : { size: configuration.size }),
    ...(configuration.repo === undefined ? {} : { repo: configuration.repo }),
  };
}
