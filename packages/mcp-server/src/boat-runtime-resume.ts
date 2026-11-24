import { capabilities } from "@armada/core/machine-capabilities";
import { resolveBoatKey, SANDBOX_STOP_MARGIN_SECONDS } from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
import { BoatResumeActivationUncertain } from "./runtime-resume.ts";
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
    maxTtlSeconds: capabilities("boat").maxTtlSeconds,
    async restore(host, sandbox, ttl, signal, _checkpoint, observe) {
      try {
        await host.resumeRuntime(sandbox.providerSandboxId, ttl, signal, observe);
      } catch (error) {
        throw new BoatResumeActivationUncertain(error);
      }
    },
    async verifyRestoredCoverage(host, sandbox, signal) {
      const info = await host.get(sandbox.providerSandboxId, { signal });
      const observedAt = new Date().toISOString();
      const physicalDeadline = info.expiresAt?.getTime() ?? Number.NaN;
      const requiredDeadline = Date.parse(sandbox.expiresAt ?? "") + SANDBOX_STOP_MARGIN_SECONDS * 1000;
      if (
        info.id !== sandbox.providerSandboxId ||
        (info.state !== "ready" && info.state !== "running") ||
        info.physicalExitConfirmed ||
        !Number.isFinite(physicalDeadline) ||
        !Number.isFinite(requiredDeadline)
      )
        throw Error("boat_runtime_resume_deadline_unconfirmed");
      if (physicalDeadline < requiredDeadline) throw Error("boat_runtime_resume_deadline_short");
      return async (tx) => {
        const saved = await tx.query(
          `insert into public.boat_runtime_extension_state
             (sandbox_id,observed_provider_id,observed_generation,observed_at,observed_expires_at)
           select s.id,s.provider_sandbox_id,s.lifecycle_generation,$4::timestamptz,$5::timestamptz
           from public.sandboxes s
           where s.id=$1 and s.boat_runtime and s.provider_sandbox_id=$2 and s.lifecycle_generation=$3
             and $5::timestamptz >= s.expires_at + $6::integer * interval '1 second'
           on conflict (sandbox_id) do update set
             observed_provider_id=excluded.observed_provider_id, observed_generation=excluded.observed_generation,
             observed_at=excluded.observed_at, observed_expires_at=excluded.observed_expires_at
           returning sandbox_id`,
          [
            sandbox.id,
            info.id,
            sandbox.lifecycleGeneration,
            observedAt,
            new Date(physicalDeadline).toISOString(),
            SANDBOX_STOP_MARGIN_SECONDS,
          ],
        );
        if (!saved.rows.length) throw Error("boat_runtime_resume_coverage_changed");
      };
    },
    stop: (host, sandbox) => host.stopBestEffort(sandbox.providerSandboxId),
  });
}
