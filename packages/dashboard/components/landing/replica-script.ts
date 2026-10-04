// What the landing's replica of the fleet plays (THE-887, THE-931), as
// changes to the demo world's overview, the way the dashboard's polls would
// bring them: the coordinator answers a worker's question and the worker goes
// back to work, a hand-back arrives, then its merge waits for the owner, "To
// validate". Pure: each beat is a new overview, built from the one before,
// the dashboard's overview draws it.
import { type AgentPhase, type FleetOverview, type FleetRow, flowStep, type WaitingItem } from "@armada/core/read";

/** The question the coordinator answers, and the hand-back whose merge the owner validates. */
export const ASKED = "WID-15";
export const HANDED_BACK = "WID-18";
export const OWNER = "Léa Martin";

const iso = (ms: number) => new Date(ms).toISOString();

function rowOf(o: FleetOverview, id: string): FleetRow | undefined {
  return o.rows.find((r) => r.id === id);
}

/** A row's step, after its phase or its timeline changed. */
function restep(o: FleetOverview, id: string) {
  const row = rowOf(o, id);
  const tl = o.timeline?.rows.find((r) => r.id === id)?.timeline;
  if (row)
    row.step = flowStep(
      row,
      tl?.phases.map((p) => p.phase),
    );
}

/** A worker's new phase on its row and its timeline: the last segment closes, a new one opens now. */
function movePhase(o: FleetOverview, id: string, phase: AgentPhase, at: number, summary: string) {
  const row = rowOf(o, id);
  if (row) {
    row.phase = phase;
    row.since = iso(at);
    row.lastReport = iso(at);
    row.lastUpdate = iso(at);
    row.statusLine = row.statusLine ? { ...row.statusLine, summary, at: iso(at) } : null;
  }
  const tl = o.timeline?.rows.find((r) => r.id === id)?.timeline;
  if (tl) {
    const last = tl.phases.at(-1);
    if (last) last.to = iso(at);
    tl.phases.push({ phase, from: iso(at), to: null, summary });
    tl.reports.push(iso(at));
  }
  restep(o, id);
}

const isOpen = (v: FleetOverview["validations"][number]) => v.ticket === HANDED_BACK && !v.decision;

/**
 * The opening state: the demo world, with WID-18 still shipping, so its
 * hand-back and its merge to validate can arrive later. Times move with
 * `now`, the replica's clock.
 */
export function opening(base: FleetOverview): FleetOverview {
  const o = structuredClone(base);
  const back = o.waiting.find((w) => w.ticket === HANDED_BACK);
  o.waiting = o.waiting.filter((w) => w !== back);
  o.validations = o.validations.filter((v) => !isOpen(v));
  const row = rowOf(o, HANDED_BACK);
  if (row) {
    row.phase = "shipping";
    row.waiting = null;
  }
  const tl = o.timeline?.rows.find((r) => r.id === HANDED_BACK)?.timeline;
  const last = tl?.phases.at(-1);
  if (last) {
    last.phase = "shipping";
    last.summary = "Pull request open, waiting for CI";
  }
  restep(o, HANDED_BACK);
  return o;
}

/** The coordinator answered: the question closes and the worker reports implementing. */
export function delivered(prev: FleetOverview, at: number): FleetOverview {
  const o = structuredClone(prev);
  o.waiting = o.waiting.filter((w) => !(w.ticket === ASKED && w.kind === "question"));
  const row = rowOf(o, ASKED);
  if (row) {
    row.question = null;
    row.waiting = null;
  }
  movePhase(o, ASKED, "implementing", at, "Resumed: a sign-in link expires after 15 minutes");
  return o;
}

/** WID-18's worker hands back its green pull request: the coordinator's to merge. */
export function handedBack(prev: FleetOverview, base: FleetOverview, at: number): FleetOverview {
  const o = structuredClone(prev);
  const item = base.waiting.find((w) => w.ticket === HANDED_BACK);
  if (item) o.waiting.push({ ...(structuredClone(item) as WaitingItem), since: iso(at) });
  const row = rowOf(o, HANDED_BACK);
  if (row) row.waiting = "hand-back";
  movePhase(o, HANDED_BACK, "ready-to-merge", at, "Handed back: CI green on the final head");
  return o;
}

/** The project's rule keeps WID-18's merge for the owner: the coordinator asks, and the session is "To validate". */
export function toValidate(prev: FleetOverview, base: FleetOverview, at: number): FleetOverview {
  const o = structuredClone(prev);
  const asked = base.validations.filter(isOpen).map((v) => ({ ...structuredClone(v), createdAt: iso(at) }));
  // The open ones come first, oldest first, as the overview lists them.
  o.validations = [...o.validations.filter((v) => !v.decision), ...asked, ...o.validations.filter((v) => v.decision)];
  return o;
}
