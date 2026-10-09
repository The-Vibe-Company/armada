// Durable coordinator-to-runtime delivery attempts (THE-1437).  The row is
// deliberately separate from the inbox: an answer remains useful while a
// runtime is unavailable, and a retry must keep the original generation and
// payload that were admitted for delivery.

import type { RuntimeName } from "./runtime.ts";

export const DELIVERY_KINDS = ["answer", "note", "merge-note"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const DELIVERY_STATES = ["pending", "delivered", "abandoned"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** The largest body accepted for an answer, note or merge notice. */
export const DELIVERY_TEXT_MAX = 100_000;

/** A delivery is attempted at most once initially and five more times. */
export const MAX_DELIVERY_ATTEMPTS = 6;

const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000] as const;

/**
 * The immutable identity and worker generation admitted for a delivery.
 * Project, coordinator and bookkeeping belong to the store row and are
 * intentionally absent: callers cannot move a delivery between projects or
 * rewrite its ownership by retrying it.
 */
export interface KeepDelivery {
  key: string;
  /** A keyed runtime message always names the worker ticket it targets. */
  ticket: string;
  item: number | null;
  kind: DeliveryKind;
  text: string;
  runtime: RuntimeName;
  handle: string;
  claimedAt: string | null;
  launchId: string | null;
  /** Herdr branch provenance used by the ClaimRef guard. */
  branch: string | null;
}

/** A pending-deliveries row, including its retry bookkeeping. */
export interface PendingDelivery extends KeepDelivery {
  id: number;
  project: string;
  coordinator: string;
  createdAt: string;
  attempts: number;
  attemptedAt: string | null;
  state: DeliveryState;
  endedAt: string | null;
  reason: string | null;
}

/** The safe subset included in an inbox read and its ETag. */
export type PendingDeliverySummary = Pick<
  PendingDelivery,
  "id" | "key" | "ticket" | "item" | "kind" | "attempts" | "attemptedAt" | "state"
>;

/** Whether a pending row has passed its bounded retry delay. */
export function deliveryDue(row: Pick<PendingDelivery, "state" | "attempts" | "attemptedAt">, now: Date): boolean {
  if (row.state !== "pending") return false;
  if (!row.attemptedAt) return true;
  const attemptedAt = Date.parse(row.attemptedAt);
  if (!Number.isFinite(attemptedAt)) return false;
  const slot = Math.min(Math.max(row.attempts, 1), BACKOFF_MS.length) - 1;
  const delay = BACKOFF_MS[slot] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0;
  return now.getTime() >= attemptedAt + delay;
}
