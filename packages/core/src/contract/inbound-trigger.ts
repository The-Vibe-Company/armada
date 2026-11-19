import { z } from "zod";
import { HARNESSES } from "../harnesses.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const limit = z.number().int().positive().max(2_147_483_647);

export const createInboundTriggerBody = z.strictObject({
  templateId: uuid,
  poolHarness: z.enum(HARNESSES),
  ratePerMinute: limit,
  concurrency: limit,
});

export const createdInboundTrigger = z.strictObject({
  triggerId: uuid,
  signingSecret: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});

export type CreatedInboundTrigger = z.infer<typeof createdInboundTrigger>;
