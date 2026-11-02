import type { Delivery, FleetEvent } from "@armada/protocol";

export const deliveryFollowUpId = (id: string) => `follow-up:delivery:${id}`;

/** A replay cache only: the append-only log remains the outbox's source of truth. */
export function applyDelivery(deliveries: Map<string, Delivery>, e: FleetEvent): void {
  if (e.kind === "delivery.queued") {
    const prior = deliveries.get(e.payload.id);
    // Replayed intents never reset a sent receipt or a backoff for the same payload.
    if (
      prior &&
      prior.key === e.payload.key &&
      prior.text === e.payload.text &&
      prior.session === e.payload.session &&
      prior.generation === e.payload.generation
    )
      return;
    deliveries.set(e.payload.id, { ...e.payload, seq: e.seq, at: e.at, actor: e.actor, attempt: 0, nextAt: e.at });
  } else if (e.kind === "delivery.sent") {
    const row = deliveries.get(e.payload.id);
    if (row) {
      row.sentAt = e.payload.at;
      row.nextAt = null;
    }
  } else if (e.kind === "delivery.failed") {
    const row = deliveries.get(e.payload.id);
    if (!row || row.sentAt || e.payload.attempt <= row.attempt) return;
    row.attempt = e.payload.attempt;
    row.error = e.payload.error;
    row.nextAt = e.payload.nextAt;
    if (row.attempt >= 3 && row.failureSeq === undefined) {
      row.failureSeq = e.seq;
      row.failedAt = e.at;
    }
  }
}
