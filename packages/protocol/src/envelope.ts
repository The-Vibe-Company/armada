import { z } from "zod";

export const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const identifier = z.string().min(1);
export const versionSchema = z.object({ major: counter, minor: counter });

/** Construct request validators only where the request is consumed. */
export function requestSchema<T extends string, S extends z.ZodRawShape>(type: T, fields: S) {
  return z.object({ version: versionSchema, id: identifier, type: z.literal(type), ...fields });
}
