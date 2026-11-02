import { createHash } from "node:crypto";
import type { ProjectTables, Session, WakeCandidate } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { FleetEvent } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { maskedTail, type ProgressJudge, verdictSchema } from "../src/liveness/judge.ts";
import { type ProgressSignals, progressSignals, progressSummary, type Report } from "../src/liveness/progress.ts";
import type { EventStore } from "../src/store.ts";
import { factsHash, followUpEvent, readWakeEvidence, type WakeEvidence, wakeEvidenceCheckpoint } from "./follow-ups.ts";
import { forgeWakeups } from "./forge-wake.ts";

/** Reserved host entry metadata distinguishes a wake from owner-written text. */
export const WAKE_ENTRY = "armada.fleet-wake";
export interface ProgressWatch {
  judge: ProgressJudge;
  transcript: (session: Session) => Promise<string>;
}
export interface WakeReading {
  tables: ProjectTables | undefined;
  /** Source evidence preserves transient outcomes/actors that the open tables do not retain. */
  events: readonly FleetEvent[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Only typed identities cross this boundary. Never copy free-form bodies, reasons or provider errors.
const ticketId = (value: string | undefined) =>
  value && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value) ? value : undefined;
const sha = (value: string | undefined) => (value && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : undefined);
const identity = (value: string) => (/^[\w:./@-]{1,250}$/.test(value) ? value : `ref:${hash(value)}`);
const active = (tables: ProjectTables | undefined, ticket: string) =>
  tables?.sessions.some((s) => s.ticket === ticket && !["released", "merged"].includes(s.phase));
const prFacts = (tables: ProjectTables | undefined, ticket: string) => {
  const pr = tables?.pullRequests.find((p) => p.ticket === ticket && p.state !== "closed");
  return { ...(pr ? { pr: pr.number, head: sha(pr.head) } : {}), ticket: ticketId(ticket) };
};
const generationStart = (events: readonly FleetEvent[], session: Session | undefined): number => {
  if (!session) return 0;
  const claim = events.findLast(
    (e) =>
      e.kind === "session.claimed" &&
      e.payload.session === session.session &&
      e.payload.generation === session.generation,
  );
  const launch = events.find((e) => {
    const c = e.kind === "coordinator.checkpoint" ? e.payload.checkpoint : null;
    return (
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      c.format === "armada.worker" &&
      c.session === session.session &&
      c.generation === session.generation &&
      (c.type === "launch-intent" || c.type === "launch")
    );
  });
  return claim?.seq ?? launch?.seq ?? 0;
};

const bootId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function recoveryBoot(events: readonly FleetEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
    if (
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      c.format === "armada.worker" &&
      c.version === 1 &&
      c.type === "recovery" &&
      bootId(c.boot)
    )
      return c.boot;
  }
  for (const event of [...events].reverse())
    if ((event.kind === "worker.readopted" || event.kind === "worker.lost") && bootId(event.payload.boot))
      return event.payload.boot;
  return undefined;
}
function recoveryNames(tickets: string[]): string {
  const names: string[] = [];
  for (const ticket of tickets) {
    const name = ticketId(ticket);
    if (!name || names.join(", ").length + name.length > 90) break;
    names.push(name);
  }
  return `${names.join(", ")}${tickets.length > names.length ? `${names.length ? ", " : ""}+${tickets.length - names.length} more` : ""}`;
}

/** Pure fleet transitions. Callers may replay the same reading; keys stay stable. */
export function wakeups(before: WakeReading, after: WakeReading): WakeCandidate[] {
  const out = new Map<string, WakeCandidate>();
  const add = (key: string, summary: string, facts: WakeCandidate["facts"]) => out.set(key, { key, summary, facts });
  for (const candidate of forgeWakeups(before.tables, after.tables)) out.set(candidate.key, candidate);
  const priorSeq = before.events.at(-1)?.seq ?? 0;
  const boot = recoveryBoot(after.events);
  const recovered = after.events.filter(
    (event): event is Extract<FleetEvent, { kind: "worker.readopted" | "worker.lost" }> =>
      (event.kind === "worker.readopted" || event.kind === "worker.lost") && event.payload.boot === boot,
  );
  if (boot && recovered.some((event) => event.seq > priorSeq)) {
    const current = recovered.filter((event) =>
      after.tables?.sessions.some(
        (session) =>
          session.session === event.payload.session &&
          session.generation === event.payload.generation &&
          !["released", "merged"].includes(session.phase),
      ),
    );
    const adopted = current.filter((event) => event.kind === "worker.readopted").map((event) => event.payload.ticket);
    const lost = current.filter((event) => event.kind === "worker.lost").map((event) => event.payload.ticket);
    const needsBrief = current
      .filter((event) => event.kind === "worker.readopted" && event.payload.briefPending)
      .map((event) => event.payload.ticket);
    if (current.length)
      add(
        `recovery:${boot}`,
        `${adopted.length} worker${adopted.length === 1 ? "" : "s"} re-adopted${adopted.length ? ` (${recoveryNames(adopted)})` : ""}; ${lost.length} worker${lost.length === 1 ? "" : "s"} lost${lost.length ? ` (${recoveryNames(lost)})` : ""}${needsBrief.length ? `; needs initial brief: ${recoveryNames(needsBrief)}` : ""}`,
        { item: boot, state: "recovery" },
      );
  }

  for (const item of after.tables?.inbox ?? []) {
    if (before.tables?.inbox.some((i) => i.id === item.id) || ["owner-request", "follow-up"].includes(item.kind))
      continue;
    const handedBack = item.kind === "hand-back" ? item.body.match(/\bPR #(\d+), head ([a-f0-9]{40})\b/i) : null;
    const facts = {
      ...prFacts(after.tables, item.ticket),
      ...(handedBack && Number.isSafeInteger(Number(handedBack[1]))
        ? { pr: Number(handedBack[1]), head: handedBack[2]!.toLowerCase() }
        : {}),
      item: identity(item.id),
      state: item.kind,
    };
    const pr = facts.pr ? ` #${facts.pr}${facts.head ? ` at ${facts.head.slice(0, 8)}` : ""}` : "";
    const judged =
      item.kind === "liveness" && after.events.some((e) => e.kind === "session.liveness" && e.payload.id === item.id);
    add(
      `inbox:${identity(item.id)}`,
      judged
        ? maskedTail(item.body)
            .replace(/\p{Cc}/gu, " ")
            .slice(0, 800)
        : `${item.kind}${facts.ticket ? ` ${facts.ticket}` : ""}${pr}`,
      facts,
    );
  }
  for (const pr of after.tables?.pullRequests ?? []) {
    const prior = before.tables?.pullRequests.find((p) => p.number === pr.number);
    if (!active(before.tables, pr.ticket) && !active(after.tables, pr.ticket)) continue;
    const facts = { pr: pr.number, ticket: ticketId(pr.ticket), head: sha(pr.head) };
    if (pr.state === "merged" && prior?.state !== "merged")
      add(`merged:${pr.number}@${sha(pr.head) ?? hash(pr.head)}`, `merged ${facts.ticket ?? ""} #${pr.number}`, {
        ...facts,
        state: "merged",
      });
    else if (
      pr.state === "open" &&
      ["success", "failure"].includes(pr.ci) &&
      (prior?.ci !== pr.ci || prior.head !== pr.head)
    )
      add(
        `checks:${pr.number}@${sha(pr.head) ?? hash(pr.head)}:${pr.ci}`,
        `checks ${pr.ci === "success" ? "green" : "red"} ${facts.ticket ?? ""} #${pr.number}`,
        { ...facts, state: pr.ci },
      );
  }
  for (const validation of after.tables?.validations ?? []) {
    if (!validation.decision || before.tables?.validations.some((v) => v.id === validation.id && v.decision)) continue;
    const current = after.tables?.sessions.find((s) => s.ticket === validation.ticket);
    if (current && current.session !== validation.session) continue;
    add(
      `decision:${identity(validation.id)}`,
      `owner decided ${ticketId(validation.ticket) ?? "validation"}: ${validation.decision.decision}`,
      { item: identity(validation.id), ticket: ticketId(validation.ticket), state: validation.decision.decision },
    );
  }
  for (const e of after.events) {
    if (e.seq <= priorSeq) continue;
    if (e.kind === "inbox.answered" && e.actor === "owner") {
      const item = [...before.events, ...after.events].find(
        (i) => i.kind === "inbox.opened" && i.payload.id === e.payload.id,
      );
      const current = after.tables?.sessions.find(
        (s) => s.ticket === (item?.kind === "inbox.opened" ? item.payload.ticket : ""),
      );
      const start = generationStart(after.events, current);
      if (
        item?.kind === "inbox.opened" &&
        ["owner-request", "question", "plan"].includes(item.payload.kind) &&
        item.seq >= start
      )
        add(`owner-answer:${identity(e.payload.id)}`, `owner answered ${ticketId(item.payload.ticket) ?? "question"}`, {
          item: identity(e.payload.id),
          ticket: ticketId(item.payload.ticket),
          state: "answered",
        });
    } else if (e.kind === "merge.refused") {
      const queue = before.tables?.queue.find((q) => q.id === e.payload.id);
      const facts = {
        item: identity(e.payload.id),
        pr: e.payload.pr ?? queue?.pr,
        ticket: ticketId(e.payload.ticket ?? queue?.ticket),
        head: sha(e.payload.head ?? queue?.head),
        state: "refused",
      };
      add(`merge-refused:${identity(e.payload.id)}`, `merge refused${facts.pr ? ` #${facts.pr}` : ""}`, facts);
    } else if (e.kind === "merge.confirmed") {
      add(
        `merged:${e.payload.pr}@${sha(e.payload.head) ?? hash(e.payload.head)}`,
        `merged ${ticketId(e.payload.ticket) ?? ""} #${e.payload.pr}`,
        {
          ticket: ticketId(e.payload.ticket),
          pr: e.payload.pr,
          head: sha(e.payload.head),
          state: "merged",
        },
      );
    } else if ((e.kind === "hold.opened" || e.kind === "hold.cleared") && e.actor !== "coordinator") {
      const wasOpen = before.tables?.holds.some((h) => h.id === e.payload.id) ?? false;
      const isOpen = after.tables?.holds.some((h) => h.id === e.payload.id) ?? false;
      if (wasOpen === isOpen) continue;
      add(`hold:${identity(e.payload.id)}:${e.kind}`, `hold ${e.kind === "hold.opened" ? "added" : "cleared"}`, {
        hold: identity(e.payload.id),
        state: e.kind === "hold.opened" ? "open" : "cleared",
      });
    }
  }
  const branch = after.tables?.defaultBranch;
  const prior = before.tables?.defaultBranch;
  if (
    branch &&
    (prior?.ci !== branch.ci || prior.branch !== branch.branch || prior.head !== branch.head) &&
    (prior || branch.ci === "failure")
  ) {
    const name = /^[\w./-]{1,200}$/.test(branch.branch) ? branch.branch : "default branch";
    add(
      `branch:${name}@${sha(branch.head) ?? hash(branch.head)}:${branch.ci}`,
      `${name} ${branch.ci === "failure" ? "red" : branch.ci === "success" ? "green" : branch.ci}`,
      { branch: name, head: sha(branch.head), state: branch.ci },
    );
  }
  return [...out.values()];
}

export interface WakeClock {
  now(): number;
  setTimer(callback: () => void, delay: number): () => void;
}
const realClock: WakeClock = {
  now: Date.now,
  setTimer(callback, delay) {
    const timer = setTimeout(callback, Math.min(delay, 2_147_483_647));
    timer.unref();
    return () => clearTimeout(timer);
  },
};
type WakeEvent = Extract<FleetEvent, { kind: "coordinator.wakeup" }>;
const contentOf = (candidates: readonly WakeCandidate[]) => {
  const lines: string[] = [];
  let size = 0;
  for (const candidate of candidates.slice(0, 20)) {
    const line = `- ${candidate.summary}; ${JSON.stringify(candidate.facts)}`;
    if (size + line.length > 12 * 1024) break;
    lines.push(line);
    size += line.length;
  }
  return `Fleet wake-up:\n${lines.join("\n")}${candidates.length > lines.length ? `\n- ${candidates.length - lines.length} more changes; read fleet.status and inbox.list for the full reading.` : ""}\nRead current fleet/inbox facts before acting. End silently if nothing needs doing.`;
};
export const wakeBody = (candidates: readonly WakeCandidate[]) =>
  `Woke: ${candidates
    .slice(0, 3)
    .map((c) => c.summary)
    .join("; ")
    .slice(0, 500)}${candidates.length > 3 ? `; ${candidates.length - 3} more changes` : ""}`;

/** One project subscriber and durable outbox. pi's requestId closes the append/submit crash gap. */
export class Waker {
  readonly #store: EventStore;
  readonly #project: string;
  readonly #conversation: Pick<Conversation, "submit">;
  readonly #clock: WakeClock;
  readonly #progress?: ProgressWatch;
  readonly #attempts = new Map<string, number>();
  readonly #judging = new Map<string, { abort: AbortController; done: Promise<void> }>();
  readonly #seen = new Set<string>();
  readonly #evidence = new Map<string, WakeEvidence>();
  readonly #pending = new Map<string, WakeCandidate>();
  readonly #outbox = new Map<string, WakeEvent>();
  readonly #delivered = new Set<string>();
  readonly #events: FleetEvent[] = [];
  #reading: WakeReading = { tables: undefined, events: [] };
  #cursor = 0;
  #scanning = false;
  #closed = false;
  #cancelBatch?: () => void;
  #cancelRetry?: () => void;
  #cancelQuiet?: () => void;
  #cancelLiveness?: () => void;
  #sending?: Promise<void>;
  #lastWake = 0;
  readonly #unsubscribe: () => void;

  constructor(options: {
    store: EventStore;
    project: string;
    conversation: Pick<Conversation, "submit">;
    clock?: WakeClock;
    now?: () => number;
    progress?: ProgressWatch;
  }) {
    this.#store = options.store;
    this.#project = options.project;
    this.#conversation = options.conversation;
    this.#progress = options.progress;
    this.#clock = options.clock ?? { ...realClock, now: options.now ?? Date.now };
    // Learn all persisted keys before replaying transitions, including old resolved inbox items.
    for (const e of this.#store.readSince(0, this.#project)) this.#record(e);
    this.#unsubscribe = this.#store.subscribe(() => this.#scan());
    this.#scan();
  }

  #record(e: FleetEvent) {
    const evidence = readWakeEvidence(e);
    if (evidence && evidence.seq >= (this.#evidence.get(evidence.key)?.seq ?? 0))
      this.#evidence.set(evidence.key, evidence);
    const c = e.kind === "coordinator.checkpoint" ? e.payload.checkpoint : null;
    if (
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      c.format === "armada.watchdog" &&
      c.version === 1 &&
      typeof c.session === "string" &&
      typeof c.generation === "number"
    )
      this.#attempts.set(`${c.session}@${c.generation}`, Date.parse(e.at));
    if (e.kind === "coordinator.wakeup") {
      this.#lastWake = Math.max(this.#lastWake, Date.parse(e.at));
      for (const candidate of e.payload.candidates)
        if (!this.#evidence.has(candidate.key))
          this.#evidence.set(candidate.key, {
            key: candidate.key,
            factsHash: factsHash(candidate),
            wokeAt: Date.parse(e.at),
            attempts: 1,
            totalAttempts: 1,
            seq: e.seq,
          });
      for (const key of e.payload.keys) {
        this.#seen.add(key);
        this.#pending.delete(key);
      }
      if (!this.#delivered.has(e.payload.id)) this.#outbox.set(e.payload.id, e);
    } else if (e.kind === "coordinator.wakeup-delivered") {
      this.#delivered.add(e.payload.id);
      this.#outbox.delete(e.payload.id);
    }
  }

  #needsFollowUp(candidate: WakeCandidate, evidence: WakeEvidence) {
    return (
      evidence.attempts >= 3 ||
      this.#reading.tables?.inbox.some((i) => i.kind === "follow-up" && i.followUp?.candidate === candidate.key)
    );
  }

  #wakeFollowUp(candidate: WakeCandidate, evidence: WakeEvidence, at: string) {
    const session = this.#reading.tables?.sessions.find((s) => s.ticket === candidate.facts.ticket);
    return followUpEvent(
      this.#events,
      this.#project,
      at,
      candidate.facts.ticket ?? "",
      {
        candidate: candidate.key,
        code: "repeated_wake",
        reason: "Wake candidate repeated without new evidence",
        facts: candidate.summary,
        next: "inspect the block with fleet.status and inbox.list; resolve it or answer with a reason",
        ...(candidate.facts.pr ? { pr: candidate.facts.pr } : {}),
        ...(candidate.facts.head ? { head: candidate.facts.head } : {}),
        ...(session
          ? {
              session: session.session,
              generation: session.generation,
              ...(session.phase === "ready-to-merge" ? { readyToMerge: true } : {}),
            }
          : {}),
      },
      evidence.totalAttempts,
    );
  }

  /** Separate from scanning so an incremental fold can feed the same evidence policy. */
  #considerEvidence(candidate: WakeCandidate, seq: number) {
    if (candidate.key.startsWith("recovery:") && this.#seen.has(candidate.key)) return;
    const prior = this.#evidence.get(candidate.key);
    if (prior && seq <= prior.seq) return;
    const now = this.#clock.now();
    const pending = this.#pending.has(candidate.key);
    const same = prior && prior.factsHash === factsHash(candidate) && now - prior.wokeAt < 3_600_000;
    const evidence: WakeEvidence = {
      key: candidate.key,
      factsHash: factsHash(candidate),
      wokeAt: same ? prior.wokeAt : now,
      attempts: same ? prior.attempts + (candidate.key.startsWith("recovery:") ? 0 : 1) : 1,
      totalAttempts: prior ? prior.totalAttempts + (candidate.key.startsWith("recovery:") ? 0 : 1) : 1,
      seq,
    };
    this.#evidence.set(candidate.key, evidence);
    // Pending facts and their history are committed atomically by #flush, even after coalescing.
    if (pending || !same) {
      this.#pending.set(candidate.key, candidate);
      return;
    }
    const at = new Date(now).toISOString();
    this.#store.appendMany([
      wakeEvidenceCheckpoint(this.#project, at, evidence),
      ...(this.#needsFollowUp(candidate, evidence) ? [this.#wakeFollowUp(candidate, evidence, at)] : []),
    ]);
  }

  #scan() {
    if (this.#closed || this.#scanning) return;
    this.#scanning = true;
    try {
      for (const e of this.#store.readSince(this.#cursor, this.#project)) {
        this.#cursor = e.seq;
        this.#record(e);
        // Chat bodies cannot change fleet state or wake evidence. Replaying them
        // through every growing prefix makes a chat-heavy boot quadratic.
        if (e.kind === "coordinator.message" || e.kind.startsWith("coordinator.wakeup")) continue;
        if (e.kind === "coordinator.checkpoint") {
          const c = e.payload.checkpoint;
          if (
            !c ||
            typeof c !== "object" ||
            Array.isArray(c) ||
            !["armada.worker", "armada.tools", "armada.watchdog"].includes(String(c.format))
          )
            continue;
        }
        this.#events.push(e);
        const next = { tables: fold(this.#events).projects[this.#project], events: [...this.#events] };
        for (const candidate of wakeups(this.#reading, next)) this.#considerEvidence(candidate, e.seq);
        this.#reading = next;
      }
      // Keep only this boot's recovery batch when replaying older undelivered history.
      const boot = recoveryBoot(this.#events);
      for (const key of this.#pending.keys())
        if (key.startsWith("recovery:") && key !== `recovery:${boot}`) this.#pending.delete(key);
      // An item resolved during coalescing no longer needs a new turn.
      for (const [key, candidate] of this.#pending)
        if (
          key.startsWith("inbox:") &&
          !this.#reading.tables?.inbox.some((i) => identity(i.id) === candidate.facts.item)
        )
          this.#pending.delete(key);
      if (!this.#pending.size) {
        this.#cancelBatch?.();
        this.#cancelBatch = undefined;
      }
      if (this.#pending.size && !this.#cancelBatch)
        this.#cancelBatch = this.#clock.setTimer(() => {
          this.#cancelBatch = undefined;
          this.#flush();
        }, 10_000);
      this.#quiet();
      this.#liveness();
    } finally {
      this.#scanning = false;
    }
    this.#pump();
  }

  #flush(reminder = false) {
    if (this.#closed || !this.#pending.size) return;
    const candidates = [...this.#pending.values()].sort(
      (a, b) => Number(b.key.startsWith("recovery:")) - Number(a.key.startsWith("recovery:")),
    );
    const keys = candidates.map((c) => c.key);
    const id = `fleet-wake:${hash(JSON.stringify(candidates.map((c) => [c.key, factsHash(c), this.#evidence.get(c.key)?.wokeAt])))}`;
    const at = new Date(this.#clock.now()).toISOString();
    this.#store.appendMany([
      ...candidates.flatMap((c) => {
        const evidence = this.#evidence.get(c.key);
        return evidence
          ? [
              wakeEvidenceCheckpoint(this.#project, at, evidence),
              ...(this.#needsFollowUp(c, evidence) ? [this.#wakeFollowUp(c, evidence, at)] : []),
            ]
          : [];
      }),
      {
        project: this.#project,
        actor: "daemon",
        at,
        kind: "coordinator.wakeup",
        payload: { id, keys, candidates, ...(reminder ? { reminder: true } : {}) },
      },
    ]);
  }

  #pump() {
    const boot = recoveryBoot(this.#events);
    const recoveryKey = boot ? `recovery:${boot}` : undefined;
    // Submit this boot's coalesced recovery wake before replaying older outbox entries.
    if (recoveryKey && this.#pending.has(recoveryKey)) return;
    if (this.#closed || this.#sending || this.#cancelRetry || !this.#outbox.size) return;
    this.#sending = Promise.resolve()
      .then(async () => {
        const outbox = [...this.#outbox].sort(
          (a, b) =>
            Number(!!recoveryKey && b[1].payload.keys.includes(recoveryKey)) -
            Number(!!recoveryKey && a[1].payload.keys.includes(recoveryKey)),
        );
        for (const [id, e] of outbox) {
          if (this.#closed) break;
          await this.#conversation.submit(
            {
              type: "input",
              content: contentOf(e.payload.candidates),
              requestId: id,
              whenBusy: "steer",
              entry: { kind: WAKE_ENTRY, data: { body: wakeBody(e.payload.candidates) } },
            },
            context,
          );
          this.#store.append({
            project: this.#project,
            actor: "daemon",
            at: new Date(this.#clock.now()).toISOString(),
            kind: "coordinator.wakeup-delivered",
            payload: { id },
          });
        }
      })
      .catch(() => {
        if (!this.#closed)
          this.#cancelRetry = this.#clock.setTimer(() => {
            this.#cancelRetry = undefined;
            this.#pump();
          }, 10_000);
      })
      .finally(() => {
        this.#sending = undefined;
        if (!this.#cancelRetry) this.#pump();
      });
  }

  #quiet() {
    this.#cancelQuiet?.();
    this.#cancelQuiet = undefined;
    const tables = this.#reading.tables;
    const items = (tables?.inbox ?? []).filter((i) => i.kind !== "follow-up");
    const policy = tables?.rules?.value.policy;
    const minutes = policy?.coordinatorMinutes ?? 10;
    if (!items.length || minutes === 0 || this.#pending.size) return;
    const oldest = Math.min(...items.map((i) => Date.parse(i.at)));
    const due = Math.max(oldest + minutes * 60_000, this.#lastWake + (policy?.quietMinutes ?? 45) * 60_000);
    this.#cancelQuiet = this.#clock.setTimer(
      () => {
        this.#cancelQuiet = undefined;
        if (this.#clock.now() < due) return this.#quiet();
        const overdue =
          this.#reading.tables?.inbox.filter(
            (i) => i.kind !== "follow-up" && this.#clock.now() - Date.parse(i.at) >= minutes * 60_000,
          ) ?? [];
        if (!overdue.length) return this.#quiet();
        for (const item of overdue) {
          const key = `reminder:${hash(JSON.stringify([due, item.id]))}`;
          this.#pending.set(key, {
            key,
            summary: `nothing new; ${item.kind} ${ticketId(item.ticket) ?? ""} still unanswered`,
            facts: { item: identity(item.id), ticket: ticketId(item.ticket), state: "unanswered" },
          });
        }
        this.#flush(true);
      },
      Math.max(1, due - this.#clock.now()),
    );
  }

  #liveness() {
    this.#cancelLiveness?.();
    this.#cancelLiveness = undefined;
    const tables = this.#reading.tables;
    if (!tables) return;
    const desired = new Map<string, { ticket: string; kind: "silent" | "stopped" | "not-started"; due: number }>();
    for (const s of tables.sessions) {
      if (["released", "merged"].includes(s.phase) || s.runtime === "tracker") continue;
      const observation = this.#events.findLast(
        (e) =>
          e.kind === "session.runtime-observed" &&
          e.payload.session === s.session &&
          e.payload.generation === s.generation,
      );
      const stopped =
        observation?.kind === "session.runtime-observed" && ["stopped", "failed"].includes(observation.payload.state);
      const claim = this.#events.findLast((e) => e.kind === "session.claimed" && e.payload.session === s.session);
      const claimed = !!claim;
      const start = generationStart(this.#events, s);
      const answers = this.#events.filter(
        (e) =>
          e.kind === "inbox.answered" &&
          e.actor !== "daemon" &&
          this.#events.some(
            (i) =>
              i.kind === "inbox.opened" &&
              i.payload.id === e.payload.id &&
              i.payload.ticket === s.ticket &&
              i.seq >= start,
          ),
      );
      const reported =
        this.#events.findLast((e) => e.kind === "session.reported" && e.payload.session === s.session)?.seq ?? start;
      const decisions = this.#events.filter(
        (e) =>
          e.kind === "validation.decided" &&
          tables.validations.some((v) => v.id === e.payload.id && v.session === s.session),
      );
      const answered =
        s.phase === "awaiting-validation"
          ? decisions.some((e) => e.seq > reported)
          : answers.some((e) => {
              if (e.kind !== "inbox.answered" || e.seq <= reported) return false;
              const item = this.#events.find((i) => i.kind === "inbox.opened" && i.payload.id === e.payload.id);
              return (
                item?.kind === "inbox.opened" &&
                (s.phase === "awaiting-approval"
                  ? item.payload.kind === "plan"
                  : ["question", "owner-request"].includes(item.payload.kind))
              );
            });
      if (!stopped && !answered && ["awaiting-approval", "awaiting-validation", "blocked"].includes(s.phase)) continue;
      const last = Math.max(
        Date.parse(s.at),
        Date.parse(s.heartbeat ?? s.at),
        ...answers.map((e) => Date.parse(e.at)),
        ...decisions.map((e) => Date.parse(e.at)),
      );
      const kind = stopped ? "stopped" : claimed ? "silent" : "not-started";
      const due = stopped
        ? Date.parse(observation!.at)
        : last +
          (claimed
            ? (tables.rules?.value.policy?.silenceMinutes ?? 15)
            : (tables.rules?.value.policy?.notStartedMinutes ?? 10)) *
            60_000;
      const id = `notice:${kind}:${identity(s.session)}@${stopped ? observation!.seq : last}`;
      desired.set(id, { ticket: s.ticket, kind, due });
    }
    const now = this.#clock.now();
    const notices = tables.inbox.filter(
      (i) => i.kind !== "liveness" && i.id.startsWith("notice:") && i.actor === "daemon",
    );
    const additions = [...desired].filter(
      ([id, d]) => d.due <= now && !this.#events.some((e) => e.kind === "inbox.opened" && e.payload.id === id),
    );
    const removals = notices.filter((i) => !desired.has(i.id));
    const future = [...desired.values()].filter((d) => d.due > now).map((d) => d.due);
    const progress = this.#progressPlan();
    future.push(...progress.map((p) => p.due));
    if (!additions.length && !removals.length && !future.length) return;
    const due = additions.length || removals.length ? now : Math.min(...future);
    this.#cancelLiveness = this.#clock.setTimer(
      () => {
        this.#cancelLiveness = undefined;
        for (const item of removals)
          this.#store.append({
            project: this.#project,
            actor: "daemon",
            at: new Date(this.#clock.now()).toISOString(),
            kind: "inbox.answered",
            payload: { id: item.id, answer: "Notice superseded by current worker facts" },
          });
        for (const [id, item] of additions)
          this.#store.append({
            project: this.#project,
            actor: "daemon",
            at: new Date(this.#clock.now()).toISOString(),
            kind: "inbox.opened",
            payload: {
              id,
              ticket: item.ticket,
              kind: item.kind,
              body: `Worker ${item.kind}; inspect current generation before acting`,
            },
          });
        for (const item of progress) if (item.due <= this.#clock.now() && item.signals.level >= 1) this.#judge(item);
        this.#scan();
      },
      Math.max(1, due - now),
    );
  }

  #progressPlan(): { session: Session; signals: ProgressSignals; id: string; due: number }[] {
    if (!this.#progress) return [];
    const now = this.#clock.now();
    const policy = this.#reading.tables?.rules?.value.policy;
    const reports = this.#events.filter((e): e is Report => e.kind === "session.reported");
    return (this.#reading.tables?.sessions ?? []).flatMap((session) => {
      if (
        ["released", "merged", "blocked", "awaiting-approval", "awaiting-validation", "ready-to-merge"].includes(
          session.phase,
        ) ||
        session.runtime === "tracker" ||
        this.#judging.has(session.session)
      )
        return [];
      const signals = progressSignals(session, reports, this.#events, now, policy);
      const id = `notice:liveness:${identity(session.session)}@${signals.episode}:${signals.level}`;
      const already = this.#events.some((e) => e.kind === "session.liveness" && e.payload.id === id);
      const last = this.#attempts.get(`${session.session}@${session.generation}`) ?? -Infinity;
      const cadence = (policy?.silenceMinutes ?? 15) * 60_000;
      return [
        { session, signals, id, due: Math.max(last + cadence, signals.level >= 1 && !already ? now : signals.nextAt) },
      ];
    });
  }

  #judge(item: { session: Session; signals: ProgressSignals; id: string }) {
    if (this.#closed || !this.#progress || this.#judging.has(item.session.session)) return;
    if (this.#events.some((e) => e.kind === "session.liveness" && e.payload.id === item.id)) return;
    const { session, signals, id } = item;
    // A refused disk write must still back off in this process; never call the model without a durable attempt.
    this.#attempts.set(`${session.session}@${session.generation}`, this.#clock.now());
    const abort = new AbortController();
    let cancelDeadline = () => {};
    const deadline = new Promise<never>((_, reject) => {
      const cancel = () => {
        abort.abort();
        reject(new Error("Watchdog cancelled"));
      };
      cancelDeadline = this.#clock.setTimer(cancel, 30_000);
      abort.signal.addEventListener("abort", () => reject(new Error("Watchdog cancelled")), { once: true });
    });
    const done = Promise.resolve()
      .then(async () => {
        this.#store.append({
          project: this.#project,
          actor: "daemon",
          at: new Date(this.#clock.now()).toISOString(),
          kind: "coordinator.checkpoint",
          payload: {
            checkpoint: {
              format: "armada.watchdog",
              version: 1,
              session: session.session,
              generation: session.generation,
              episode: signals.episode,
              level: signals.level,
            },
          },
        });
        const policy = this.#reading.tables?.rules?.value.policy;
        const selection = policy?.watchdogModel;
        const reports = this.#events
          .filter((e): e is Report => e.kind === "session.reported" && e.payload.session === session.session)
          .slice(-3);
        const work = async () => {
          const tail = maskedTail(await this.#progress!.transcript(session));
          abort.signal.throwIfAborted();
          return this.#progress!.judge(
            signals,
            tail,
            reports,
            selection ? { provider: selection.provider, modelId: selection.model } : undefined,
            abort.signal,
          );
        };
        const verdict = verdictSchema.parse(await Promise.race([work(), deadline]));
        if (this.#closed || abort.signal.aborted || !["looping", "drifting"].includes(verdict.verdict)) return;
        const current = this.#reading.tables?.sessions.find(
          (s) => s.session === session.session && s.generation === session.generation,
        );
        if (!current) return;
        const fresh = progressSignals(
          current,
          this.#events.filter((e): e is Report => e.kind === "session.reported"),
          this.#events,
          this.#clock.now(),
          policy,
        );
        if (fresh.level < 1 || fresh.episode !== signals.episode) return;
        this.#store.append({
          project: this.#project,
          actor: "daemon",
          at: new Date(this.#clock.now()).toISOString(),
          kind: "session.liveness",
          payload: {
            id,
            ticket: session.ticket,
            session: session.session,
            generation: session.generation,
            episode: signals.episode,
            level: signals.level,
            verdict: verdict.verdict as "looping" | "drifting",
            evidence: maskedTail(verdict.evidence).replace(/\p{Cc}/gu, " "),
            summary: progressSummary(signals),
          },
        });
      })
      .catch(() => {
        if (!this.#closed) console.warn("armada: watchdog judgment unavailable; no liveness notice recorded");
      })
      .finally(() => {
        cancelDeadline();
        this.#judging.delete(session.session);
        this.#scan();
      });
    this.#judging.set(session.session, { abort, done });
  }

  async close() {
    this.#closed = true;
    this.#unsubscribe();
    this.#cancelBatch?.();
    this.#cancelRetry?.();
    this.#cancelQuiet?.();
    this.#cancelLiveness?.();
    for (const job of this.#judging.values()) job.abort.abort();
    await Promise.allSettled([...this.#judging.values()].map((job) => job.done));
    await this.#sending;
  }
}
