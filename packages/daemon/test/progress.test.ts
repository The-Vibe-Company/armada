import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetEvent, Session } from "@armada/protocol";
import { progressSignals } from "../src/liveness/progress.ts";

const minute = 60_000;
const at = (m: number) => new Date(m * minute).toISOString();
const session = {
  ticket: "ORC-1",
  session: "worker-1",
  generation: 1,
  runtime: "claude",
  phase: "implementing",
  at: at(0),
  heartbeat: at(40),
} as Session;
const event = (kind: FleetEvent["kind"], payload: unknown, m: number, seq = m + 1) =>
  ({ kind, payload, seq, at: at(m), project: "orchard", actor: "worker" }) as FleetEvent;
const report = (m: number, reason: string, phase = "implementing") =>
  event("session.reported", { ticket: session.ticket, session: session.session, phase, reason }, m) as Extract<
    FleetEvent,
    { kind: "session.reported" }
  >;
const working = event("session.runtime-observed", { ...session, state: "running", activity: "working" }, 0);
const head = (m: number, sha: string, ci = "pending") =>
  event("pull-request.seen", { ticket: session.ticket, number: 1, head: sha, ci, state: "open" }, m);

test("progress signals distinguish fresh work, repeated reports, moving heads and waiting workers", () => {
  assert.equal(
    progressSignals(
      session,
      [report(0, "Plan complete", "planning"), report(35, "Implemented pagination")],
      [working],
      40 * minute,
      {},
    ).level,
    0,
  );
  const repeated = [
    report(0, "Retrying the same test"),
    report(15, "Retrying the same test"),
    report(30, "Retrying the same test"),
  ];
  const loop = progressSignals(session, repeated, [working], 40 * minute, {});
  assert.ok(loop.level >= 1);
  assert.equal(loop.reasons.find((r) => r.code === "repeated-report")?.count, 3);
  assert.equal(progressSignals(session, repeated, [working, head(0, "a"), head(35, "b")], 40 * minute, {}).level, 0);
  assert.equal(progressSignals({ ...session, phase: "blocked" }, repeated, [working], 90 * minute, {}).level, 0);
  assert.equal(
    progressSignals({ ...session, heartbeat: at(0) }, [], [], 90 * minute, {}).level,
    0,
    "dead workers belong to ordinary liveness",
  );
});

test("working doubles the elapsed progress threshold and severity grows at doubling intervals", () => {
  const reports = [report(0, "Investigating")];
  const idle = event("session.runtime-observed", { ...session, state: "running", activity: "idle" }, 0);
  const policy = { silenceMinutes: 15, quietMinutes: 10 };
  const live = { ...session, heartbeat: at(19) };
  assert.ok(progressSignals(live, reports, [idle], 19 * minute, policy).level >= 1);
  assert.equal(progressSignals(live, reports, [working], 19 * minute, policy).level, 0);
  const first = progressSignals(session, reports, [working], 40 * minute, policy);
  assert.ok(first.level >= 1);
  assert.ok(
    progressSignals({ ...session, heartbeat: at(80) }, reports, [working], 80 * minute, policy).level > first.level,
  );
});

test("shipping red checks need sustained evidence on the same head since the shipping report", () => {
  const shipping = { ...session, phase: "shipping" as const };
  const reports = [report(0, "Waiting for checks", "shipping")];
  const stalled = progressSignals(
    shipping,
    reports,
    [head(0, "a", "failure"), head(35, "a", "failure")],
    40 * minute,
    {},
  );
  assert.ok(stalled.reasons.some((r) => r.code === "red-checks"));
  const changed = progressSignals(
    shipping,
    reports,
    [head(0, "a", "failure"), head(35, "b", "failure")],
    40 * minute,
    {},
  );
  assert.equal(
    changed.reasons.some((r) => r.code === "red-checks"),
    false,
  );
});

test("varied reports cannot hide sustained working without a phase or head move", () => {
  const reports = [
    report(0, "Investigating pagination"),
    report(15, "Exploring a new subsystem"),
    report(30, "Expanding the rewrite"),
  ];
  const signals = progressSignals(session, reports, [working], 40 * minute, {});
  assert.ok(signals.reasons.some((r) => r.code === "working-no-progress"));
});
