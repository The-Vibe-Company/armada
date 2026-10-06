// Shared runtime vocabulary and deterministic identities. No runtime I/O lives here.
import { createHash } from "node:crypto";
import { Refusal } from "./refusal.ts";

export const RUNTIME_NAMES = ["conductor", "herdr", "claude-code"] as const;
export type RuntimeName = (typeof RUNTIME_NAMES)[number];
export const runtimeNameOf = (stored: string | null | undefined): RuntimeName | null => {
  const name = stored?.trim().toLowerCase().replace(/\s+/g, "-");
  return RUNTIME_NAMES.includes(name as RuntimeName) ? (name as RuntimeName) : null;
};
export const RUNTIME_STATES = ["working", "blocked", "idle", "done", "failed", "gone", "unknown"] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];
export const OBSERVABLE_RUNTIMES: readonly RuntimeName[] = ["herdr", "conductor"];

/** A runtime action always names one worker generation. */
export interface ClaimRef {
  ticket: string;
  runtime: RuntimeName;
  handle: string;
  claimedAt: string | null;
  launchId: string | null;
  releasedAt: string | null;
  /** Herdr provenance: the branch recorded by the claim. */
  branch?: string | null;
  /** Authenticated ownership metadata; delivery refuses a notice after transfer to another coordinator. */
  coordinator?: string | null;
  /** Merge notices must not wake a session after any of its tickets hands back. */
  skipHandedBack?: boolean;
}
/** Receipt of a message accepted by a runtime. */
export interface Delivery {
  via: string;
  messageId: string | null;
  queued: boolean;
}

export type RuntimeErrorCode =
  | "unsupported"
  | "not-found"
  | "gone"
  | "mismatch"
  | "stale"
  | "busy"
  | "dirty"
  | "auth"
  | "unavailable"
  | "unknown-outcome"
  | "invalid";
export class RuntimeError extends Refusal {
  constructor(
    message: string,
    readonly code: RuntimeErrorCode,
    next: string,
    readonly retryable = code === "unavailable",
  ) {
    super(message, next);
  }
}

/** UUID v8, with unambiguous, ordered SHA-256 inputs; never contains message text. */
export function deliveryKey(parts: {
  project: string;
  ticket: string;
  claimedAt: string | null;
  launchId: string | null;
  item: number | null;
  kind: "answer" | "note" | "login";
  text: string;
}): string {
  const b = createHash("sha256")
    .update(
      JSON.stringify([
        parts.project,
        parts.ticket,
        parts.claimedAt,
        parts.launchId,
        parts.item,
        parts.kind,
        parts.text,
      ]),
    )
    .digest()
    .subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const conductorSessionState = (status: string): RuntimeState =>
  status === "working" ? "working" : status === "idle" ? "idle" : status === "error" ? "failed" : "unknown";
