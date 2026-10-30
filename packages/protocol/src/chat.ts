import { z } from "zod";

// A project's room (THE-1996): the owner's conversation with the project's
// coordinator, and the owner's answer to a question pinned in it. Wire minor 4.
// index.ts adds these to the message unions; this file imports nothing from it
// (its primitives are restated) so the two modules never wait on each other.

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1);
const version = z.object({ major: counter, minor: counter });
const at = z.iso.datetime({ offset: true });
const request = { version, id: identifier };
/** What the owner writes: one message, at most 16 KiB, never blank. */
const message = z
  .string()
  .max(16 * 1024)
  .regex(/\S/);

/** The first wire minor that carries the room's messages. */
export const CHAT_MINOR = 4;
/** The first wire minor with committed live turns, partials, tools and Stop. */
export const CHAT_LIVE_MINOR = 7;

const assistant = { reasoning: z.string().optional(), aborted: z.literal(true).optional() };
const tool = {
  id: identifier,
  at,
  name: identifier,
  input: z.json(),
  output: z.string().nullable(),
  failed: z.boolean(),
};
/** Unsolicited frames are project-scoped; `id` on a delta/tool is the chat item's identity. */
const frame = { version, project: identifier };
export const chatTurnSchema = z.object({
  ...frame,
  type: z.literal("chat.turn"),
  state: z.enum(["idle", "thinking", "writing", "tool"]),
  since: at,
  tool: z.object({ name: identifier, id: identifier }).optional(),
  queued: counter,
});
export const chatDeltaSchema = z.object({
  ...frame,
  type: z.literal("chat.delta"),
  id: identifier,
  kind: z.enum(["text", "reasoning"]),
  text: z.string(),
});
export const chatToolSchema = z.object({ ...frame, ...tool, type: z.literal("chat.tool") });

/**
 * One line of the conversation, as the daemon reads it: the owner's message,
 * the coordinator's answer, the coordinator's own short line (said on its own,
 * when the fleet moved, not in answer to the owner), or one tool call with its
 * result (`output` is null while it runs).
 */
export const chatItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), id: identifier, at, body: z.string() }),
  z.object({ kind: z.literal("coordinator"), id: identifier, at, body: z.string(), ...assistant }),
  z.object({ kind: z.literal("line"), id: identifier, at, body: z.string(), ...assistant }),
  z.object({ kind: z.literal("tool"), ...tool }),
]);
export type ChatItem = z.infer<typeof chatItemSchema>;

export const chatStopRequestSchema = z.object({ ...request, type: z.literal("chat.stop"), project: identifier });
export const chatStoppedSchema = z.object({ ...request, type: z.literal("chat.stopped"), project: identifier });

export const chatReadRequestSchema = z.object({ ...request, type: z.literal("chat.read"), project: identifier });
/** `requestId` names the message: sending it again (after a drop) is the same message, admitted once. */
export const chatSendRequestSchema = z.object({
  ...request,
  type: z.literal("chat.send"),
  project: identifier,
  requestId: identifier.max(200),
  body: message,
});
/** The owner's answer to a question waiting for them (an open `owner-request` of the project's inbox). */
export const ownerAnswerRequestSchema = z.object({
  ...request,
  type: z.literal("owner.answer"),
  project: identifier,
  item: identifier,
  choice: message.max(1024),
  note: z
    .string()
    .max(4 * 1024)
    .optional(),
});

/**
 * The conversation at the log cursor `seq`, oldest first (its latest items when
 * it is long). `coordinator` says whether one runs for the project: without
 * one, the conversation is empty and nothing can be sent.
 */
export const chatResultSchema = z.object({
  ...request,
  type: z.literal("chat.result"),
  project: identifier,
  seq: counter,
  coordinator: z.boolean(),
  items: z.array(chatItemSchema),
  /** Absent on daemons older than CHAT_LIVE_MINOR. */
  turn: chatTurnSchema.optional(),
});
/** The message is admitted: the coordinator's checkpoint carries it to every subscriber. */
export const chatSentSchema = z.object({
  ...request,
  type: z.literal("chat.sent"),
  project: identifier,
  requestId: identifier,
});
export const ownerAnsweredSchema = z.object({
  ...request,
  type: z.literal("owner.answered"),
  project: identifier,
  item: identifier,
});

export type ChatReadRequest = z.infer<typeof chatReadRequestSchema>;
export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>;
export type OwnerAnswerRequest = z.infer<typeof ownerAnswerRequestSchema>;
export type ChatResult = z.infer<typeof chatResultSchema>;
export type ChatSent = z.infer<typeof chatSentSchema>;
export type OwnerAnswered = z.infer<typeof ownerAnsweredSchema>;

export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type ChatDelta = z.infer<typeof chatDeltaSchema>;
export type ChatTool = z.infer<typeof chatToolSchema>;
export type ChatStopRequest = z.infer<typeof chatStopRequestSchema>;
export type ChatStopped = z.infer<typeof chatStoppedSchema>;
