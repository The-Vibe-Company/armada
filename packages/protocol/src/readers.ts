import { z } from "zod";
import { identifier, requestSchema } from "./envelope.js";

/** Optional visible-room presence and daemon reader telemetry. */
export const READER_MINOR = 14;
export const roomPresenceRequestSchema = /* @__PURE__ */ requestSchema("room.presence", {
  project: identifier.nullable(),
});
export type RoomPresenceRequest = z.infer<typeof roomPresenceRequestSchema>;
export const readerUsageSchema = z.object({
  hour: z.iso.datetime(),
  requests: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  complexity: z.number().min(0).finite().optional(),
  rateLimit: z.record(z.string(), z.number().finite()).optional(),
  pausedUntil: z.iso.datetime().nullable(),
});
export type ReaderUsage = z.infer<typeof readerUsageSchema>;
