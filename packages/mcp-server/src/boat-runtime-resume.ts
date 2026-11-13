import { PROVIDER_LIMITS, resolveBoatKey } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { type RuntimeResumeOptions, runtimeResumePlacement } from "./runtime-resume-placement.ts";

/** Compute activation is isolated from legacy native harness/GitHub/MCP hooks. */
export function boatRuntimeResume(options: RuntimeResumeOptions & { modelAuth: ModelAuthOwnership }) {
  return runtimeResumePlacement(options, {
    async host(caller, sandbox) {
      const management = await resolveBoatKey(options.vault, options.key, {
        userId: caller.userId,
        orgId: sandbox.orgId,
        visibility: sandbox.sourceGoldenVisibility ?? sandbox.visibility ?? "private",
      });
      return createBoatProvider({ apiKey: management.key });
    },
    retained(current) {
      if (current.state !== "stopped" || current.physicalExitConfirmed)
        throw Error("runtime_resume_requires_stopped_compute");
    },
    admissionError: "runtime_resume_admission_changed",
    maxTtlSeconds: PROVIDER_LIMITS.boat.maxTtlSeconds,
    restore: (host, sandbox, ttl, signal) => host.resumeRuntime(sandbox.providerSandboxId, ttl, signal),
    stop: (host, sandbox) => host.stopBestEffort(sandbox.providerSandboxId),
  });
}
