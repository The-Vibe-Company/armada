import { createHash } from "node:crypto";
import type { FollowUp, InboxItem, ProjectTables, WakeCandidate } from "@armada/protocol";
import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { EventInput, FleetEvent, Json } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { refusalLine, refuse } from "../src/merge/refusal.ts";
import type { CoordinatorStorage } from "./storage.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/** Never persist a credential-bearing argument, including nested keys and free text. */
function masked(value: unknown, key = ""): Json {
  if (/token|secret|password|authorization|api.?key/i.test(key)) return "[redacted]";
  if (typeof value === "string") return refusalLine(value, "");
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => masked(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [k, masked(v, k)]),
    );
  return typeof value === "number" || typeof value === "boolean" ? value : null;
}

/** Deterministic identity is the cause, never the prose or a model's call id. */
export function followUpEvent(
  events: readonly FleetEvent[],
  project: string,
  at: string,
  ticket: string,
  detail: Omit<FollowUp, "cause" | "attempts" | "lastAt">,
  attempts?: number,
): EventInput {
  const cause = canonical([ticket || detail.pr, detail.tool ?? detail.candidate, detail.code]);
  const id = `follow-up:${hash(cause)}`;
  const previous = events.findLast((e) => e.kind === "inbox.opened" && e.payload.id === id);
  const prior = previous?.kind === "inbox.opened" ? (previous.payload.followUp?.attempts ?? 0) : 0;
  const followUp: FollowUp = { ...detail, cause, attempts: Math.max(attempts ?? 1, prior + 1), lastAt: at };
  return {
    project,
    actor: "coordinator",
    at,
    kind: "inbox.opened",
    payload: {
      id,
      ticket,
      kind: "follow-up",
      followUp,
      body: `${detail.tool ?? detail.candidate}: ${detail.reason}\n${detail.facts}\nNext: ${detail.next}${detail.fix ? `\nFix: ${detail.fix}` : ""}\nAttempts: ${followUp.attempts}`,
    },
  };
}

/** Legacy providers throw prose; normalize only known capability/outcome failures. */
export function workerRefusal(error: unknown): JsonObject {
  const known = error instanceof Error && error.name === "Error" && error.constructor.name === "WorkerRefusal";
  const reason = known
    ? (error as Error).message
    : "worker action could not be confirmed; inspect fleet state before retrying";
  const structured = error as { code?: string; capability?: string } | null;
  let code = structured?.code ?? "worker_refused";
  if (/No live worker in this daemon/i.test(reason)) code = "worker_outside_daemon";
  else if (/not confirmed|could not be confirmed|unresolved .*launch|retained for recovery/i.test(reason))
    code = "outcome_unconfirmed";
  else if (/provider is unavailable|runtime unavailable|node unavailable|cannot reattach|cannot bind/i.test(reason))
    code = "capability_missing";
  return refuse(code, reason, "fleet.status", structured?.capability ? { capability: structured.capability } : {});
}

function recordRefusal(scope: CoordinatorStorage, tool: string, args: JsonObject, result: JsonObject, at: string) {
  if (
    result.ok !== false ||
    ![
      "merge.check",
      "merge.run",
      "worker.launch",
      "worker.relaunch",
      "worker.message",
      "worker.stop",
      "inbox.answer",
    ].includes(tool) ||
    ["coordinator_inactive", "invalid_arguments", "missing_call_id", "state_unavailable", "write_failed"].includes(
      String(result.code),
    )
  )
    return;
  const events = scope.readEvents();
  const tables = fold(events).projects[scope.project];
  if (!tables) return;
  const pr = tables.pullRequests.find((p) => p.number === args.pr);
  const item = tables.inbox.find((i) => i.id === args.id);
  const ticket = pr?.ticket ?? (typeof args.ticket === "string" ? args.ticket : item?.ticket);
  if (!ticket) return;
  const session = tables.sessions.find((s) => s.ticket === ticket);
  const merge =
    ["merge.check", "merge.run"].includes(tool) &&
    session?.phase === "ready-to-merge" &&
    pr?.state === "open" &&
    pr.ci === "success";
  const capability =
    ["worker.message", "worker.stop", "worker.launch", "worker.relaunch", "inbox.answer"].includes(tool) &&
    [
      "capability_missing",
      "plugin_disabled",
      "worker_outside_daemon",
      "outcome_unconfirmed",
      "no_worker",
      "not_available_yet",
    ].includes(String(result.code));
  if (!merge && !capability) return;
  let code = String(result.code);
  let plugin = typeof result.plugin === "string" ? result.plugin : undefined;
  const name = typeof result.capability === "string" ? result.capability : undefined;
  const availability = events.map(readProviders).findLast((v) => v !== undefined);
  const provider = name && availability?.providers.find((p) => p.capabilities.includes(name));
  if (code === "capability_missing" && provider && !provider.enabled) {
    code = "plugin_disabled";
    plugin = provider.id;
  }
  const fix =
    code === "plugin_disabled"
      ? `Enable ${plugin ?? name ?? "the required plugin"} in Settings › Providers`
      : code === "worker_outside_daemon" || code === "no_worker"
        ? "answer in Linear or relaunch here"
        : code === "capability_missing"
          ? (name ?? "required runtime or node provider")
          : undefined;
  const event = followUpEvent(events, scope.project, at, ticket, {
    tool,
    args: masked(args) as Record<string, Json>,
    code,
    reason: refusalLine(result.reason ?? result.message),
    facts: merge
      ? `${ticket} is ready-to-merge; PR #${pr.number} is green at ${pr.head.slice(0, 8)}`
      : `${ticket}: ${session?.runtime ?? "selected worker"} ${session?.phase ?? "not launched"}; action unavailable`,
    next: refusalLine(result.next, "fleet.status"),
    ...(fix ? { fix } : {}),
    ...(pr ? { pr: pr.number, head: pr.head } : {}),
    ...(plugin ? { plugin } : {}),
    ...(name ? { capability: name } : {}),
    ...(session ? { session: session.session, generation: session.generation } : {}),
    ...(merge ? { readyToMerge: true } : {}),
  });
  scope.appendEvent(event);
  return { ...result, code, followUp: event.kind === "inbox.opened" ? event.payload.id : "", ...(fix ? { fix } : {}) };
}

/** A host hook covers every native return path without teaching the model to open items. */
export function withFollowUps(scope: CoordinatorStorage, now: () => string, tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      if (result.details && typeof result.details === "object" && !Array.isArray(result.details)) {
        try {
          const details = recordRefusal(scope, tool.name, args as JsonObject, result.details as JsonObject, now());
          if (details) return { ...result, details, output: [{ type: "text", text: JSON.stringify(details) }] };
        } catch {
          // A refused write must stay visible; a closed owner still has no authority to append.
          const details = refuse(
            "follow_up_write_failed",
            "The refusal could not be recorded as a durable follow-up",
            "inspect daemon storage and retry the original tool",
          );
          return { ...result, details, isError: true, output: [{ type: "text", text: JSON.stringify(details) }] };
        }
      }
      return result;
    },
  };
}

/** Follow-ups are coordinator work; resolving one must never queue worker input. */
export const isFollowUp = (item: InboxItem | undefined) => item?.kind === "follow-up";

/** Recovery only uses later, host-owned facts; an unrelated event cannot dismiss the cause. */
export function recoverFollowUps(
  inbox: Map<string, InboxItem>,
  event: FleetEvent,
  sessions: ReadonlyMap<string, { session: string; generation: number; phase: string }>,
) {
  for (const [id, item] of inbox) {
    const f = item.followUp;
    const current = sessions.get(item.ticket);
    if (item.kind !== "follow-up" || !f || event.seq <= item.seq) continue;
    let recovered =
      event.kind === "merge.confirmed" &&
      event.payload.ticket === item.ticket &&
      (!f.session || event.payload.session === f.session) &&
      (f.pr === undefined || event.payload.pr === f.pr) &&
      (!f.head || event.payload.head === f.head) &&
      current?.phase === "merged";
    if (event.kind === "pull-request.seen")
      recovered =
        event.payload.number === f.pr &&
        (event.payload.state === "merged" || (!!f.head && event.payload.head !== f.head));
    if (event.kind === "ticket.seen" && event.payload.id === item.ticket && f.readyToMerge)
      recovered = current
        ? current.session === f.session && current.phase !== "ready-to-merge"
        : !!f.session?.startsWith("tracker:");
    if (event.kind === "session.reported" && event.payload.ticket === item.ticket && f.readyToMerge)
      recovered = !!current && current.session === f.session && current.phase !== "ready-to-merge";
    if (event.kind === "session.claimed" && event.payload.ticket === item.ticket)
      recovered = current?.session === event.payload.session && current.generation > (f.generation ?? -1);
    if (event.kind === "session.released" && event.payload.ticket === item.ticket && f.readyToMerge)
      recovered = !!current && current.session === f.session && current.phase === "released";
    if (event.kind === "coordinator.checkpoint") {
      const c = event.payload.checkpoint;
      if (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        c.format === "armada.worker" &&
        c.version === 1 &&
        c.type === "launch" &&
        current?.session === c.session &&
        c.ticket === item.ticket &&
        typeof c.generation === "number" &&
        c.generation > (f.generation ?? -1)
      )
        recovered = true;
    }
    const availability = readProviders(event);
    if (availability)
      recovered = availability.providers.some(
        (v) =>
          (f.plugin && v.id === f.plugin && v.enabled) ||
          (f.capability && v.capabilities.includes(f.capability) && v.loaded),
      );
    if (recovered) inbox.delete(id);
  }
}

const providersSchema = z.object({
  format: z.literal("armada.tools"),
  version: z.literal(1),
  type: z.literal("providers"),
  providers: z.array(
    z.object({ id: z.string(), enabled: z.boolean(), loaded: z.boolean(), capabilities: z.array(z.string()) }),
  ),
});
export type ProviderAvailability = z.infer<typeof providersSchema>["providers"];
function readProviders(event: FleetEvent) {
  if (event.kind !== "coordinator.checkpoint") return;
  const parsed = providersSchema.safeParse(event.payload.checkpoint);
  return parsed.success ? parsed.data : undefined;
}
/** Persist only public availability, never plugin settings or secrets. */
export function providerCheckpoint(project: string, at: string, providers: ProviderAvailability): EventInput {
  return {
    project,
    actor: "coordinator",
    at,
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "providers",
        providers,
      },
    },
  };
}

export function followUpSummary(tables: ProjectTables, at: string) {
  const items = tables.inbox.filter((i) => i.kind === "follow-up");
  return {
    count: items.length,
    items: items.slice(0, 3).map((i) => {
      const f = i.followUp;
      const ageSeconds = Math.max(0, Math.floor((Date.parse(at) - Date.parse(i.at)) / 1000));
      return {
        id: i.id,
        ticket: i.ticket,
        cause: refusalLine(`${f?.tool ?? f?.candidate ?? "follow-up"}: ${f?.reason ?? i.body}`).slice(0, 96),
        next: (f?.next ?? "inbox.list").slice(0, 96),
        attempts: f?.attempts ?? 1,
        ageSeconds,
      };
    }),
  };
}

export interface WakeEvidence {
  key: string;
  factsHash: string;
  wokeAt: number;
  attempts: number;
  totalAttempts: number;
  seq: number;
}
export const factsHash = (candidate: WakeCandidate) => hash(canonical(candidate.facts));
/** A subtype of the existing tools checkpoint, restored without another store. */
export function wakeEvidenceCheckpoint(project: string, at: string, evidence: WakeEvidence): EventInput {
  return {
    project,
    actor: "coordinator",
    at,
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: { format: "armada.tools", version: 1, type: "wake-evidence", ...evidence },
    },
  };
}
export function readWakeEvidence(event: FleetEvent): WakeEvidence | undefined {
  const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    c.format !== "armada.tools" ||
    c.type !== "wake-evidence" ||
    c.version !== 1
  )
    return;
  if (
    typeof c.key === "string" &&
    typeof c.factsHash === "string" &&
    typeof c.wokeAt === "number" &&
    typeof c.attempts === "number" &&
    typeof c.seq === "number"
  )
    return {
      key: c.key,
      factsHash: c.factsHash,
      wokeAt: c.wokeAt,
      attempts: c.attempts,
      totalAttempts: typeof c.totalAttempts === "number" ? c.totalAttempts : c.attempts,
      seq: c.seq,
    };
}
