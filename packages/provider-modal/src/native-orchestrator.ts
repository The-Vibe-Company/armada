import type { Provider } from "@armada/core";
import { refusal } from "./errors.ts";
import type { createNativeLifecycle } from "./native-lifecycle.ts";
import type { RunnerTransport } from "./ports.ts";

type NativeOrchestratorDependencies = Pick<ReturnType<typeof createNativeLifecycle>, "admit" | "healthyAdmission"> & {
  runner: RunnerTransport;
};

export function createNativeOrchestratorOperations({
  admit,
  healthyAdmission,
  runner,
}: NativeOrchestratorDependencies) {
  return {
    async installOrchestratorEpoch({ sandboxId, token, binding, url }) {
      return admit(sandboxId, async (row, save) => {
        if (row.golden || row.phase !== "active" || binding.physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Orchestrator authority requires the bound active physical generation.");
        const active = await healthyAdmission(row, save);
        if (binding.physicalGeneration !== String(active.generation))
          throw refusal("conflict", "Physical generation changed during authority admission.");
        const result = await runner.call<{ acknowledged?: unknown }>(active, "installOrchestratorEpoch", {
          token,
          binding,
          url,
        });
        if (result?.acknowledged !== true)
          throw refusal("unavailable", "Private runner did not acknowledge authority delivery.");
        return { acknowledged: true };
      });
    },
    async observeOrchestrator({ sandboxId, physicalGeneration, conversationId }) {
      return admit(sandboxId, async (row) => {
        if (row.golden || row.phase !== "active" || physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Observation requires the bound active native generation.");
        const observed = await runner.call<{
          physicalGeneration: string;
          state: "active" | "quiescent" | "unknown";
          evidence: string;
          eventWatermark: number;
          acknowledgedSequence: number;
          nativeSessionId: string | null;
        }>(row, "observeOrchestrator", { ...(conversationId === undefined ? {} : { conversationId }) });
        if (
          observed?.physicalGeneration !== physicalGeneration ||
          !["active", "quiescent", "unknown"].includes(observed.state) ||
          typeof observed.evidence !== "string" ||
          !/^[a-f0-9]{64}$/.test(observed.evidence) ||
          !Number.isSafeInteger(observed.eventWatermark) ||
          observed.eventWatermark < 0 ||
          !Number.isSafeInteger(observed.acknowledgedSequence) ||
          observed.acknowledgedSequence < 0 ||
          observed.acknowledgedSequence > observed.eventWatermark ||
          (observed.nativeSessionId !== null && typeof observed.nativeSessionId !== "string")
        )
          throw refusal("unavailable", "Invalid native observation receipt.");
        return observed;
      });
    },
    async quiesceOrchestrator({ sandboxId, physicalGeneration }) {
      return admit(sandboxId, async (row, save) => {
        if (row.golden || row.phase !== "active" || physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Quiescence requires the bound active physical generation.");
        const active = await healthyAdmission(row, save);
        if (physicalGeneration !== String(active.generation))
          throw refusal("conflict", "Physical generation changed during quiescence.");
        await runner.call(active, "interrupt", {});
        return { acknowledged: true };
      });
    },
    async scrubOrchestratorEpoch({ sandboxId, physicalGeneration, tokenHash }) {
      return admit(sandboxId, async (row, save) => {
        if (row.golden || row.phase !== "active" || physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Orchestrator scrub requires the bound active physical generation.");
        const active = await healthyAdmission(row, save);
        if (physicalGeneration !== String(active.generation))
          throw refusal("conflict", "Physical generation changed during authority scrub.");
        const result = await runner.call<{ acknowledged?: unknown }>(active, "scrubOrchestratorEpoch", {
          ...(tokenHash === undefined ? {} : { tokenHash }),
        });
        if (result?.acknowledged !== true)
          throw refusal("unavailable", "Private runner did not acknowledge authority scrub.");
        return { acknowledged: true };
      });
    },
  } satisfies Required<
    Pick<
      Provider,
      "installOrchestratorEpoch" | "observeOrchestrator" | "quiesceOrchestrator" | "scrubOrchestratorEpoch"
    >
  >;
}
