import type {
  Delivery,
  EventPayloads,
  FleetEvent,
  FleetTables,
  Hold,
  InboxItem,
  Phase,
  ProjectTables,
  PullRequest,
  QueueEntry,
  Session,
  SessionRef,
  SessionState,
  ShippingStage,
  Ticket,
  Validation,
} from "@armada/protocol";
import { phaseSchema, type ReaderUsage, readerUsageSchema, workerLaunchCheckpointSchema } from "@armada/protocol";
import { z } from "zod";
import { recoverFollowUps, sameFollowUpAction } from "../coordinator/follow-ups.ts";
import { checkpointRules, emptyRules, type RulesState } from "../coordinator/rules.ts";
import { applyDelivery, deliveryFollowUpId } from "./delivery-state.ts";
import { flowStep, pipelineStep } from "./rules.ts";
import { UsageLedger } from "./usage.ts";

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
  startedAt?: string;
  launchSeq?: number;
  stage?: ShippingStage;
}
const linearUsageCheckpoint = z.object({
  format: z.literal("armada.linear-reader"),
  version: z.literal(1),
  usage: readerUsageSchema,
});
const readerCheckpoint = z.object({
  format: z.literal("armada.readers"),
  version: z.literal(1),
  provider: z.string().min(1),
  failures: z.number().int().nonnegative().optional(),
});

/** Bump when the fold's rules or the projection's shape change: a stored
 * snapshot of another version is ignored and rebuilt from the log.
 */
export const FOLD_VERSION = 1;
/** Checkpoint formats whose rows the fold never reads, and those it reads
 * latest-wins per actor, so a store can hand it a stub for the others.
 */
export const CHECKPOINT_RETENTION = {
  skipped: ["armada.github-reader"],
  latest: ["armada.linear-reader"],
} as const;

interface Projection {
  trackerImport?: ProjectTables["trackerImport"];
  defaultBranch?: ProjectTables["defaultBranch"];
  readAt: Record<string, string>;
  readers: Record<string, ReaderUsage>;
  rules: RulesState;
  tickets: Map<string, Ticket>;
  internal: Map<string, EventPayloads["ticket.created"]>;
  comments: Map<string, Map<string, { body: string; author: string; at: string; seq: number }>>;
  prs: Map<number, PullRequest>;
  mergedAt: Map<number, { at: string; seq: number }>;
  sessions: Map<string, Draft>;
  claims: Set<string>;
  inbox: Map<string, InboxItem>;
  queue: Map<string, QueueEntry>;
  holds: Map<string, Hold>;
  validations: Map<string, Validation>;
  deliveries: Map<string, Delivery>;
  deliveryFollowUps: Set<string>;
  usage: UsageLedger;
}
const empty = (): Projection => ({
  usage: new UsageLedger(),
  rules: emptyRules(),
  readAt: Object.create(null),
  readers: Object.create(null),
  tickets: new Map(),
  internal: new Map(),
  comments: new Map(),
  prs: new Map(),
  mergedAt: new Map(),
  sessions: new Map(),
  claims: new Set(),
  inbox: new Map(),
  queue: new Map(),
  holds: new Map(),
  validations: new Map(),
  deliveries: new Map(),
  deliveryFollowUps: new Set(),
});
const active = (p: Projection, ref: SessionRef) => {
  const session = p.sessions.get(ref.ticket);
  return session?.session === ref.session && session.phase !== "released" && session.phase !== "merged"
    ? session
    : undefined;
};

const clearProgressNotices = (p: Projection, ticket: string) => {
  for (const [id, item] of p.inbox) if (item.kind === "liveness" && item.ticket === ticket) p.inbox.delete(id);
};

/** Append-only, in-memory replay state. Each snapshot is detached so a caller
 * can keep the previous reading while the next event advances the same fold.
 * The event log remains the authority; `serialize` only lets a store resume
 * this state from a cursor instead of replaying the whole log.
 */
export class FoldAccumulator {
  readonly #projects = new Map<string, Projection>();
  #seq = 0;

  /** The last applied sequence number: a resumed replay starts after it. */
  get seq(): number {
    return this.#seq;
  }

  /** `owned` events were parsed for this accumulator and are not cloned. */
  append(source: FleetEvent, owned = false): void {
    if (!Number.isSafeInteger(source.seq) || source.seq <= this.#seq)
      throw new Error("events must have increasing positive sequence numbers");
    applyEvent(this.#projects, owned ? source : structuredClone(source));
    this.#seq = source.seq;
  }

  snapshot(): FleetTables {
    const tables = structuredClone(projectTables(this.#projects, this.#seq));
    // structuredClone normalizes null dictionaries; preserve missing-name reads.
    Object.setPrototypeOf(tables.projects, null);
    for (const project of Object.values(tables.projects)) {
      if (project.readAt) Object.setPrototypeOf(project.readAt, null);
      if (project.readers) Object.setPrototypeOf(project.readers, null);
    }
    return tables;
  }

  /** The projection as JSON text, every map and set written as entry lists. */
  serialize(): string {
    const state: SerializedFold = {
      version: FOLD_VERSION,
      seq: this.#seq,
      projects: [...this.#projects].map(([project, p]) => [
        project,
        {
          ...(p.trackerImport ? { trackerImport: p.trackerImport } : {}),
          ...(p.defaultBranch ? { defaultBranch: p.defaultBranch } : {}),
          readAt: Object.entries(p.readAt),
          readers: Object.entries(p.readers),
          rules: p.rules,
          tickets: [...p.tickets],
          internal: [...p.internal],
          comments: [...p.comments].map(([ticket, comments]) => [ticket, [...comments]]),
          prs: [...p.prs],
          mergedAt: [...p.mergedAt],
          sessions: [...p.sessions],
          claims: [...p.claims],
          inbox: [...p.inbox],
          queue: [...p.queue],
          holds: [...p.holds],
          validations: [...p.validations],
          deliveries: [...p.deliveries],
          deliveryFollowUps: [...p.deliveryFollowUps],
          usage: p.usage.serialize(),
        },
      ]),
    };
    return JSON.stringify(state);
  }

  /** Read `serialize`'s text back; throws on another fold version or any odd shape. */
  static restore(text: string): FoldAccumulator {
    const state: unknown = JSON.parse(text);
    if (!isRecord(state)) throw new Error("fold snapshot is not an object");
    if (state.version !== FOLD_VERSION) throw new Error(`fold snapshot version ${String(state.version)}`);
    if (!Number.isSafeInteger(state.seq) || (state.seq as number) < 0) throw new Error("fold snapshot cursor");
    const accumulator = new FoldAccumulator();
    for (const [project, p] of entries(state.projects, "projects")) {
      if (!isRecord(p)) throw new Error("fold snapshot project is not an object");
      if (!isRecord(p.rules) || typeof p.rules.revision !== "number" || !isRecord(p.rules.value))
        throw new Error("fold snapshot rules are malformed");
      const projection = empty();
      if (p.trackerImport !== undefined) projection.trackerImport = record(p.trackerImport, "trackerImport") as never;
      if (p.defaultBranch !== undefined) projection.defaultBranch = record(p.defaultBranch, "defaultBranch") as never;
      for (const [provider, at] of entries(p.readAt, "readAt")) {
        if (typeof at !== "string") throw new Error("fold snapshot readAt is malformed");
        projection.readAt[provider] = at;
      }
      for (const [provider, usage] of entries(p.readers, "readers"))
        projection.readers[provider] = record(usage, "readers") as ReaderUsage;
      projection.rules = p.rules as RulesState;
      for (const [id, t] of entries(p.tickets, "tickets")) projection.tickets.set(id, record(t, "tickets") as Ticket);
      for (const [id, t] of entries(p.internal, "internal"))
        projection.internal.set(id, record(t, "internal") as EventPayloads["ticket.created"]);
      for (const [ticket, comments] of entries(p.comments, "comments"))
        projection.comments.set(
          ticket,
          new Map(entries(comments, "comments").map(([id, c]) => [id, record(c, "comments") as never])),
        );
      for (const [number, pr] of entries(p.prs, "prs", "number"))
        projection.prs.set(number, record(pr, "prs") as PullRequest);
      for (const [number, merged] of entries(p.mergedAt, "mergedAt", "number"))
        projection.mergedAt.set(number, record(merged, "mergedAt") as never);
      for (const [ticket, draft] of entries(p.sessions, "sessions"))
        projection.sessions.set(ticket, record(draft, "sessions") as unknown as Draft);
      for (const claim of strings(p.claims, "claims")) projection.claims.add(claim);
      for (const [id, item] of entries(p.inbox, "inbox")) projection.inbox.set(id, record(item, "inbox") as InboxItem);
      for (const [id, entry] of entries(p.queue, "queue"))
        projection.queue.set(id, record(entry, "queue") as QueueEntry);
      for (const [id, hold] of entries(p.holds, "holds")) projection.holds.set(id, record(hold, "holds") as Hold);
      for (const [id, v] of entries(p.validations, "validations"))
        projection.validations.set(id, record(v, "validations") as Validation);
      for (const [id, d] of entries(p.deliveries, "deliveries"))
        projection.deliveries.set(id, record(d, "deliveries") as Delivery);
      for (const id of strings(p.deliveryFollowUps, "deliveryFollowUps")) projection.deliveryFollowUps.add(id);
      projection.usage = UsageLedger.restore(p.usage);
      accumulator.#projects.set(project, projection);
    }
    accumulator.#seq = state.seq as number;
    return accumulator;
  }
}

interface SerializedFold {
  version: number;
  seq: number;
  projects: [string, Record<string, unknown>][];
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`fold snapshot ${name} entry is not an object`);
  return value;
};
const strings = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error(`fold snapshot ${name} is not a list of strings`);
  return value;
};
function entries(value: unknown, name: string, key: "number"): [number, unknown][];
function entries(value: unknown, name: string): [string, unknown][];
function entries(value: unknown, name: string, key?: "number"): [string | number, unknown][] {
  if (
    !Array.isArray(value) ||
    value.some((e) => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== (key ?? "string"))
  )
    throw new Error(`fold snapshot ${name} is not a list of entries`);
  return value as [string | number, unknown][];
}

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
    // Checkpoints are read-only here: their fleet fields are schema-decoded
    // below, and projectUsage reads legacy pi documents without retaining them.
    // Unlike the reusable accumulator, this call cannot outlive its input.
    applyEvent(projects, source.kind === "coordinator.checkpoint" ? source : structuredClone(source));
  }
  return projectTables(projects, seq);
}

function applyEvent(projects: Map<string, Projection>, e: FleetEvent): void {
  let p = projects.get(e.project);
  if (!p) {
    p = empty();
    projects.set(e.project, p);
  }
  applyDelivery(p.deliveries, e);
  p.usage.apply(e);
  if (e.kind === "inbox.opened" && e.payload.followUp?.code === "delivery_failed")
    p.deliveryFollowUps.add(e.payload.id);
  switch (e.kind) {
    case "tracker.import-started":
    case "tracker.import-progress":
    case "tracker.import-ended": {
      if (e.kind === "tracker.import-started" || p.trackerImport?.id === e.payload.id) {
        const { source: _source, ...value } = e.payload as typeof e.payload & { source?: string };
        p.trackerImport = value;
      }
      break;
    }
    case "ticket.seen": {
      const t = e.payload;
      if (p.internal.has(t.id)) break;
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
    case "ticket.created": {
      if (p.internal.has(e.payload.id)) break;
      p.internal.set(e.payload.id, e.payload);
      // A prior external observation cannot leave a synthetic tracker session behind.
      if (p.sessions.get(e.payload.id)?.session === `tracker:${e.payload.id}`) p.sessions.delete(e.payload.id);
      break;
    }
    case "ticket.edited": {
      const ticket = p.internal.get(e.payload.ticket);
      if (ticket) p.internal.set(ticket.id, { ...ticket, ...e.payload.patch });
      break;
    }
    case "ticket.commented": {
      if (!p.internal.has(e.payload.ticket)) break;
      const comments = p.comments.get(e.payload.ticket) ?? new Map();
      if (!comments.has(e.payload.id))
        comments.set(e.payload.id, { body: e.payload.body, author: e.actor, at: e.at, seq: e.seq });
      p.comments.set(e.payload.ticket, comments);
      break;
    }
    case "pull-request.opened":
    case "pull-request.conflicting":
    case "pull-request.behind":
    case "pull-request.head-moved":
    case "pull-request.checks-green":
    case "pull-request.checks-red":
    case "pull-request.review-changed":
    case "pull-request.closed":
    case "pull-request.merged":
    case "pull-request.seen": {
      const priorHead =
        p.prs.get(e.payload.number)?.head ?? [...p.prs.values()].findLast((pr) => pr.ticket === e.payload.ticket)?.head;
      if (priorHead !== e.payload.head) clearProgressNotices(p, e.payload.ticket);
      if (e.payload.state === "merged" && p.prs.get(e.payload.number)?.state !== "merged")
        p.mergedAt.set(e.payload.number, { at: e.at, seq: e.seq });
      if (e.kind === "pull-request.merged" && e.payload.mergedAt) {
        const merged = p.mergedAt.get(e.payload.number) ?? { at: e.at, seq: e.seq };
        // Reconciliation may discover yesterday's merge only after a replacement starts.
        p.mergedAt.set(e.payload.number, { ...merged, at: e.payload.mergedAt });
      }
      p.prs.delete(e.payload.number);
      p.prs.set(e.payload.number, { ...e.payload, conflicting: e.payload.state === "open" && e.payload.conflicting });
      break;
    }
    case "review-thread.opened":
    case "review-thread.resolved": {
      const pr = p.prs.get(e.payload.pr);
      if (pr) pr.unresolvedThreads = e.payload.unresolvedThreads;
      break;
    }
    case "session.claimed":
      if (!Number.isSafeInteger(e.payload.generation) || e.payload.generation < 1)
        throw new Error("claim generation must be a positive safe integer");
      // Caller-assigned generations fence even previously unseen delayed claims.
      if (
        !p.claims.has(e.payload.session) &&
        (e.payload.generation > (p.sessions.get(e.payload.ticket)?.generation ?? 0) ||
          (p.sessions.get(e.payload.ticket)?.session === e.payload.session &&
            p.sessions.get(e.payload.ticket)?.claimSeq === undefined &&
            !["released", "merged"].includes(p.sessions.get(e.payload.ticket)?.phase ?? "released")))
      )
        p.sessions.set(e.payload.ticket, {
          ...e.payload,
          claimSeq: e.seq,
          startedAt:
            p.sessions.get(e.payload.ticket)?.session === e.payload.session
              ? (p.sessions.get(e.payload.ticket)?.startedAt ?? e.at)
              : e.at,
          phase: "planning",
          reason: "Claimed",
          at: e.at,
          heartbeat: null,
          earlier: [],
        });
      if (!p.claims.has(e.payload.session) && p.sessions.get(e.payload.ticket)?.session === e.payload.session)
        clearProgressNotices(p, e.payload.ticket);
      p.claims.add(e.payload.session);
      break;
    case "session.reported": {
      const s = active(p, e.payload);
      if (s) {
        if (s.phase !== e.payload.phase || s.reason.trim() !== e.payload.reason.trim())
          clearProgressNotices(p, e.payload.ticket);
        s.earlier.push(s.phase);
        s.phase = e.payload.phase;
        s.reason = e.payload.reason;
        s.at = e.at;
        if (e.payload.stage !== undefined) s.stage = e.payload.stage;
      }
      break;
    }
    case "session.liveness": {
      const s = active(p, e.payload);
      if (
        s &&
        s.generation === e.payload.generation &&
        !["blocked", "awaiting-approval", "awaiting-validation", "ready-to-merge"].includes(s.phase)
      ) {
        p.inbox.set(e.payload.id, {
          id: e.payload.id,
          ticket: s.ticket,
          kind: "liveness",
          actor: e.actor,
          at: e.at,
          seq: e.seq,
          body: `${s.ticket} ${e.payload.verdict}: ${e.payload.summary}; evidence: ${JSON.stringify(e.payload.evidence)}`,
        });
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
        clearProgressNotices(p, e.payload.ticket);
        s.phase = "released";
        s.reason = e.payload.reason;
        s.at = e.at;
      }
      break;
    }
    case "inbox.opened": {
      const prior = p.inbox.get(e.payload.id);
      if (!prior || (e.payload.kind === "follow-up" && prior.kind === "follow-up")) {
        const changedAction =
          prior?.followUp && e.payload.followUp && !sameFollowUpAction(prior.followUp, e.payload.followUp);
        let followUp = e.payload.followUp;
        if (followUp && changedAction) {
          const { toldOwnerAt: _oldReceipt, ...detail } = followUp;
          followUp = detail;
        } else if (followUp && prior?.followUp?.toldOwnerAt)
          followUp = { ...followUp, toldOwnerAt: prior.followUp.toldOwnerAt };
        p.inbox.set(e.payload.id, {
          ...e.payload,
          ...(followUp ? { followUp } : {}),
          at: changedAction ? e.at : (prior?.at ?? e.at),
          actor: e.actor,
          seq: e.seq,
        });
      }
      break;
    }
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
        clearProgressNotices(p, e.payload.ticket);
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
      // THE-2043: launch and claim are distinct; launch progress uses the existing worker checkpoint format.
      const checkpoint = e.payload.checkpoint;
      const format =
        checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) ? checkpoint.format : undefined;
      const launch = format === "armada.worker" ? workerLaunchCheckpointSchema.safeParse(checkpoint) : null;
      if (launch?.success) {
        const l = launch.data;
        const current = p.sessions.get(l.ticket);
        if (
          (!current ||
            l.generation > current.generation ||
            (current.session === l.session && !["released", "merged"].includes(current.phase))) &&
          !p.claims.has(l.session)
        )
          p.sessions.set(l.ticket, {
            ticket: l.ticket,
            launchSeq: current?.session === l.session ? current.launchSeq : e.seq,
            startedAt: current?.session === l.session ? current.startedAt : e.at,
            session: l.session,
            generation: l.generation,
            runtime: l.runtime,
            handle: l.handle ?? "",
            owner: e.actor,
            phase: "planning",
            at: e.at,
            heartbeat: null,
            earlier: [],
            reason: {
              preparing: "Preparing workspace",
              starting: "Starting worker CLI",
              launched: "Launched; waiting for worker claim",
            }[l.step],
          });
      }
      const usage = format === "armada.linear-reader" ? linearUsageCheckpoint.safeParse(checkpoint) : null;
      if (usage?.success) p.readers.linear = usage.data.usage;
      const reading = format === "armada.readers" ? readerCheckpoint.safeParse(checkpoint) : null;
      if (reading?.success && !reading.data.failures && Number.isFinite(Date.parse(e.at)))
        p.readAt[reading.data.provider] = e.at;
      const rules = checkpointRules(e.payload.checkpoint);
      if (rules) p.rules = rules;
      break;
    }
    case "coordinator.message":
      break;
    case "default-branch.seen":
      p.defaultBranch = e.payload;
      break;
  }
  recoverFollowUps(p.inbox, e, p.sessions);
}

function projectTables(projects: Map<string, Projection>, seq: number): FleetTables {
  const tables: FleetTables = { seq, projects: Object.create(null) };
  for (const [project, p] of projects) {
    // A local view: the projection keeps only observed tickets, so a reading
    // resumed from a snapshot lists tickets in the same order as a full replay.
    const tickets = new Map(p.tickets);
    for (const t of p.internal.values()) {
      const labelPhase =
        t.labels.map((label) => phaseSchema.safeParse(label)).find((result) => result.success)?.data ?? null;
      const phase = t.state === "completed" ? "merged" : t.state === "canceled" ? "released" : labelPhase;
      tickets.set(t.id, {
        id: t.id,
        title: t.title,
        description: t.description,
        labels: t.labels,
        status: t.state,
        phase,
        parent: t.parent,
        ...(t.url !== undefined ? { url: t.url } : {}),
        ...(t.source !== undefined ? { source: t.source } : {}),
        blockers: t.blockers.map((id) => ({
          id,
          status: p.internal.get(id)?.state ?? tickets.get(id)?.status ?? "unstarted",
        })),
        comments: [...(p.comments.get(t.id)?.values() ?? [])]
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq)
          .slice(0, 12)
          .map(({ body, author, at }) => ({ body, author, at })),
      });
    }
    const sessions = [...p.sessions.values()].map((s): Session => {
      const pr = [...p.prs.values()].reverse().find(
        (pr) =>
          pr.ticket === s.ticket &&
          pr.state !== "closed" &&
          // Re-observing an old merge cannot end a later worker generation.
          !(
            pr.state === "merged" &&
            (s.claimSeq ?? s.launchSeq) !== undefined &&
            ((p.mergedAt.get(pr.number)?.seq ?? 0) < (s.claimSeq ?? s.launchSeq ?? 0) ||
              (s.startedAt !== undefined && Date.parse(p.mergedAt.get(pr.number)?.at ?? "") < Date.parse(s.startedAt)))
          ),
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
        title: tickets.get(s.ticket)?.title ?? s.ticket,
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
    const usage = p.usage.usage(p.rules.value.policy?.budget?.zone ?? "UTC");
    const deliveries = [...p.deliveries.values()].filter(
      (d) =>
        !d.sentAt &&
        sessions.some(
          (s) =>
            s.ticket === d.ticket &&
            s.session === d.session &&
            s.generation === d.generation &&
            !["released", "merged"].includes(s.phase),
        ),
    );
    const failures: InboxItem[] = deliveries.flatMap((d) => {
      const session = sessions.find(
        (s) => s.ticket === d.ticket && s.session === d.session && s.generation === d.generation,
      );
      return d.failureSeq !== undefined &&
        !p.deliveryFollowUps.has(deliveryFollowUpId(d.id)) &&
        session &&
        !["released", "merged"].includes(session.phase)
        ? [
            {
              id: `delivery:${d.id}`,
              ticket: d.ticket,
              kind: "delivery-failed" as const,
              body: `${d.source === "owner-answer" ? "Answer" : "Message"} not delivered to ${d.ticket}: ${d.error}`,
              at: d.failedAt!,
              actor: "delivery",
              seq: d.failureSeq,
            },
          ]
        : [];
    });
    tables.projects[project] = {
      ...(p.defaultBranch ? { defaultBranch: p.defaultBranch } : {}),
      rules: p.rules,
      ...(p.trackerImport ? { trackerImport: p.trackerImport } : {}),
      ...(usage.days.length ? { usage } : {}),
      ...(Object.keys(p.readers).length ? { readers: p.readers } : {}),
      ...(Object.keys(p.readAt).length ? { readAt: p.readAt } : {}),
      tickets: [...tickets.values()],
      pullRequests: [...p.prs.values()],
      sessions,
      sessionsByState,
      inbox: [...p.inbox.values(), ...failures].sort((a, b) => a.seq - b.seq),
      ...(p.deliveries.size ? { deliveries } : {}),
      queue: [...p.queue.values()],
      holds: [...p.holds.values()],
      validations: [...p.validations.values()],
    };
  }
  return tables;
}
