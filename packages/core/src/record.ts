/** A non-null, non-array object; this does not require a plain-object prototype. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
