import { z } from "zod";

export const modelKindSchema = z.string().regex(/^[a-z][a-z0-9._-]*$/);
/** Public connection settings only. Credentials travel in the dedicated key field. */
export const modelConfigSchema = z.strictObject({
  model: z.string().min(1).max(200).optional(),
  baseURL: z
    .url()
    .regex(/^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/)
    .optional(),
  apiKeySecret: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .nullable()
    .optional(),
  apiKeyHeader: z.enum(["authorization", "api-key"]).optional(),
  supportsStructuredOutputs: z.boolean().optional(),
});
export const coordinatorModelSchema = z.object({ kind: modelKindSchema, config: modelConfigSchema });
export type CoordinatorModel = z.infer<typeof coordinatorModelSchema>;
export const modelKindEntrySchema = z.object({ kind: modelKindSchema, description: z.string(), config: z.json() });
export type ModelKindEntry = z.infer<typeof modelKindEntrySchema>;
