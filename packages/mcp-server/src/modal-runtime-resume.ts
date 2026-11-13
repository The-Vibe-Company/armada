import { PROVIDER_LIMITS, type ProviderTarget } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import type { Caller } from "./caller.ts";
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
    maxTtlSeconds: PROVIDER_LIMITS.modal.maxTtlSeconds,
    restore: (host, sandbox, ttlSeconds, signal, checkpoint) =>
      host.resumeRuntime(
        {
          sandboxId: sandbox.providerSandboxId,
          ttlSeconds,
          checkpoint: { epoch: checkpoint.epoch, watermark: checkpoint.watermark },
        },
        signal,
      ),
    stop: (host, sandbox) => host.stop({ sandboxId: sandbox.providerSandboxId }),
  });
}
