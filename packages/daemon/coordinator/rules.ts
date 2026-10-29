import { type Static, Type } from "typebox";
import * as Value from "typebox/value";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const target = {
  cli: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("opencode")]),
  model: id,
  effort: Type.Optional(id),
};
const placement = Type.Union([Type.Literal("local"), Type.Literal("vm")]);
// Copied from core/src/config.ts: positive finite minutes, positive safe worker quota or no cap.
const minutes = Type.Number({ exclusiveMinimum: 0 });
export const rulesSchema = object({
  routing: Type.Optional(
    Type.Array(
      Type.Union([
        object({ labels: Type.Array(id, { minItems: 1, maxItems: 50 }), ...target }),
        object({ when: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }), ...target }),
      ]),
      { maxItems: 100 },
    ),
  ),
  defaultRoute: Type.Optional(Type.Union([object(target), Type.Null()])),
  placement: Type.Optional(object({ workers: placement, coordinator: placement })),
  policy: Type.Optional(
    object({
      silenceMinutes: Type.Optional(minutes),
      quietMinutes: Type.Optional(minutes),
      maxWorkers: Type.Optional(
        Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
      ),
    }),
  ),
});
export type ProjectRules = Static<typeof rulesSchema>;
export interface RulesState {
  revision: number;
  value: ProjectRules;
}
export const emptyRules = (): RulesState => ({ revision: 0, value: {} });
const stateSchema = object({
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  value: rulesSchema,
});

/** Fold the reserved native rules checkpoint; pi and other checkpoint formats remain independent.
 * Also reads the armada.tools v1 records written before rules joined the shared fleet fold.
 */
export function checkpointRules(checkpoint: unknown): RulesState | null {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const c = checkpoint as Record<string, unknown>;
  if (c.format !== "armada.tools") return null;
  if (c.version !== 1) throw new Error("Unsupported native tools checkpoint");
  if (c.type !== "rules" || !Value.Check(stateSchema, c.rules)) throw new Error("Invalid native tools checkpoint");
  return structuredClone(c.rules);
}
