import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** Spec 2/7's native vocabulary; native.ts supplies admitted project implementations. */
export const TOOL_NAMES = [
  "fleet.status",
  "inbox.list",
  "inbox.answer",
  "worker.launch",
  "worker.relaunch",
  "worker.message",
  "worker.stop",
  "merge.check",
  "merge.run",
  "hold.add",
  "hold.clear",
  "owner.ask",
  "rules.set",
] as const;
export type CoordinatorToolName = (typeof TOOL_NAMES)[number];
export type CoordinatorTools = Partial<Record<CoordinatorToolName, ToolRegistration>>;

/** A missing implementation is visible to the model as a structured refusal. Never silently succeed. */
export function coordinatorTools(implementations: CoordinatorTools = {}): ToolRegistration[] {
  return TOOL_NAMES.map((name) => {
    const implementation = implementations[name];
    if (implementation) {
      if (implementation.name !== name) throw new Error(`Tool registry name mismatch: ${name}`);
      // Single-writer lease decisions are serial even if a model emits several calls in one turn.
      return { ...implementation, executionMode: "sequential", replay: implementation.replay ?? "unsafe" };
    }
    return defineTool({
      name,
      description: "Unavailable until the project's native fleet tools are installed; returns a refusal.",
      parameters: Type.Object({}, { additionalProperties: true }),
      replay: "safe",
      executionMode: "sequential",
      async execute() {
        const refusal: JsonObject = {
          ok: false,
          code: "not_available_yet",
          message: "not available yet",
          next: "open the project's coordinator with its native tool scope",
          tool: name,
        };
        return { output: [{ type: "text", text: JSON.stringify(refusal) }], details: refusal, isError: true };
      },
    });
  });
}
