import type { Provider } from "@armada/core";
import { preserveWork, type WorkPreservation } from "@armada/core/server";
import type { Sandbox } from "modal";
import { abortable } from "./client.ts";
import { modalError, refusal } from "./errors.ts";
import { executeWorkspaceCommand } from "./golden-exec.ts";
import type { Machine, ModalStore } from "./ports.ts";
import { quiesceSandboxProcesses } from "./process-scope.ts";

export type ModalRuntimeCapture = (input: {
  sandboxId: string;
  physicalGeneration: string;
  signal: AbortSignal;
  context: NonNullable<Parameters<Provider["exec"]>[0]["preservationContext"]>;
  onWorkAtRisk?: () => void;
}) => Promise<WorkPreservation>;

export function createRuntimeCapture(
  store: ModalStore,
  physical: (row: Machine, signal?: AbortSignal) => Promise<Sandbox>,
) {
  const capture: ModalRuntimeCapture = async ({ sandboxId, physicalGeneration, signal, context, onWorkAtRisk }) => {
    try {
      signal.throwIfAborted();
      const row = await store.get(sandboxId);
      if (
        !row.commonRuntime ||
        row.golden ||
        row.phase !== "active" ||
        !row.physicalId ||
        String(row.generation) !== physicalGeneration
      )
        throw refusal("sandbox_not_ready", "Work capture requires the exact active common runtime incarnation.");
      const sandbox = await physical(row, signal);
      signal.throwIfAborted();
      if ((await abortable(sandbox.poll(), signal)) !== null)
        throw refusal("sandbox_not_ready", "Work capture requires live physical compute.");
      signal.throwIfAborted();
      await abortable(quiesceSandboxProcesses(sandbox, row, signal), signal);
      signal.throwIfAborted();
      return await preserveWork(
        {
          exec(request) {
            request.signal?.throwIfAborted();
            return abortable(executeWorkspaceCommand(sandbox, request), request.signal);
          },
        },
        sandboxId,
        signal,
        onWorkAtRisk,
        context,
      );
    } catch (error) {
      throw modalError(error);
    }
  };
  return capture;
}
