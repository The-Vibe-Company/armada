import type { FleetEvent, ProjectUsage, ReportedUsage, TokenUsage, UsageTotals } from "@armada/protocol";
import { usageTime } from "@armada/protocol/usage";

const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const emptyTotals = (): UsageTotals => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reported: 0,
  unknown: 0,
  models: [],
});
export function normalizeUsage(raw: unknown, model: unknown, provider: unknown): ReportedUsage {
  if (!raw || typeof raw !== "object") return "unknown";
  const u = raw as Record<string, unknown>;
  const result = Object.fromEntries(
    fields.map((k) => [k, Number.isSafeInteger(u[k]) && (u[k] as number) >= 0 ? u[k] : null]),
  );
  if (fields.every((k) => result[k] === null)) return "unknown";
  return {
    ...result,
    model: typeof model === "string" ? model : null,
    provider: typeof provider === "string" ? provider : null,
  } as TokenUsage;
}
/** Pi providers initialize mandatory counters with zero before receiving optional usage metadata. */
export function modelUsage(message: unknown): ReportedUsage {
  const m = message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
  if (m && "armadaUsage" in m) return m.armadaUsage as ReportedUsage;
  // The old SDK bridge erased availability before it was recorded; backfilling zeros would invent evidence.
  if (m?.api === "armada-ai-sdk") return "unknown";
  const usage = normalizeUsage(m?.usage, m?.model, m?.provider);
  return usage !== "unknown" && fields.every((key) => usage[key] === 0) ? "unknown" : usage;
}
function add(total: UsageTotals, usage: ReportedUsage) {
  if (usage === "unknown") {
    total.unknown++;
    return;
  }
  if (fields.some((k) => usage[k] !== null)) total.reported++;
  if (usage.incomplete || fields.some((k) => usage[k] === null)) total.unknown++;
  for (const k of fields) if (usage[k] !== null) total[k] = (total[k] ?? 0) + usage[k];
  if (usage.model && !total.models.includes(usage.model)) total.models.push(usage.model);
}
type UsageDocument = { session: string; models: Record<string, unknown> };
export type UsageDocuments = Map<string, UsageDocument>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Read pi's durable response and usage-document contract. Ledger snapshots also include compaction calls. */
export function checkpointUsage(checkpoint: unknown, documents: UsageDocuments) {
  const c = object(checkpoint);
  const completions: { turn: { id: string; session: string }; usage: ReportedUsage }[] = [];
  if (c?.format === "armada.usage" && c.version !== 1) throw new Error("Unsupported model usage checkpoint version");
  if (c?.format === "armada.usage" && typeof c.provider === "string" && typeof c.model === "string") {
    documents.set(`external:${c.provider}/${c.model}`, { session: "", models: {} });
    return completions;
  }
  if (c?.format !== "armada.pi" || c.type !== "commit" || !Array.isArray(c.writes)) return completions;
  const writes = c.writes.map(object).filter((w) => w !== undefined);
  for (const w of writes) {
    const entry = object(w.value);
    if (w.type !== "entry" || entry?.kind !== "pi.assistant") continue;
    const message = Array.isArray(entry.model)
      ? entry.model.map(object).find((m) => m?.role === "assistant")
      : undefined;
    const usage = modelUsage(message);
    completions.push({
      turn: {
        id: typeof message?.armadaUsageId === "string" ? message.armadaUsageId : String(entry.id),
        session: String(entry.conversationId),
      },
      usage,
    });
  }
  for (const w of writes) {
    const record = object(w.record);
    const scope = object(record?.scope);
    const content = object(w.content);
    const id = String(record?.id ?? w.id);
    const prior = documents.get(id);
    if (!(w.type === "document.create" && record?.kind === "pi.usage") && !(w.type === "document.change" && prior))
      continue;
    // UsageDoc checkpointWhen is always true in pinned pi-durable: full base values, never private deltas.
    if (content?.kind !== "base") continue;
    const models = object(object(content.value)?.models) ?? {};
    const session = prior?.session ?? String(scope?.conversationId);
    const diffs: TokenUsage[] = [];
    for (const [key, raw] of Object.entries(models)) {
      if (documents.has(`external:${key}`)) continue;
      const split = key.indexOf("/");
      const current = normalizeUsage(raw, key.slice(split + 1), key.slice(0, split));
      if (current === "unknown") continue;
      const before = normalizeUsage(prior?.models[key], current.model, current.provider);
      const delta = { ...current };
      for (const field of fields)
        delta[field] =
          current[field] === null
            ? null
            : Math.max(0, current[field] - (before === "unknown" ? 0 : (before[field] ?? 0)));
      if (fields.some((field) => (delta[field] ?? 0) > 0)) diffs.push(delta);
    }
    documents.set(id, { session, models });
    if (!completions.some((r) => r.turn.session === session) && diffs.length) {
      const totals = emptyTotals();
      for (const diff of diffs) add(totals, diff);
      completions.push({
        turn: { id: `usage:${c.seq}:${id}`, session },
        usage: {
          input: totals.input,
          output: totals.output,
          cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite,
          model: diffs.map((d) => d.model).join(", "),
          provider: [...new Set(diffs.map((d) => d.provider))].join(", "),
        },
      });
    }
  }
  return completions;
}

type DayRow = ProjectUsage["days"][number];
type SessionRow = ProjectUsage["sessions"][number];
/** One applied event's contribution, kept at its own time so any zone can bucket it later. */
type LedgerEntry =
  | { at: string; kind: "coordinator"; usage: ReportedUsage }
  | { at: string; kind: "worker"; usage: ReportedUsage; session?: string }
  | { at: string; kind: "launch" };
interface LedgerState {
  turns: string[];
  documents: [string, UsageDocument][];
  previous: [string, TokenUsage][];
  sessions: [string, SessionRow][];
  entries: LedgerEntry[];
}
const isObject = (value: unknown): value is Record<string, unknown> => object(value) !== undefined;
const pairs = (value: unknown, name: string): [string, unknown][] => {
  if (!Array.isArray(value) || value.some((e) => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string"))
    throw new Error(`usage ledger ${name} is not a list of named entries`);
  return value as [string, unknown][];
};

/** A project's metered usage, applied once per event and bucketed per zone on read.
 * Worker reports are cumulative per generation; pi usage documents are deltas over
 * their previous base. The ledger is zone-independent so a budget zone change
 * never needs the retained checkpoints again.
 */
export class UsageLedger {
  readonly #turns = new Set<string>();
  readonly #documents: UsageDocuments = new Map();
  readonly #previous = new Map<string, TokenUsage>();
  readonly #sessions = new Map<string, SessionRow>();
  readonly #entries: LedgerEntry[] = [];

  #sessionAt(id: string, kind: "coordinator" | "worker") {
    const key = `${kind}:${id}`;
    let row = this.#sessions.get(key);
    if (!row) {
      row = { session: id, kind, totals: emptyTotals() };
      this.#sessions.set(key, row);
    }
    return row;
  }
  #launched(id: string, at: string) {
    const row = this.#sessionAt(id, "worker");
    if (!row.launchedAt) {
      row.launchedAt = at;
      this.#entries.push({ at, kind: "launch" });
    }
    return row;
  }

  apply(e: FleetEvent): void {
    if (e.kind === "coordinator.checkpoint") {
      const c = e.payload.checkpoint;
      const derived = checkpointUsage(c, this.#documents);
      const completions = e.payload.turn ? [{ turn: e.payload.turn, usage: e.payload.usage ?? "unknown" }] : derived;
      for (const { turn, usage } of completions)
        if (!this.#turns.has(turn.id)) {
          this.#turns.add(turn.id);
          this.#entries.push({ at: e.at, kind: "coordinator", usage });
          add(this.#sessionAt(turn.session, "coordinator").totals, usage);
        }
      if (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        c.format === "armada.worker" &&
        c.type === "launch" &&
        typeof c.session === "string"
      ) {
        const row = c.step === "launched" ? this.#launched(c.session, e.at) : this.#sessionAt(c.session, "worker");
        if (typeof c.ticket === "string") row.ticket = c.ticket;
        if (typeof c.runtime === "string") row.runtime = c.runtime;
      }
    }
    if (e.kind === "worker.readopted") {
      // Recovery can be the first confirmation of a create whose launch reply was interrupted.
      // Already-confirmed generations retain their original launch time and consume no new slot.
      this.#launched(e.payload.session, e.at).ticket = e.payload.ticket;
    }
    if (e.kind === "session.usage") {
      const { session, ticket, usage } = e.payload;
      const row = this.#sessionAt(session, "worker");
      row.ticket = ticket;
      if (usage === "unknown") {
        row.totals.unknown = 1;
        this.#entries.push({ at: e.at, kind: "worker", usage });
      } else {
        const prior = this.#previous.get(session);
        // A repeated cumulative observation contributes no new tokens. Missing counters stay unknown.
        const delta = { ...usage };
        const cumulative = { ...usage };
        for (const k of fields) {
          const amount = usage[k];
          const floor = prior?.[k];
          delta[k] = amount === null ? null : Math.max(0, amount - (floor ?? 0));
          cumulative[k] = amount === null ? (floor ?? null) : Math.max(amount, floor ?? 0);
          if (amount !== null && floor != null && amount < floor) {
            delta.incomplete = true;
            cumulative.incomplete = true;
          }
        }
        this.#entries.push({
          at: e.at,
          kind: "worker",
          usage: delta,
          ...(fields.some((k) => usage[k] !== null) ? { session } : {}),
        });
        row.totals = emptyTotals();
        add(row.totals, cumulative);
        if (cumulative.incomplete || fields.some((k) => usage[k] === null)) row.totals.unknown = 1;
        this.#previous.set(session, cumulative);
      }
    }
  }

  /** Bucket the ledger in a zone; the result shares nothing with the ledger. */
  usage(zone: string): ProjectUsage {
    const days = new Map<string, DayRow>();
    const reported = new Map<string, Set<string>>();
    const dayAt = (at: string) => {
      const key = usageTime(at, zone).day;
      let row = days.get(key);
      if (!row) {
        row = { day: key, coordinator: emptyTotals(), workers: emptyTotals(), workerLaunches: 0, workersReported: 0 };
        days.set(key, row);
      }
      return row;
    };
    for (const entry of this.#entries) {
      const day = dayAt(entry.at);
      if (entry.kind === "launch") day.workerLaunches++;
      else if (entry.kind === "coordinator") add(day.coordinator, entry.usage);
      else {
        add(day.workers, entry.usage);
        if (entry.session) {
          const known = reported.get(day.day) ?? new Set<string>();
          known.add(entry.session);
          reported.set(day.day, known);
          day.workersReported = known.size;
        }
      }
    }
    return {
      zone,
      days: [...days.values()],
      sessions: [...this.#sessions.values()].map((row) => ({
        ...row,
        totals: { ...row.totals, models: [...row.totals.models] },
      })),
    };
  }

  /** Every map and set as explicit entry lists; `restore` reads it back. */
  serialize(): LedgerState {
    return {
      turns: [...this.#turns],
      documents: [...this.#documents],
      previous: [...this.#previous],
      sessions: [...this.#sessions],
      entries: this.#entries,
    };
  }

  static restore(state: unknown): UsageLedger {
    if (!isObject(state)) throw new Error("usage ledger is not an object");
    if (!Array.isArray(state.turns) || state.turns.some((t) => typeof t !== "string"))
      throw new Error("usage ledger turns are not strings");
    if (!Array.isArray(state.entries) || state.entries.some((e) => !isObject(e) || typeof e.at !== "string"))
      throw new Error("usage ledger entries are malformed");
    const ledger = new UsageLedger();
    for (const turn of state.turns) ledger.#turns.add(turn);
    for (const [id, document] of pairs(state.documents, "documents")) {
      if (!isObject(document) || typeof document.session !== "string" || !isObject(document.models))
        throw new Error("usage ledger document is malformed");
      ledger.#documents.set(id, document as UsageDocument);
    }
    for (const [session, usage] of pairs(state.previous, "previous")) {
      if (!isObject(usage)) throw new Error("usage ledger floor is malformed");
      ledger.#previous.set(session, usage as TokenUsage);
    }
    for (const [key, row] of pairs(state.sessions, "sessions")) {
      if (!isObject(row) || typeof row.session !== "string" || !isObject(row.totals))
        throw new Error("usage ledger session is malformed");
      ledger.#sessions.set(key, row as SessionRow);
    }
    ledger.#entries.push(...(state.entries as LedgerEntry[]));
    return ledger;
  }
}

/** A projection of one project's log; worker reports are cumulative per generation. */
export function projectUsage(events: readonly FleetEvent[], zone: string): ProjectUsage {
  const ledger = new UsageLedger();
  for (const e of events) ledger.apply(e);
  return ledger.usage(zone);
}
