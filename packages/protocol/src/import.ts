import { z } from "zod";
import { counter, identifier, requestSchema, versionSchema } from "./envelope.js";

export const IMPORT_MINOR = 27;
export const trackerImportSchema = z.object({
  id: identifier,
  programRoot: identifier,
  state: z.enum(["running", "completed", "paused", "failed", "interrupted"]),
  imported: counter,
  skipped: counter,
  comments: counter,
  total: counter,
  pausedUntil: z.iso.datetime().optional(),
  error: z.string().optional(),
});
export type TrackerImport = z.infer<typeof trackerImportSchema>;
export const importPayloadSchemas = {
  "tracker.import-started": trackerImportSchema,
  "tracker.import-progress": trackerImportSchema.extend({ source: identifier.optional() }),
  "tracker.import-ended": trackerImportSchema,
};
export const trackerImportRequestSchema = /* @__PURE__ */ requestSchema("tracker.import", {
  project: identifier,
  programRoot: identifier,
});
export const trackerImportResultSchema = z.object({
  type: z.literal("tracker.import.result"),
  version: versionSchema,
  id: identifier,
  project: identifier,
  importId: identifier,
});
