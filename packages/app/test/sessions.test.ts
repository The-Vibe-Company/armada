import { expect, test } from "bun:test";
import type { ProtocolEvent } from "@armada/protocol";
import { sessionsInFlight } from "../src/fleet/sessions";

const e = (kind: string, payload: ProtocolEvent["payload"]): ProtocolEvent => ({
  seq: 1,
  project: "alpha",
  kind,
  at: "2026-01-05T09:00:00.000Z",
  actor: "worker",
  payload,
});

test("counts the sessions claimed and not yet released or merged, ignoring other kinds and shapes", () => {
  const log = [
    e("session.claimed", { ticket: "EX-1", session: "a" }),
    e("session.claimed", { ticket: "EX-2", session: "b" }),
    e("session.claimed", { ticket: "EX-3", session: "c" }),
    e("session.reported", { ticket: "EX-1", session: "a", phase: "implementing" }),
    e("ticket.seen", { id: "EX-9", title: "Unrelated" }),
    e("session.claimed", ["not", "an", "object"]),
    e("session.claimed", { ticket: "EX-4" }),
  ];
  expect(sessionsInFlight(log)).toBe(3);
  expect(
    sessionsInFlight([
      ...log,
      e("session.released", { ticket: "EX-2", session: "b", reason: "done elsewhere" }),
      e("merge.confirmed", { ticket: "EX-3", session: "c", pr: 7 }),
    ]),
  ).toBe(1);
});
