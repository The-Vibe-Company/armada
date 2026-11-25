import { z } from "zod";
import type { Operation } from "./index.ts";
import { agentEventSchema, SANDBOX_STATUSES } from "./sandbox.ts";

const position = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const maxId = "9223372036854775807";

const cursorAlternatives = ["0", `[1-9][0-9]{0,${maxId.length - 2}}`, maxId];
for (const [index, digit] of Array.from(maxId).entries()) {
  const lowestDigit = index === 0 ? 1 : 0;
  const highestDigit = Number(digit) - 1;
  if (highestDigit < lowestDigit) continue;

  const remainingDigits = maxId.length - index - 1;
  const suffix = remainingDigits > 0 ? `[0-9]{${remainingDigits}}` : "";
  cursorAlternatives.push(`${maxId.slice(0, index)}[${lowestDigit}-${highestDigit}]${suffix}`);
}
const numericCursorPattern = new RegExp(`^(?:${cursorAlternatives.join("|")})$`);
const cursor = z
  .string()
  .regex(numericCursorPattern)
  .optional()
  .describe(`A decimal event ID from 0 through ${maxId}.`);
const queryCursor = z
  .string()
  .regex(new RegExp(`^(?:tail|${cursorAlternatives.join("|")})$`))
  .optional()
  .describe(`A decimal event ID from 0 through ${maxId}, or "tail" to subscribe at the live frontier.`);

export const streamSandboxEvents = {
  name: "streamSandboxEvents",
  directServer: true,
  scopedAuth: ["serviceToken", "viewerGrant", "epochGrant"],
  route: { method: "GET", path: "/api/v1/events" },
  input: {
    body: z.undefined(),
    query: z.object({ sandbox: z.guid(), cursor: queryCursor }),
    headers: { "Last-Event-ID": cursor },
  },
  output: z.object({
    id: position,
    sandboxId: z.guid(),
    sequence: position.nullable(),
    kind: z.enum(["transition", "runtime_event"]),
    ref: position,
    createdAt: z.iso.datetime(),
    event: agentEventSchema.optional(),
    status: z.enum(SANDBOX_STATUSES).optional(),
    statusReason: z.string().nullable().optional(),
  }),
  outputMediaType: "text/event-stream",
  readOnly: true,
  destructive: false,
  audience: "public",
  description:
    "Stream committed sandbox events using fetch with a bearer header (owner, scoped child, or viewer grant). " +
    "Each data frame uses its global decimal ID as the SSE id, carrying inline decrypted event data for public runtime events " +
    "and status/statusReason for transitions. Resume exclusively after Last-Event-ID, which takes precedence over cursor. " +
    "Pass cursor=tail to start at the live frontier without replaying history, or omit cursor to replay retained history. " +
    "Idle streams send a heartbeat comment every 15 seconds.",
  errors: ["invalid", "forbidden", "unavailable"],
} as const satisfies Operation<z.ZodType, z.ZodType>;
