import { capabilities } from "@armada/core/machine-capabilities";
import type { ProviderTarget } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import type { Caller } from "./caller.ts";
import { modalDialoutPlacement } from "./provider-runtime-admission.ts";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions, type RuntimeLaunchPolicy } from "./runtime-launch.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";
import { type RuntimeResumeOptions, runtimeResumePlacement } from "./runtime-resume-placement.ts";

/** Modal owns retained compute only; common resume owns epoch, checkpoint and native session proof. */
export function modalRuntimeResume(
  options: RuntimeResumeOptions & {
    hostFor(target: ProviderTarget, caller: Caller): Promise<ModalProvider>;
  },
) {
  return runtimeResumePlacement(options, {
    host: (caller, sandbox) => options.hostFor(sandbox, caller),
    retained(current) {
      if (current.state !== "stopped") throw Error("modal_resume_requires_retained_stop");
    },
    admissionError: "modal_resume_admission_changed",
    binding: ["modal", "dialout"],
    maxTtlSeconds: capabilities("modal").maxTtlSeconds,
    restore: (host, sandbox, ttlSeconds, signal, checkpoint, observe) => {
      if (sandbox.lifecycleGeneration === undefined) throw Error("modal_resume_generation_required");
      return host.resumeRuntime(
        {
          sandboxId: sandbox.providerSandboxId,
          ttlSeconds,
          generation: sandbox.lifecycleGeneration,
          checkpoint: { epoch: checkpoint.epoch, watermark: checkpoint.watermark },
        },
        signal,
        observe,
      );
    },
    stop: (host, sandbox) => host.stop({ sandboxId: sandbox.providerSandboxId }),
  });
}

export function createModalResumePolicy(
  options: RuntimeLaunchOptions & {
    modelAuth?: NonNullable<RuntimeConfigurationInput["modelAuth"]>;
  },
) {
  const startRuntime = createRuntimeLaunch(options, "modal", modalDialoutPlacement);
  return {
    supportsScopedAccess: true,
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      const resumeGeneration = input.restoreCheckpoint ? sandbox.lifecycleGeneration : undefined;
      return startRuntime({
        input,
        configure: () =>
          runtimeConfigurationWithVariables(
            options.sql,
            { ...options, actor, sandbox, credentials },
            "modal",
            "modal_runtime_empty_v1",
          ),
        async commandGrantDeadline(logicalExpiresAt) {
          const physical = await host.get(sandbox.providerSandboxId, { signal: input.signal });
          input.signal.throwIfAborted();
          const expiresAt = physical.expiresAt?.getTime();
          if (
            physical.providerState !== "active" ||
            !["ready", "running"].includes(physical.state) ||
            physical.physicalExitConfirmed ||
            expiresAt === undefined ||
            !Number.isFinite(expiresAt) ||
            expiresAt < logicalExpiresAt
          )
            throw Error("modal_runtime_physical_deadline_unavailable");
          return expiresAt;
        },
        bootstrap: () => {
          const start = (host as Partial<ModalProvider>).startRuntime;
          if (!start) throw Error("modal_runtime_host_required");
          return (request) =>
            start.call(host, {
              ...request,
              ...(resumeGeneration === undefined ? {} : { resumeGeneration }),
            });
        },
      });
    },
  } satisfies RuntimeLaunchPolicy;
}
