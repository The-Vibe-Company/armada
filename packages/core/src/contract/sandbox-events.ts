import { z } from "zod";
import type { Operation } from "./index.ts";

const position = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const maxId = "9223372036854775807";
const cursor = position.refine((value) => value.length < 19 || value <= maxId).optional();

export const streamSandboxEvents = {
  name: "streamSandboxEvents",
  directServer: true,
  route: { method: "GET", path: "/api/v1/events" },
  input: {
    body: z.undefined(),
    query: z.object({ sandbox: z.guid(), cursor }),
    headers: { "Last-Event-ID": cursor },
  },
  output: z.object({
    id: position,
    sandboxId: z.guid(),
    sequence: position.nullable(),
    kind: z.enum(["transition", "runtime_event"]),
    ref: position,
    createdAt: z.iso.datetime(),
  }),
  outputMediaType: "text/event-stream",
  readOnly: true,
  destructive: false,
  audience: "public",
  description:
    "Stream committed sandbox event references using fetch with a bearer header (owner, scoped child, or viewer grant). " +
    "Each data frame contains an event reference and uses its global decimal ID as the SSE id. " +
    "Resume exclusively after Last-Event-ID, which takes precedence over cursor. Without a cursor, replay retained history. " +
    "Idle streams send a heartbeat comment every 15 seconds.",
  errors: ["invalid", "forbidden", "unavailable"],
} as const satisfies Operation<z.ZodType, z.ZodType>;
