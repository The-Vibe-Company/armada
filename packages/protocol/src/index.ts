import { pluginEventSchema } from "@armada/plugin-api";
import { z } from "zod";
import {
  accountDeviceSchema,
  accountLoginRequestSchema,
  accountLogoutRequestSchema,
  accountResultSchema,
  accountStatusRequestSchema,
} from "./account.js";
import { authRequestSchemas, authResultSchemas } from "./auth.js";
import {
  chatDeltaSchema,
  chatReadRequestSchema,
  chatResultSchema,
  chatSendRequestSchema,
  chatSentSchema,
  chatStoppedSchema,
  chatStopRequestSchema,
  chatToolSchema,
  chatTurnSchema,
  ownerAnsweredSchema,
  ownerAnswerRequestSchema,
} from "./chat.js";
import { DELIVERIES_MINOR } from "./deliveries.js";
import { counter, identifier, requestSchema, USAGE_MINOR, versionSchema } from "./envelope.js";
import { FOLLOW_UP_MINOR, GITHUB_READER_MINOR, INTERNAL_TRACKER_MINOR } from "./fleet.js";
import {
  MODEL_SCOPE_MINOR,
  modelConfigSchema,
  modelKindEntrySchema,
  modelKindSchema,
  modelsCatalogSchema,
  modelsRequestSchemas,
} from "./models.js";
import { pluginRequestSchemas, pluginResultSchemas } from "./plugins.js";
import {
  PROJECT_TRACKER_MINOR,
  PROJECTS_MINOR,
  projectRequestSchemas,
  projectSchema,
  projectsInspectionSchema,
} from "./projects.js";
import { providerRequestSchemas, providersCatalogSchema } from "./providers.js";
import { READER_MINOR, roomPresenceRequestSchema } from "./readers.js";
import { BRIEF_INSTRUCTIONS_MINOR, WATCHDOG_MINOR } from "./rules.js";
import {
  sessionOutputRequestSchema,
  sessionOutputResultSchema,
  sessionReleaseRequestSchema,
  sessionReleaseResultSchema,
} from "./session.js";

export * from "./account.js";
export * from "./auth.js";
export * from "./chat.js";
export * from "./fleet.js";
export * from "./models.js";
export * from "./plugins.js";
export * from "./projects.js";
export * from "./providers.js";
export * from "./readers.js";
export * from "./rules.js";
export * from "./session.js";

/** Snapshot-first subscriptions and bounded event replay. */
export const REPLAY_MINOR = 21;

/** Wire version, independent of the daemon/app release versions. */
export const WORKER_RECOVERY_MINOR = 15;
export const PROTOCOL_VERSION = {
  major: 1,
  minor: Math.max(
    READER_MINOR,
    PROJECTS_MINOR,
    BRIEF_INSTRUCTIONS_MINOR,
    WORKER_RECOVERY_MINOR,
    GITHUB_READER_MINOR,
    DELIVERIES_MINOR,
    WATCHDOG_MINOR,
    USAGE_MINOR,
    REPLAY_MINOR,
    INTERNAL_TRACKER_MINOR,
    FOLLOW_UP_MINOR,
    PROJECT_TRACKER_MINOR,
    MODEL_SCOPE_MINOR,
  ),
} as const;
export const APP_TOO_OLD = "Armada app is older than the daemon: update it";
export const DAEMON_TOO_OLD = "Armada daemon is older than the app: update it";

export { versionSchema } from "./envelope.js";
export type ProtocolVersion = z.infer<typeof versionSchema>;

/** Forward-compatible envelope: known kinds and payloads are defined in fleet.ts. */
export const eventSchema = pluginEventSchema;
export type ProtocolEvent = z.infer<typeof eventSchema>;

const request = { version: versionSchema, id: identifier };
export const listProjectsRequestSchema = /* @__PURE__ */ requestSchema("projects.list", {});
export const subscribeRequestSchema = /* @__PURE__ */ requestSchema("project.subscribe", {
  project: identifier,
  after: counter,
});
export const readSessionRequestSchema = /* @__PURE__ */ requestSchema("session.read", {
  project: identifier,
  sessionId: identifier,
});
/** Exclusive cursor before which older rows are returned, newest first. */
export const historyRequestSchema = /* @__PURE__ */ (() =>
  requestSchema("fleet.history", {
    project: identifier,
    ticket: identifier.optional(),
    cursor: counter.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }))();
export type HistoryRequest = z.infer<typeof historyRequestSchema>;
export const modelProviderSchema = modelKindSchema;
export const credentialsStatusRequestSchema = /* @__PURE__ */ requestSchema("credentials.status", {});
function credentialsSetSchema() {
  return z.object({
    ...request,
    type: z.literal("credentials.set"),
    provider: modelProviderSchema,
    /** Built-in pi is the modern default; plugins and older clients keep their namespace. */
    target: z.enum(["pi", "plugin"]).optional(),
    config: modelConfigSchema.optional(),
    key: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[!-~]+$/),
  });
}
// The app receives replies; request validators are only used by the daemon.
export const credentialsSetRequestSchema = /* @__PURE__ */ credentialsSetSchema();
export const credentialsResultSchema = z.object({
  ...request,
  type: z.literal("credentials.result"),
  provider: modelProviderSchema.nullable(),
  config: modelConfigSchema.optional(),
  models: z.array(modelKindEntrySchema).optional(),
  needsRepair: z.boolean().optional(),
  storage: z.enum(["os-keychain", "file"]),
});
export const fleetShutdownRequestSchema = /* @__PURE__ */ fleetShutdownRequest();
function fleetShutdownRequest() {
  return requestSchema("fleet.shutdown", {
    project: identifier,
    reason: z.string().trim().min(1).max(4000),
  });
}
export const fleetShutdownResultSchema = z.object({
  ...request,
  type: z.literal("fleet.shutdown.result"),
  project: identifier,
  ok: z.boolean(),
  released: z.array(identifier),
  failed: z.array(identifier),
});
export const clientMessageSchema = /* @__PURE__ */ z.discriminatedUnion("type", [
  fleetShutdownRequestSchema,
  accountStatusRequestSchema,
  accountLoginRequestSchema,
  accountLogoutRequestSchema,
  credentialsStatusRequestSchema,
  credentialsSetRequestSchema,
  listProjectsRequestSchema,
  subscribeRequestSchema,
  roomPresenceRequestSchema,
  readSessionRequestSchema,
  historyRequestSchema,
  chatReadRequestSchema,
  chatSendRequestSchema,
  chatStopRequestSchema,
  ownerAnswerRequestSchema,
  sessionReleaseRequestSchema,
  sessionOutputRequestSchema,
  ...pluginRequestSchemas,
  ...projectRequestSchemas,
  ...authRequestSchemas,
  ...modelsRequestSchemas,
  ...providerRequestSchemas,
]);
export type CredentialsResult = z.infer<typeof credentialsResultSchema>;
export type ListProjectsRequest = z.infer<typeof listProjectsRequestSchema>;
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;
export type ReadSessionRequest = z.infer<typeof readSessionRequestSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const projectsResultSchema = z.object({
  ...request,
  type: z.literal("projects.result"),
  projects: z.array(projectSchema),
});
/** A project's folded state at the inclusive cursor `seq`; readers may consume a subset. */
const snapshotSchema = z.object({ seq: counter, state: z.json() });
export const subscribedSchema = z.object({
  ...request,
  type: z.literal("project.subscribed"),
  subscriptionId: identifier,
  project: identifier,
  after: counter,
  /** Initial folded project state; omitted on replay. */
  snapshot: snapshotSchema.optional(),
});

const history = { project: identifier, seq: counter, events: z.array(eventSchema) };
function checkHistory(value: z.infer<z.ZodObject<typeof history>>, ctx: z.RefinementCtx): void {
  let previous = 0;
  for (const [index, event] of value.events.entries()) {
    if (event.project !== value.project) {
      ctx.addIssue({ code: "custom", path: ["events", index, "project"], message: "Event belongs to another project" });
    }
    if (event.seq <= previous || event.seq > value.seq) {
      ctx.addIssue({
        code: "custom",
        path: ["events", index, "seq"],
        message: "Events must be strictly increasing and at or below the frame cursor",
      });
    }
    previous = event.seq;
  }
}

export const sessionResultSchema = z
  .object({ ...request, ...history, type: z.literal("session.result"), sessionId: identifier })
  .superRefine(checkHistory);
export const historyResultSchema = z.object({
  ...request,
  type: z.literal("fleet.history.result"),
  project: identifier,
  events: z.array(eventSchema),
  cursor: counter.nullable(),
});
export type HistoryResult = z.infer<typeof historyResultSchema>;
export const eventBatchSchema = z
  .object({
    version: versionSchema,
    ...history,
    type: z.literal("events"),
    subscriptionId: identifier,
    /** More pages follow; only the final page carries the authoritative snapshot. */
    more: z.boolean().optional(),
    /** The project's folded state after this frame's events; omitted on a frame without any. */
    snapshot: snapshotSchema.optional(),
  })
  .superRefine((value, ctx) => {
    checkHistory(value, ctx);
    if (value.snapshot && value.snapshot.seq !== value.seq)
      ctx.addIssue({ code: "custom", path: ["snapshot", "seq"], message: "A frame's snapshot is at its cursor" });
  });
export const errorSchema = z.object({
  version: versionSchema,
  type: z.literal("error"),
  id: identifier.optional(),
  code: z.enum([
    "invalid-message",
    "app-too-old",
    "daemon-too-old",
    "not-found",
    "internal",
    "expired",
    "denied",
    "offline",
  ]),
  message: identifier,
});
export const serverMessageSchema = z.discriminatedUnion("type", [
  fleetShutdownResultSchema,
  accountResultSchema,
  accountDeviceSchema,
  credentialsResultSchema,
  projectsResultSchema,
  subscribedSchema,
  sessionResultSchema,
  historyResultSchema,
  eventBatchSchema,
  errorSchema,
  chatResultSchema,
  chatSentSchema,
  chatStoppedSchema,
  chatTurnSchema,
  chatDeltaSchema,
  chatToolSchema,
  ownerAnsweredSchema,
  sessionReleaseResultSchema,
  sessionOutputResultSchema,
  ...pluginResultSchemas,
  projectsInspectionSchema,
  ...authResultSchemas,
  modelsCatalogSchema,
  providersCatalogSchema,
]);
export type ProjectsResult = z.infer<typeof projectsResultSchema>;
export type Subscribed = z.infer<typeof subscribedSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SessionResult = z.infer<typeof sessionResultSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
export type ProtocolError = z.infer<typeof errorSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type Admission = { ok: true; request: ClientMessage } | { ok: false; error: ProtocolError; close: boolean };

const envelopeSchema = z.object({ version: versionSchema });
const correlationSchema = z.object({ id: identifier });

/**
 * The daemon calls this before dispatching EVERY parsed JSON request. On failure,
 * send only `error`; if `close` is true, close the connection without dispatch.
 * Version is checked before the body, so an old shape still gets the upgrade line.
 */
export function admitRequest(input: unknown, daemonVersion: ProtocolVersion = PROTOCOL_VERSION): Admission {
  const version = versionSchema.parse(daemonVersion);
  const correlation = correlationSchema.safeParse(input);
  const base = { type: "error" as const, version, ...(correlation.success ? correlation.data : {}) };
  const envelope = envelopeSchema.safeParse(input);
  if (envelope.success) {
    const clientMajor = envelope.data.version.major;
    if (clientMajor !== version.major) {
      const older = clientMajor < version.major;
      return {
        ok: false,
        close: true,
        error: {
          ...base,
          code: older ? "app-too-old" : "daemon-too-old",
          message: older ? APP_TOO_OLD : DAEMON_TOO_OLD,
        },
      };
    }
  }
  const parsed = clientMessageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      close: false,
      error: { ...base, code: "invalid-message", message: "Invalid Armada protocol request" },
    };
  }
  if (
    ["projects.inspect", "projects.add", "projects.remove"].includes(parsed.data.type) &&
    (version.minor < PROJECTS_MINOR || parsed.data.version.minor < PROJECTS_MINOR)
  ) {
    return {
      ok: false,
      close: false,
      error: { ...base, code: "invalid-message", message: "Project management requires protocol minor 12" },
    };
  }
  if (
    parsed.data.type === "models.select" &&
    parsed.data.project !== undefined &&
    (version.minor < MODEL_SCOPE_MINOR || parsed.data.version.minor < MODEL_SCOPE_MINOR)
  )
    return {
      ok: false,
      close: false,
      error: { ...base, code: "invalid-message", message: "A project's coordinator model requires protocol minor 24" },
    };
  if (parsed.data.type === "fleet.shutdown" && parsed.data.version.minor < WORKER_RECOVERY_MINOR)
    return { ok: false, close: false, error: { ...base, code: "app-too-old", message: APP_TOO_OLD } };
  return { ok: true, request: parsed.data };
}

// Durable worker input deliveries (THE-2108).
export { DELIVERIES_MINOR, type Delivery } from "./deliveries.js";

// Token metering and budget usage (THE-2109). Keep additive exports separate.
export * from "./usage.js";
