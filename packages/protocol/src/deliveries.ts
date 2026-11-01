import { z } from "zod";

export const DELIVERIES_MINOR = 17;
const text = /* @__PURE__ */ z.string();
const integer = /* @__PURE__ */ (() => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))();
const deliverySchema = /* @__PURE__ */ (() =>
  z.object({
    ticket: text,
    session: text,
    id: text,
    generation: integer.min(1),
    source: z.enum(["owner-answer", "coordinator-message", "note"]),
    text,
    key: text,
    /** Original inbox identity, needed by hosted runtime bookkeeping. */
    item: text.optional(),
  }))();
export const deliveryStateSchema = /* @__PURE__ */ (() =>
  deliverySchema.extend({
    seq: integer,
    at: text,
    actor: text,
    attempt: integer,
    error: text.optional(),
    nextAt: text.nullable(),
    sentAt: text.optional(),
    failedAt: text.optional(),
    failureSeq: integer.optional(),
  }))();
export type Delivery = z.infer<typeof deliveryStateSchema>;

export const deliveryPayloadSchemas = /* @__PURE__ */ (() => ({
  "delivery.queued": deliverySchema,
  "delivery.sent": z.object({ id: text, at: text }),
  "delivery.failed": z.object({ id: text, attempt: integer.min(1), error: text, nextAt: text.nullable() }),
}))();
