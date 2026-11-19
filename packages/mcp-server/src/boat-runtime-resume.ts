import { PROVIDER_LIMITS, resolveBoatKey } from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
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
      return createObservedBoatProvider({ apiKey: management.key }, sandbox.id);
    },
    retained(current) {
      if (current.state !== "stopped" || current.physicalExitConfirmed)
        throw Error("runtime_resume_requires_stopped_compute");
      if (current.retainedSnapshot !== "usable") throw new BoatRetentionUnconfirmed();
    },
    admissionError: "runtime_resume_admission_changed",
    maxTtlSeconds: PROVIDER_LIMITS.boat.maxTtlSeconds,
    restore: (host, sandbox, ttl, signal, _checkpoint, observe) =>
      host.resumeRuntime(sandbox.providerSandboxId, ttl, signal, observe),
    stop: (host, sandbox) => host.stopBestEffort(sandbox.providerSandboxId),
  });
}
