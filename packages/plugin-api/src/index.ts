import type { NodeProvider, RuntimeProvider } from "./runtime.js";

export type {
  LaunchRequest,
  NodeProvider,
  PrepareRequest,
  RuntimeProvider,
  WorkerObservation,
  WorkerRef,
  Workspace,
} from "./runtime.js";

import { z } from "zod";

/** Independent of Armada releases and of the daemon/app wire protocol. */
export const PLUGIN_API_VERSION = "0.2.0";
export const SEAMS = ["runtime", "tracker", "forge", "node", "model"] as const;
export type Seam = (typeof SEAMS)[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonSchema = boolean | { [key: string]: Json };

const name = z.string().regex(/^[a-z][a-z0-9._-]*$/, "must be a lowercase plugin or contribution name");
const contributionSchema = z.strictObject({
  description: z.string().optional(),
  config: z.union([z.boolean(), z.record(z.string(), z.json())]),
  secrets: z.array(z.string().min(1)).refine((names) => new Set(names).size === names.length, "duplicate secret name"),
});
const kinds = z.record(name, contributionSchema).optional();
export const manifestSchema = z.strictObject({
  id: name,
  version: z.string().min(1),
  pluginApi: z.string().min(1),
  enabledByDefault: z.boolean(),
  description: z.string().min(1),
  contributions: z.strictObject({ runtime: kinds, tracker: kinds, forge: kinds, node: kinds, model: kinds }),
});
export type PluginManifest = z.infer<typeof manifestSchema>;
export const pluginSettingSchema = z.strictObject({
  id: name,
  enabled: z.boolean().optional(),
  config: z.partialRecord(z.enum(SEAMS), z.record(name, z.json())).default({}),
});
export type PluginSetting = z.infer<typeof pluginSettingSchema>;
export type PluginConfig = Partial<Record<Seam, Record<string, Json>>>;

export const pluginEventSchema = z.object({
  seq: z.number().int().positive(),
  project: z.string().min(1),
  kind: z.string().min(1),
  at: z.string().min(1),
  actor: z.string().min(1),
  payload: z.json(),
});

export const pluginEventInputSchema = pluginEventSchema.omit({ seq: true });
export type PluginEventInput = z.infer<typeof pluginEventInputSchema>;
export type PluginEvent = z.infer<typeof pluginEventSchema>;
export interface PluginEvents {
  append(event: PluginEventInput): Promise<PluginEvent>;
  read(project: string, after: number): Promise<PluginEvent[]>;
  /** Snapshot vocabulary belongs to the event log; callers narrow the result. */
  fold(project: string): Promise<unknown>;
}
export interface PluginLog {
  info(message: string): void;
  error(message: string): void;
}
export interface ProjectRequest {
  project: string;
  signal?: AbortSignal;
}
/** Readers append observations through ctx.events; daemon owns polling/checkpoints. */
export interface TrackerProvider {
  read(request: ProjectRequest): Promise<void>;
  write(request: ProjectRequest & { ticket: string; phase?: string; comment?: string }): Promise<void>;
}
export interface ForgeProvider {
  read(request: ProjectRequest): Promise<void>;
  merge(request: ProjectRequest & { number: number; head: string }): Promise<{ merged: boolean }>;
}
/** Model is the consumer's AI SDK model type; the API has no SDK runtime dependency. */
export interface ModelProvider<Model = unknown> {
  create(model: string): Model;
}
export interface Providers {
  runtime: RuntimeProvider;
  tracker: TrackerProvider;
  forge: ForgeProvider;
  node: NodeProvider;
  model: ModelProvider;
}
export type PluginRegister = { [S in Seam]: (kind: string, provider: Providers[S]) => void };
export interface PluginContext {
  events: PluginEvents;
  secrets: { get(name: string): Promise<string | null> };
  /** Validated config, keyed by seam then contribution kind. Missing values become {}. */
  config: PluginConfig;
  log: PluginLog;
  register: PluginRegister;
}
export interface ArmadaPlugin {
  activate(ctx: PluginContext): void | Promise<void>;
}
