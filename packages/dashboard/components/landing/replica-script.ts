// What the landing's replica of the fleet plays (THE-887), as changes to the
// demo world's overview, the way the dashboard's polls would bring them:
// the owner answers a question, the coordinator delivers it and the worker
// goes back to work, then a hand-back arrives. Pure: each beat is a new
// overview, built from the one before, the dashboard's components draw it.
import type { AgentPhase, FleetOverview, FleetRow, WaitingItem } from "@armada/core/read";

/** The question the owner answers on the replica, and the hand-back that arrives. */
export const ASKED = "WID-15";
export const HANDED_BACK = "WID-18";
export const ANSWER = "15 minutes (recommended)";
export const OWNER = "Léa Martin";

const iso = (ms: number) => new Date(ms).toISOString();

function rowOf(o: FleetOverview, id: string): FleetRow | undefined {
  return o.rows.find((r) => r.id === id);
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
}

/**
 * The opening state: the demo world, with WID-18 still shipping, so its
 * hand-back can arrive later. Times move with `now`, the replica's clock.
 */
export function opening(base: FleetOverview): FleetOverview {
  const o = structuredClone(base);
  const back = o.waiting.find((w) => w.ticket === HANDED_BACK);
  o.waiting = o.waiting.filter((w) => w !== back);
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
  return o;
}

/** The owner picked an answer on the card: it waits for the coordinator to deliver it. */
export function answered(prev: FleetOverview, at: number): FleetOverview {
  const o = structuredClone(prev);
  const answer = { id: 900, body: ANSWER, author: OWNER, at: iso(at) };
  for (const w of o.waiting) if (w.ticket === ASKED && w.kind === "question") w.answer = answer;
  const row = rowOf(o, ASKED);
  if (row?.question) row.question.answer = answer;
  return o;
}

/** The coordinator delivered the answer: the question closes and the worker reports implementing. */
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

/** WID-18's worker hands back its green pull request: a new decision for the owner. */
export function handedBack(prev: FleetOverview, base: FleetOverview, at: number): FleetOverview {
  const o = structuredClone(prev);
  const item = base.waiting.find((w) => w.ticket === HANDED_BACK);
  if (item) o.waiting.push({ ...(structuredClone(item) as WaitingItem), since: iso(at) });
  const row = rowOf(o, HANDED_BACK);
  if (row) row.waiting = "hand-back";
  movePhase(o, HANDED_BACK, "ready-to-merge", at, "Handed back: CI green on the final head");
  return o;
}
