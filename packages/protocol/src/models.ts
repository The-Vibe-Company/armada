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
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const pluginCoordinatorModelSchema = z.object({ kind: modelKindSchema, config: modelConfigSchema });
export const piCoordinatorModelSchema = z.object({ provider: modelKindSchema, model: z.string().min(1).max(200) });
export const coordinatorModelSchema = z.union([piCoordinatorModelSchema, pluginCoordinatorModelSchema]);
export type CoordinatorModel = z.infer<typeof coordinatorModelSchema>;
export const modelKindEntrySchema = z.object({ kind: modelKindSchema, description: z.string(), config: z.json() });
export type ModelKindEntry = z.infer<typeof modelKindEntrySchema>;

export const MODELS_MINOR = 9;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const request = { version: z.object({ major: counter, minor: counter }), id: z.string().min(1).max(200) };
export const modelProviderEntrySchema = z.object({
  id: modelKindSchema,
  name: z.string(),
  auth: z.object({ oauth: z.boolean(), apiKey: z.boolean(), envVars: z.array(z.string()) }),
  status: z.enum(["signed-in", "key-set", "env", "unconfigured"]),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reasoning: z.boolean(),
      contextWindow: z.number(),
      inputCost: z.number(),
      outputCost: z.number(),
    }),
  ),
});
export const modelsProvidersSchema = z.object({ ...request, type: z.literal("models.providers") });
/** The login request id is its flow id, known before the first auth frame arrives. */
export const modelsLoginSchema = z.object({
  ...request,
  type: z.literal("models.login"),
  provider: modelKindSchema,
  authType: z.enum(["oauth", "api_key"]),
});
export const modelsLogoutSchema = z.object({ ...request, type: z.literal("models.logout"), provider: modelKindSchema });
export const modelsSelectSchema = z.object({
  ...request,
  type: z.literal("models.select"),
  ...piCoordinatorModelSchema.shape,
});
export const modelsCatalogSchema = z.object({
  ...request,
  type: z.literal("models.catalog"),
  providers: z.array(modelProviderEntrySchema),
  selected: coordinatorModelSchema.nullable(),
});
export const modelsRequestSchemas = [
  modelsProvidersSchema,
  modelsLoginSchema,
  modelsLogoutSchema,
  modelsSelectSchema,
] as const;
export type ModelsCatalog = z.infer<typeof modelsCatalogSchema>;
