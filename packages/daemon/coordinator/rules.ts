import { type ProjectRules, type RulesState, rulesJsonSchema, rulesStateSchema } from "@armada/protocol";
import { Type } from "typebox";

export type { ProjectRules, RulesState } from "@armada/protocol";
export const rulesSchema = Type.Unsafe<ProjectRules>(rulesJsonSchema());
export const emptyRules = (): RulesState => ({ revision: 0, value: {} });

/** Read the reserved native rules checkpoint, including records predating the shared fleet fold. */
export function checkpointRules(checkpoint: unknown): RulesState | null {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const c = checkpoint as Record<string, unknown>;
  if (c.format !== "armada.tools") return null;
  if (c.version !== 1) throw new Error("Unsupported native tools checkpoint");
  const state = rulesStateSchema.safeParse(c.rules);
  if (c.type !== "rules" || !state.success || state.data.revision < 1)
    throw new Error("Invalid native tools checkpoint");
  return state.data;
}
