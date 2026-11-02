import { z } from "zod";
import { identifier, versionSchema as version } from "./envelope.js";

// The Tickets page's writes (THE-2124): the owner creates and edits a
// project's tickets through its tracker, as the coordinator's `ticket.create`
// and `ticket.update` tools do (same fields, same limits). `requestId` is the
// idempotency key: the form keeps it until the daemon confirms, so a retry
// after a drop replays the first answer. A refusal is an `error` frame.
// index.ts adds these to the message unions; this file imports nothing from it.

/** The first wire minor that carries `ticket.create`, `ticket.update` and `ticket.result`. */
export const TICKETS_MINOR = 26;

const request = { version, id: identifier };
const id = z.string().min(1).max(200).regex(/\S/);
const labels = z.array(id).max(100);
const fields = {
  title: z.string().min(1).max(4000).regex(/\S/),
  description: z.string().max(100000),
  labels,
  parent: id.nullable(),
  blockers: z.array(id).max(100),
};
const target = { project: identifier, requestId: identifier.max(200) };

export const ticketCreateRequestSchema = /* @__PURE__ */ createRequest();
function createRequest() {
  return z.object({
    ...request,
    ...target,
    type: z.literal("ticket.create"),
    title: fields.title,
    description: fields.description,
    labels: labels.optional(),
    parent: fields.parent.optional(),
    blockers: fields.blockers.optional(),
    /** Adds the ready label (`ready-for-agent`). */
    ready: z.boolean().optional(),
  });
}
/** `ticket` names the ticket: `id` is the request's correlation. */
export const ticketUpdateRequestSchema = /* @__PURE__ */ updateRequest();
function updateRequest() {
  return z.object({
    ...request,
    ...target,
    type: z.literal("ticket.update"),
    ticket: id,
    title: fields.title.optional(),
    description: fields.description.optional(),
    labels: labels.optional(),
    addLabels: labels.optional(),
    removeLabels: labels.optional(),
    state: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]).optional(),
    parent: fields.parent.optional(),
    blockers: fields.blockers.optional(),
  });
}
/** The ticket created or edited; its folded state follows on the project's subscription. */
export const ticketResultSchema = z.object({
  ...request,
  ...target,
  type: z.literal("ticket.result"),
  ticket: id,
});

export const ticketRequestSchemas = [ticketCreateRequestSchema, ticketUpdateRequestSchema] as const;
export type TicketCreateRequest = z.infer<typeof ticketCreateRequestSchema>;
export type TicketUpdateRequest = z.infer<typeof ticketUpdateRequestSchema>;
export type TicketRequest = TicketCreateRequest | TicketUpdateRequest;
export type TicketResult = z.infer<typeof ticketResultSchema>;
