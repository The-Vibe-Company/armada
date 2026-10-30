import { z } from "zod";

// A session's page acts (THE-2045): the owner releases one worker generation,
// and reads its terminal output from the runtime's `observe`. Wire minor 6.
// From that minor `owner.answer` (chat.ts) also answers a worker's question.
// index.ts adds these to the message unions; this file imports nothing from it
// (its primitives are restated) so the two modules never wait on each other.

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1);
const version = z.object({ major: counter, minor: counter });
const request = { version, id: identifier };
const generation = { project: identifier, ticket: identifier, session: identifier };

/** The first wire minor that carries the session page's messages, and `owner.answer` on a worker's question. */
export const SESSION_MINOR = 6;
/** At most this many lines of a worker's output: its last ones. */
export const OUTPUT_LINES = 200;

/** Release this generation of the ticket's worker: the daemon stops it, never another one. */
export const sessionReleaseRequestSchema = z.object({
  ...request,
  ...generation,
  type: z.literal("session.release"),
  generation: counter.min(1),
  reason: z
    .string()
    .max(4 * 1024)
    .regex(/\S/),
});
/** The worker's last output, as its runtime observes it now. */
export const sessionOutputRequestSchema = z.object({ ...request, ...generation, type: z.literal("session.output") });

/** Released: the worker is stopped; `disposed` says whether its clean workspace was removed too. */
export const sessionReleaseResultSchema = z.object({
  ...request,
  ...generation,
  type: z.literal("session.release.result"),
  disposed: z.boolean(),
});
export const sessionOutputResultSchema = z.object({
  ...request,
  ...generation,
  type: z.literal("session.output.result"),
  state: z.enum(["starting", "running", "stopped", "failed", "unknown"]),
  activity: z.enum(["working", "idle"]).optional(),
  /** Oldest first, secrets masked, terminal control sequences removed. */
  lines: z.array(z.string()).max(OUTPUT_LINES),
});

export type SessionReleaseRequest = z.infer<typeof sessionReleaseRequestSchema>;
export type SessionOutputRequest = z.infer<typeof sessionOutputRequestSchema>;
export type SessionReleaseResult = z.infer<typeof sessionReleaseResultSchema>;
export type SessionOutputResult = z.infer<typeof sessionOutputResultSchema>;
