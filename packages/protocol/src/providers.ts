import { z } from "zod";
import { versionSchema } from "./envelope.js";

export const PROVIDERS_MINOR = 10;
const text = z.string().min(1).max(4096);
const id = z.string().min(1).max(200);
const envelope = { version: versionSchema, id };
export const providerSchema = z.strictObject({
  id,
  seam: z.enum(["agent", "tracker", "forge", "model", "node"]),
  name: text,
  mark: id,
  version: z.string().optional(),
  state: z.enum(["connected", "disconnected", "missing"]),
  account: z.strictObject({ label: text, plan: text.optional() }).optional(),
  detail: z.string().optional(),
  enabled: z.boolean(),
  config: z.strictObject({ binary: text.optional(), routing: z.json().optional() }),
  restartRequired: z.boolean(),
});
export type Provider = z.infer<typeof providerSchema>;
export const providersListSchema = z.object({ ...envelope, type: z.literal("providers.list") });
// `id` is the existing correlation envelope. `provider` disambiguates it; a bare
// providers.connect/disconnect { id: "codex" } also addresses that provider.
export const providersConnectSchema = z.object({
  ...envelope,
  type: z.literal("providers.connect"),
  provider: id.optional(),
});
export const providersDisconnectSchema = z.object({
  ...envelope,
  type: z.literal("providers.disconnect"),
  provider: id.optional(),
});
export const providersAnswerSchema = z.object({
  ...envelope,
  type: z.literal("providers.answer"),
  flow: id.optional(),
  promptId: id.optional(),
  value: z.string().max(16384),
});
export const providersCancelSchema = z.object({
  ...envelope,
  type: z.literal("providers.cancel"),
  flow: id.optional(),
});
export const providersCatalogSchema = z.object({
  ...envelope,
  type: z.literal("providers.catalog"),
  providers: z.array(providerSchema),
});
export const providerRequestSchemas = [
  providersListSchema,
  providersConnectSchema,
  providersDisconnectSchema,
  providersAnswerSchema,
  providersCancelSchema,
] as const;
export type ProvidersRequest = z.infer<(typeof providerRequestSchemas)[number]>;
export type ProvidersCatalog = z.infer<typeof providersCatalogSchema>;
