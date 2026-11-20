import { z } from "zod";
import type { Operation } from "./index.ts";

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
const cursor = z
  .string()
  .regex(new RegExp(`^(?:${cursorAlternatives.join("|")})$`))
  .optional()
  .describe(`A decimal event ID from 0 through ${maxId}.`);

export const streamSandboxEvents = {
  name: "streamSandboxEvents",
  directServer: true,
  scopedAuth: ["serviceToken", "viewerGrant", "epochGrant"],
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
