import { z } from "zod";
import {
  chatReadRequestSchema,
  chatResultSchema,
  chatSendRequestSchema,
  chatSentSchema,
  ownerAnsweredSchema,
  ownerAnswerRequestSchema,
} from "./chat.js";

export * from "./chat.js";
export * from "./fleet.js";
export * from "./rules.js";

/** Wire version, independent of the daemon/app release versions. */
export const PROTOCOL_VERSION = { major: 1, minor: 2 } as const;
export const APP_TOO_OLD = "Armada app is older than the daemon: update it";
export const DAEMON_TOO_OLD = "Armada daemon is older than the app: update it";

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1);
export const versionSchema = z.object({ major: counter, minor: counter });
export type ProtocolVersion = z.infer<typeof versionSchema>;

export const projectSchema = z.object({
  id: identifier,
  name: identifier,
  repository: identifier,
});
export type Project = z.infer<typeof projectSchema>;

/** Forward-compatible envelope: known kinds and payloads are defined in fleet.ts. */
export const eventSchema = z.object({
  seq: counter.min(1),
  project: identifier,
  kind: identifier,
  at: z.iso.datetime({ offset: true }),
  actor: identifier,
  payload: z.json(),
});
export type ProtocolEvent = z.infer<typeof eventSchema>;

const request = { version: versionSchema, id: identifier };
export const listProjectsRequestSchema = z.object({ ...request, type: z.literal("projects.list") });
export const subscribeRequestSchema = z.object({
  ...request,
  type: z.literal("project.subscribe"),
  project: identifier,
  after: counter,
});
export const readSessionRequestSchema = z.object({
  ...request,
  type: z.literal("session.read"),
  project: identifier,
  sessionId: identifier,
});
export const modelProviderSchema = z.enum(["anthropic", "openai"]);
export const credentialsStatusRequestSchema = z.object({ ...request, type: z.literal("credentials.status") });
export const credentialsSetRequestSchema = z.object({
  ...request,
  type: z.literal("credentials.set"),
  provider: modelProviderSchema,
  key: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[!-~]+$/),
});
export const credentialsResultSchema = z.object({
  ...request,
  type: z.literal("credentials.result"),
  provider: modelProviderSchema.nullable(),
  storage: z.enum(["os-keychain", "file"]),
});
export const clientMessageSchema = z.discriminatedUnion("type", [
  credentialsStatusRequestSchema,
  credentialsSetRequestSchema,
  listProjectsRequestSchema,
  subscribeRequestSchema,
  readSessionRequestSchema,
  chatReadRequestSchema,
  chatSendRequestSchema,
  ownerAnswerRequestSchema,
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
export const eventBatchSchema = z
  .object({
    version: versionSchema,
    ...history,
    type: z.literal("events"),
    subscriptionId: identifier,
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
  code: z.enum(["invalid-message", "app-too-old", "daemon-too-old", "not-found", "internal"]),
  message: identifier,
});
export const serverMessageSchema = z.discriminatedUnion("type", [
  credentialsResultSchema,
  projectsResultSchema,
  subscribedSchema,
  sessionResultSchema,
  eventBatchSchema,
  errorSchema,
  chatResultSchema,
  chatSentSchema,
  ownerAnsweredSchema,
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
  return { ok: true, request: parsed.data };
}
