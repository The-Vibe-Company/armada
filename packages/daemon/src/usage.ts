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

/** A projection of one project's log; worker reports are cumulative per generation. */
export function projectUsage(events: readonly FleetEvent[], zone: string): ProjectUsage {
  const days = new Map<string, ProjectUsage["days"][number]>();
  const sessions = new Map<string, ProjectUsage["sessions"][number]>();
  const turns = new Set<string>();
  const documents: UsageDocuments = new Map();
  const previous = new Map<string, TokenUsage>();
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
  const sessionAt = (id: string, kind: "coordinator" | "worker") => {
    const key = `${kind}:${id}`;
    let row = sessions.get(key);
    if (!row) {
      row = { session: id, kind, totals: emptyTotals() };
      sessions.set(key, row);
    }
    return row;
  };
  for (const e of events) {
    if (e.kind === "coordinator.checkpoint") {
      const c = e.payload.checkpoint;
      const derived = checkpointUsage(c, documents);
      const completions = e.payload.turn ? [{ turn: e.payload.turn, usage: e.payload.usage ?? "unknown" }] : derived;
      for (const { turn, usage } of completions)
        if (!turns.has(turn.id)) {
          turns.add(turn.id);
          add(dayAt(e.at).coordinator, usage);
          add(sessionAt(turn.session, "coordinator").totals, usage);
        }
      if (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        c.format === "armada.worker" &&
        c.type === "launch" &&
        c.step === "launched" &&
        typeof c.session === "string"
      ) {
        const row = sessionAt(c.session, "worker");
        if (!row.launchedAt) {
          row.launchedAt = e.at;
          row.ticket = typeof c.ticket === "string" ? c.ticket : undefined;
          row.runtime = typeof c.runtime === "string" ? c.runtime : undefined;
          dayAt(e.at).workerLaunches++;
        }
      }
    }
    if (e.kind === "session.usage") {
      const { session, ticket, usage } = e.payload;
      const row = sessionAt(session, "worker");
      row.ticket = ticket;
      const day = dayAt(e.at);
      if (usage === "unknown") {
        row.totals.unknown = 1;
        add(day.workers, usage);
      } else {
        const prior = previous.get(session);
        // A repeated cumulative observation contributes no new tokens. Missing counters stay unknown.
        const delta = { ...usage };
        for (const k of fields) delta[k] = usage[k] === null ? null : Math.max(0, usage[k] - (prior?.[k] ?? 0));
        add(day.workers, delta);
        const cumulative = { ...usage };
        for (const k of fields) cumulative[k] = usage[k] ?? prior?.[k] ?? null;
        row.totals = emptyTotals();
        add(row.totals, cumulative);
        if (usage.incomplete || fields.some((k) => usage[k] === null)) row.totals.unknown = 1;
        previous.set(session, cumulative);
        const known = reported.get(day.day) ?? new Set<string>();
        if (fields.some((k) => usage[k] !== null)) known.add(session);
        reported.set(day.day, known);
        day.workersReported = known.size;
      }
    }
  }
  return { zone, days: [...days.values()], sessions: [...sessions.values()] };
}
