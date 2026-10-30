import { z } from "zod";
import { coordinatorModelSchema } from "./models.js";

const id = z.string().min(1).max(200).regex(/\S/);
const target = { cli: z.enum(["claude", "codex", "opencode"]), model: id, effort: id.optional() };
const placement = z.enum(["local", "vm"]);
const minutes = z.number().positive();
// V1 policy numbers: positive finite minutes, positive safe worker quota or no cap.
export const projectRulesSchema = z.strictObject({
  gates: z
    .strictObject({
      requiredChecks: z.array(id).max(100),
      localCommands: z.array(z.string().min(1).max(4000).regex(/\S/)).max(50),
    })
    .optional(),
  coordinatorModel: coordinatorModelSchema.optional(),
  routing: z
    .array(
      z.union([
        z.strictObject({ labels: z.array(id).min(1).max(50), ...target }),
        z.strictObject({ when: z.string().min(1).max(4000).regex(/\S/), ...target }),
      ]),
    )
    .max(100)
    .optional(),
  defaultRoute: z.strictObject(target).nullable().optional(),
  placement: z.strictObject({ workers: placement, coordinator: placement }).optional(),
  policy: z
    .strictObject({
      silenceMinutes: minutes.optional(),
      quietMinutes: minutes.optional(),
      maxWorkers: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    })
    .optional(),
});
export type ProjectRules = z.infer<typeof projectRulesSchema>;
export const rulesStateSchema = z.strictObject({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  value: projectRulesSchema,
});
export type RulesState = z.infer<typeof rulesStateSchema>;

/** The native model tool uses this same contract as JSON Schema, without another hand-written copy. */
export function rulesJsonSchema() {
  return z.toJSONSchema(projectRulesSchema, { target: "draft-7" });
}
