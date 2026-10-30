import type {
  FleetEvent,
  FleetTables,
  Hold,
  InboxItem,
  Phase,
  PullRequest,
  QueueEntry,
  Session,
  SessionRef,
  SessionState,
  ShippingStage,
  Ticket,
  Validation,
} from "@armada/protocol";
import { z } from "zod";
import { checkpointRules, emptyRules, type RulesState } from "../coordinator/rules.ts";
import { flowStep, pipelineStep } from "./rules.ts";

export type {
  FleetTables,
  Hold,
  InboxItem,
  ProjectTables,
  QueueEntry,
  Session,
  SessionState,
  Validation,
} from "@armada/protocol";

interface Draft extends SessionRef {
  generation: number;
  owner: string;
  runtime: string;
  handle: string;
  phase: Phase;
  reason: string;
  at: string;
  heartbeat: string | null;
  earlier: Phase[];
  claimSeq?: number;
  stage?: ShippingStage;
}
const readerCheckpoint = z.object({
  format: z.literal("armada.readers"),
  version: z.literal(1),
  provider: z.string().min(1),
});

interface Projection {
  readAt: Record<string, string>;
  rules: RulesState;
  tickets: Map<string, Ticket>;
  prs: Map<number, PullRequest>;
  mergedAt: Map<number, { at: string; seq: number }>;
  sessions: Map<string, Draft>;
  claims: Set<string>;
  inbox: Map<string, InboxItem>;
  queue: Map<string, QueueEntry>;
  holds: Map<string, Hold>;
  validations: Map<string, Validation>;
}
const empty = (): Projection => ({
  rules: emptyRules(),
  readAt: Object.create(null),
  tickets: new Map(),
  prs: new Map(),
  mergedAt: new Map(),
  sessions: new Map(),
  claims: new Set(),
  inbox: new Map(),
  queue: new Map(),
  holds: new Map(),
  validations: new Map(),
});
const active = (p: Projection, ref: SessionRef) => {
  const session = p.sessions.get(ref.ticket);
  return session?.session === ref.session && session.phase !== "released" && session.phase !== "merged"
    ? session
    : undefined;
};

/** Replay a complete, ascending log (or a project-filtered log with sequence gaps).
 * No database, clock or V1 imports. All returned data is detached from the input.
 */
export function fold(events: readonly FleetEvent[]): FleetTables {
  const projects = new Map<string, Projection>();
  let seq = 0;
  for (const source of events) {
    if (!Number.isSafeInteger(source.seq) || source.seq <= seq)
      throw new Error("events must have increasing positive sequence numbers");
    seq = source.seq;
    const e = structuredClone(source);
    let p = projects.get(e.project);
    if (!p) {
      p = empty();
      projects.set(e.project, p);
    }
    switch (e.kind) {
      case "ticket.seen": {
        const t = e.payload;
        p.tickets.set(t.id, t);
        const current = p.sessions.get(t.id);
        const trackerId = `tracker:${t.id}`;
        if (!current || current.session === trackerId) {
          if (t.phase)
            p.sessions.set(t.id, {
              ticket: t.id,
              session: trackerId,
              generation: 0,
              owner: t.owner ?? e.actor,
              runtime: "tracker",
              handle: "",
              phase: t.phase,
              reason: t.reason ?? t.phase,
              at: e.at,
              heartbeat: null,
              earlier: current ? [...current.earlier, current.phase] : [],
            });
          else if (current) p.sessions.delete(t.id);
        }
        break;
      }
      case "pull-request.opened":
      case "pull-request.head-moved":
      case "pull-request.checks-green":
      case "pull-request.checks-red":
      case "pull-request.review-changed":
      case "pull-request.closed":
      case "pull-request.merged":
      case "pull-request.seen":
        if (e.payload.state === "merged" && p.prs.get(e.payload.number)?.state !== "merged")
          p.mergedAt.set(e.payload.number, { at: e.at, seq: e.seq });
        p.prs.delete(e.payload.number);
        p.prs.set(e.payload.number, { ...e.payload, conflicting: e.payload.state === "open" && e.payload.conflicting });
        break;
      case "session.claimed":
        if (!Number.isSafeInteger(e.payload.generation) || e.payload.generation < 1)
          throw new Error("claim generation must be a positive safe integer");
        // Caller-assigned generations fence even previously unseen delayed claims.
        if (
          !p.claims.has(e.payload.session) &&
          e.payload.generation > (p.sessions.get(e.payload.ticket)?.generation ?? 0)
        )
          p.sessions.set(e.payload.ticket, {
            ...e.payload,
            claimSeq: e.seq,
            phase: "planning",
            reason: "Claimed",
            at: e.at,
            heartbeat: null,
            earlier: [],
          });
        p.claims.add(e.payload.session);
        break;
      case "session.reported": {
        const s = active(p, e.payload);
        if (s) {
          s.earlier.push(s.phase);
          s.phase = e.payload.phase;
          s.reason = e.payload.reason;
          s.at = e.at;
          if (e.payload.stage !== undefined) s.stage = e.payload.stage;
        }
        break;
      }
      case "session.heartbeat": {
        const s = active(p, e.payload);
        if (s) s.heartbeat = e.at;
        break;
      }
      case "session.released": {
        const s = active(p, e.payload);
        if (s) {
          s.earlier.push(s.phase);
          s.phase = "released";
          s.reason = e.payload.reason;
          s.at = e.at;
        }
        break;
      }
      case "inbox.opened":
        if (!p.inbox.has(e.payload.id))
          p.inbox.set(e.payload.id, { ...e.payload, at: e.at, actor: e.actor, seq: e.seq });
        break;
      case "inbox.answered":
        p.inbox.delete(e.payload.id);
        break;
      case "merge.queued":
        if (!p.queue.has(e.payload.id))
          p.queue.set(e.payload.id, { ...e.payload, at: e.at, seq: e.seq, state: "queued" });
        break;
      case "merge.started": {
        const q = p.queue.get(e.payload.id);
        if (q) q.state = "running";
        break;
      }
      case "merge.refused":
      case "merge.canceled":
        p.queue.delete(e.payload.id);
        break;
      case "merge.confirmed": {
        const q = p.queue.get(e.payload.id);
        if (
          q &&
          (q.head !== e.payload.head ||
            q.pr !== e.payload.pr ||
            q.session !== e.payload.session ||
            q.ticket !== e.payload.ticket)
        )
          break;
        p.queue.delete(e.payload.id);
        const s = active(p, e.payload);
        if (s) {
          s.earlier.push(s.phase);
          s.phase = "merged";
          s.reason = `Merged #${e.payload.pr}`;
          s.at = e.at;
        }
        break;
      }
      case "hold.opened":
        if (!p.holds.has(e.payload.id)) p.holds.set(e.payload.id, { ...e.payload, at: e.at, actor: e.actor });
        break;
      case "hold.cleared":
        p.holds.delete(e.payload.id);
        break;
      case "validation.opened":
        if (!p.validations.has(e.payload.id))
          p.validations.set(e.payload.id, { ...e.payload, at: e.at, actor: e.actor, decision: null });
        break;
      case "validation.decided": {
        const v = p.validations.get(e.payload.id);
        if (v && !v.decision)
          v.decision = { decision: e.payload.decision, note: e.payload.note, at: e.at, actor: e.actor };
        break;
      }
      case "coordinator.checkpoint": {
        const reading = readerCheckpoint.safeParse(e.payload.checkpoint);
        if (reading.success && Number.isFinite(Date.parse(e.at))) p.readAt[reading.data.provider] = e.at;
        const rules = checkpointRules(e.payload.checkpoint);
        if (rules) p.rules = rules;
        break;
      }
      case "coordinator.message":
        break;
    }
  }
  const tables: FleetTables = { seq, projects: Object.create(null) };
  for (const [project, p] of projects) {
    const sessions = [...p.sessions.values()].map((s): Session => {
      const pr = [...p.prs.values()].reverse().find(
        (pr) =>
          pr.ticket === s.ticket &&
          pr.state !== "closed" &&
          // Re-observing an old merge cannot end a later worker generation.
          !(pr.state === "merged" && s.claimSeq !== undefined && (p.mergedAt.get(pr.number)?.seq ?? 0) < s.claimSeq),
      );
      const validation = [...p.validations.values()].find(
        (v) => v.ticket === s.ticket && v.session === s.session && !v.decision,
      );
      const decision = [...p.validations.values()]
        .reverse()
        .find((v) => v.ticket === s.ticket && v.session === s.session)?.decision;
      const question = [...p.inbox.values()].find((i) => i.ticket === s.ticket && i.kind === "question");
      let state: SessionState = "in-progress";
      let reason = s.reason;
      const phase = s.phase !== "released" && pr?.state === "merged" ? "merged" : s.phase;
      if (phase === "merged" || phase === "released") {
        state = phase;
        if (pr?.state === "merged" && phase === "merged") reason = `Pull request #${pr.number} merged`;
      } else if (s.phase === "blocked") state = "blocked";
      else if (validation || s.phase === "awaiting-approval" || (s.phase === "awaiting-validation" && !decision)) {
        state = "waiting-for-owner";
        if (validation) reason = validation.question;
      } else if (question || pr?.conflicting || pr?.ci === "failure") {
        state = "blocked";
        reason =
          question?.body ?? (pr?.conflicting ? "Pull request conflicts with its base" : "Pull request checks failed");
      } else if (s.phase === "ready-to-merge") state = "ready-to-merge";
      else if (s.phase === "awaiting-validation" && decision)
        reason = decision.note || (decision.decision === "approved" ? "Validation approved" : "Changes requested");
      return {
        ticket: s.ticket,
        session: s.session,
        generation: s.generation,
        owner: s.owner,
        runtime: s.runtime,
        handle: s.handle,
        title: p.tickets.get(s.ticket)?.title ?? s.ticket,
        phase,
        state,
        reason,
        step: pipelineStep(phase, pr),
        flowStep: flowStep(phase, s.stage, pr, s.earlier),
        at: phase === "merged" && pr?.state === "merged" ? (p.mergedAt.get(pr.number)?.at ?? s.at) : s.at,
        heartbeat: s.heartbeat,
      };
    });
    const sessionsByState: Record<SessionState, Session[]> = {
      blocked: [],
      "waiting-for-owner": [],
      "in-progress": [],
      "ready-to-merge": [],
      merged: [],
      released: [],
    };
    for (const s of sessions) sessionsByState[s.state].push(s);
    tables.projects[project] = {
      rules: p.rules,
      ...(Object.keys(p.readAt).length ? { readAt: p.readAt } : {}),
      tickets: [...p.tickets.values()],
      pullRequests: [...p.prs.values()],
      sessions,
      sessionsByState,
      inbox: [...p.inbox.values()],
      queue: [...p.queue.values()],
      holds: [...p.holds.values()],
      validations: [...p.validations.values()],
    };
  }
  return tables;
}
