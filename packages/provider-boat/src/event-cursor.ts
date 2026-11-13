import { ProviderError } from "@armada/core";

export interface PendingEvent {
  id: string;
  before?: string | undefined;
  fingerprint: string;
}
const prefix = "armada-boat-events-v1.";
const invalid = (): never => {
  throw new ProviderError({
    provider: "boat",
    code: "invalid_request",
    retryable: false,
    message: "Invalid Boat event continuation.",
  });
};

/** No prompt text/credentials in public cursors. Legacy native cursors remain readable. */
export function readEventCursor(cursor?: string): { native?: string | undefined; pending: PendingEvent[] } {
  if (!cursor?.startsWith(prefix)) return { native: cursor, pending: [] };
  try {
    if (cursor.length > 262144) return invalid();
    const value = JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"));
    if (
      (value.native !== undefined && typeof value.native !== "string") ||
      !Array.isArray(value.pending) ||
      value.pending.length > 1000 ||
      value.pending.some(
        (p: PendingEvent) =>
          !p ||
          typeof p.id !== "string" ||
          !p.id ||
          (p.before !== undefined && typeof p.before !== "string") ||
          !/^([a-f0-9]{64})$/.test(p.fingerprint),
      )
    )
      return invalid();
    return value;
  } catch {
    return invalid();
  }
}

export function writeEventCursor(native: string | undefined, pending: PendingEvent[]): string {
  if (!pending.length) return native ?? "";
  const cursor = prefix + Buffer.from(JSON.stringify({ native, pending })).toString("base64url");
  // Never silently forget unfinished rows when the continuation cannot be represented.
  if (pending.length > 1000 || cursor.length > 262144) return invalid();
  return cursor;
}
