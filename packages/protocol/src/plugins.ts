import { z } from "zod";
import { identifier, versionSchema as version } from "./envelope.js";

// The Plugins screen's messages (minor 2, THE-2019). Kept apart from the fleet's
// vocabulary; index.ts adds them to its unions. Envelope primitives live apart to avoid cycles.
const request = { version, id: identifier };

/** A declared secret: its name and whether the daemon's keychain holds it. Never its value. */
export const pluginSecretSchema = z.object({ name: identifier, set: z.boolean() });
/** One contribution: its seam and kind, its config's JSON Schema and the saved config. */
export const pluginContributionSchema = z.object({
  seam: identifier,
  kind: identifier,
  description: z.string().optional(),
  schema: z.union([z.boolean(), z.record(z.string(), z.json())]),
  config: z.json(),
  secrets: z.array(pluginSecretSchema),
});
/**
 * A bundled plugin: `enabled` is the saved switch, `loaded`/`error` what this
 * daemon's boot did, `restartRequired` when the saved switch or config differs from it.
 */
export const pluginSchema = z.object({
  id: identifier,
  version: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  loaded: z.boolean(),
  error: z.string().optional(),
  restartRequired: z.boolean(),
  contributions: z.array(pluginContributionSchema),
});
export type Plugin = z.infer<typeof pluginSchema>;
export type PluginContribution = z.infer<typeof pluginContributionSchema>;

export const pluginsListRequestSchema = z.object({ ...request, type: z.literal("plugins.list") });
export const pluginsEnableRequestSchema = z.object({
  ...request,
  type: z.literal("plugins.enable"),
  plugin: identifier,
});
export const pluginsDisableRequestSchema = z.object({
  ...request,
  type: z.literal("plugins.disable"),
  plugin: identifier,
});
export const pluginsConfigureRequestSchema = z.object({
  ...request,
  type: z.literal("plugins.configure"),
  plugin: identifier,
  seam: identifier,
  kind: identifier,
  config: z.json(),
});
/** Like `credentials.set`: one explicit submit, a value that never comes back. */
export const pluginsSecretRequestSchema = z.object({
  ...request,
  type: z.literal("plugins.secret"),
  plugin: identifier,
  name: identifier,
  value: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[!-~]+$/),
});
export const daemonRestartRequestSchema = z.object({ ...request, type: z.literal("daemon.restart") });

/** Every plugins request is answered with the whole list, as saved now. */
export const pluginsResultSchema = z.object({
  ...request,
  type: z.literal("plugins.result"),
  plugins: z.array(pluginSchema),
  /** Whether `daemon.restart` can restart this daemon (the desktop shell supervises it). */
  restartable: z.boolean(),
});
/** Sent before the daemon closes to restart; the app reconnects once it is back. */
export const daemonRestartingSchema = z.object({ ...request, type: z.literal("daemon.restarting") });

export const pluginRequestSchemas = [
  pluginsListRequestSchema,
  pluginsEnableRequestSchema,
  pluginsDisableRequestSchema,
  pluginsConfigureRequestSchema,
  pluginsSecretRequestSchema,
  daemonRestartRequestSchema,
] as const;
export const pluginResultSchemas = [pluginsResultSchema, daemonRestartingSchema] as const;
export type PluginsResult = z.infer<typeof pluginsResultSchema>;
export type PluginRequest = z.infer<(typeof pluginRequestSchemas)[number]>;
