import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NodeProvider, RuntimeProvider, WorkerObservation, WorkerRef, Workspace } from "@armada/plugin-api";
import { isRuntimeLaunchRefusal } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import {
  activePhaseSchema,
  type ProjectTables,
  reportedUsageSchema,
  type Ticket,
  type ToolProgress,
} from "@armada/protocol";
import { usageTime } from "@armada/protocol/usage";
import { z } from "zod";
import { evaluateBudget } from "../budget.ts";
import { Deliveries, queueDelivery } from "../deliveries.ts";
import type { EventInput, Json } from "../events.ts";
import { fold } from "../fold.ts";
import { maskedTail } from "../liveness/judge.ts";
import { refuse } from "../merge/refusal.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { Account } from "../server/account.ts";
import type { EventStore } from "../store.ts";
import { BriefRefusal, workerBrief } from "./brief.ts";
import { loadBriefContext } from "./brief-context.ts";
import { maskHostedText } from "./hosted.ts";
import { labelKey, workerRoute } from "./routing.ts";
import { WorkerTicketScopeRefusal, workerTicket } from "./ticket.ts";

interface WorkerProject {
  id: string;
  repository: string;
  checkout?: string;
  root?: string;
  tracker?: string;
  name?: string;
  programRoot?: string;
}
interface Options {
  store: EventStore;
  registry: PluginRegistry;
  projects: readonly WorkerProject[];
  socketPath: string;
  account?: Account;
  now?: () => string;
  /** Host refresh commits a provider checkpoint only on success; actions require that evidence. */
  refresh?: (project: string) => Promise<void>;
}
export interface RecoverySummary {
  readopted: WorkerRef[];
  lost: (WorkerRef & { reason: string })[];
}
interface LiveWorker {
  ref: WorkerRef;
  runtime: RuntimeProvider;
  node?: NodeProvider;
  workspace: Workspace;
  tokenHash: string;
  mask: (value: string) => string;
  branch: string;
  runtimeKind: string;
  launchId?: string;
  briefPending?: boolean;
}
interface BriefFacts {
  config: WorkerProject;
  tables: ProjectTables;
  ticket: Ticket;
  route: ReturnType<typeof workerRoute>;
  bound: RuntimeProvider;
  branch: string;
}
interface PreparedBrief {
  create(token: string): string;
  facts: string;
}
const id = z.string().min(1).max(200).regex(/\S/);
export class WorkerRefusal extends Error {
  readonly code?: string;
  readonly capability?: string;
  constructor(message: string, code?: string, capability?: string) {
    super(message);
    this.code = code;
    this.capability = capability;
  }
}
const launchArgs = {
  ticket: id,
  branch: id.optional(),
  /** Additional coordinator notes, never a replacement for the ticket's brief. */
  brief: z.string().max(16000).optional(),
  rule: z.number().int().positive().optional(),
  reason: z.string().min(1).max(16000).optional(),
};
const text = z.string().min(1).max(16000);
export const workerToolSchemas = {
  "worker.launch": z.strictObject(launchArgs),
  "worker.relaunch": z.strictObject({
    ticket: id,
    session: id.optional(),
    reason: z.string().min(1).max(16000),
    rule: z.number().int().positive().optional(),
    brief: z.string().max(16000).optional(),
  }),
  "worker.message": z.strictObject({ ticket: id, session: id.optional(), message: text }),
  "worker.stop": z.strictObject({ ticket: id, session: id.optional(), reason: text }),
};
export type WorkerTool = keyof typeof workerToolSchemas;
const workerRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("ticket"), ticket: id }),
  z.strictObject({ command: z.literal("claim"), ticket: id }),
  z.strictObject({
    command: z.literal("report"),
    ticket: id,
    phase: activePhaseSchema,
    message: text,
    stage: z.enum(["review", "ci"]).optional(),
    pr: z.number().int().positive().optional(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  }),
  z.strictObject({ command: z.literal("heartbeat"), ticket: id }),
  z.strictObject({ command: z.literal("ask"), ticket: id, question: text, key: id }),
  z.strictObject({ command: z.literal("release"), ticket: id, reason: text }),
]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ended = (phase: string) => phase === "released" || phase === "merged";
const same = (a: WorkerRef, b: WorkerRef) =>
  a.project === b.project &&
  a.ticket === b.ticket &&
  a.session === b.session &&
  a.generation === b.generation &&
  a.handle === b.handle;

/** One host-owned launch path. Tokens never enter durable events or coordinator tool results. */
export class Workers {
  readonly #options: Options;
  readonly #outbox: Deliveries;
  readonly #live = new Map<string, LiveWorker>();
  readonly #observations = new Map<string, string>();
  readonly #reads = new Map<string, Promise<WorkerObservation>>();
  readonly #lastRead = new Map<string, number>();
  #observing: Promise<void> | undefined;
  readonly #unconfirmed = new Map<string, LiveWorker>();
  readonly #lost = new Set<string>();
  #recovery?: Promise<RecoverySummary>;
  readonly #queues = new Map<string, Promise<unknown>>();
  #closing = false;
  readonly #removing = new Set<string>();
  readonly #stopForge: () => void;
  readonly #forgeCursors = new Map<string, number>();
  #forgeScheduled = false;
  #forgeAgain = false;
  constructor(options: Options) {
    this.#options = options;
    this.#outbox = new Deliveries({
      store: options.store,
      now: () => this.#at(),
      deliver: async (delivery, beforeWrite) => {
        await this.#recovery;
        const row = this.#row(delivery.project, delivery.ticket);
        await this.answer(
          {
            key: delivery.key,
            item: delivery.item,
            session: { ticket: delivery.ticket, session: delivery.session },
            answer: delivery.text,
            beforeWrite,
          },
          delivery.project,
        );
        if (row.briefPending && delivery.source === "coordinator-message" && !delivery.key.startsWith("forge:")) {
          this.#checkpoint(delivery.project, { type: "recovery-handoff", session: row.ref.session });
          row.briefPending = false;
        }
      },
    });
    const scan = () => {
      if (this.#closing) return;
      if (this.#forgeScheduled) {
        this.#forgeAgain = true;
        return;
      }
      this.#forgeScheduled = true;
      queueMicrotask(() => {
        void this.#forgeMessages()
          .catch(() => {})
          .finally(() => {
            this.#forgeScheduled = false;
            if (this.#forgeAgain) {
              this.#forgeAgain = false;
              scan();
            }
          });
      });
    };
    let observed = options.store.sequence;
    this.#stopForge = options.store.subscribe(() => {
      const changes = options.store.readSince(observed);
      observed = options.store.sequence;
      // Delivery's own intents/receipts cannot continuously retry a lost worker.
      if (
        changes.some((event) => {
          const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
          return (
            !c ||
            typeof c !== "object" ||
            Array.isArray(c) ||
            c.format !== "armada.worker" ||
            c.type === "recovery-handoff"
          );
        })
      )
        scan();
    });
    scan();
  }
  /** Source IDs plus the captured session fence replay and prevent notifying a replacement. */
  async #forgeMessages() {
    await this.#recovery;
    for (const project of this.#options.projects) {
      const events = this.#options.store.readSince(0, project.id);
      let cursor = this.#forgeCursors.get(project.id) ?? 0;
      let failedAt: number | undefined;
      for (let index = 0; index < events.length && !this.#closing; index++) {
        const event = events[index]!;
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        if (event.kind !== "pull-request.commented" && event.kind !== "review-thread.opened") continue;
        const p = event.payload;
        // PR author is the forge identity of the worker that opened this PR.
        if (p.repository !== project.repository || !p.worker || p.author.toLowerCase() === p.worker.toLowerCase())
          continue;
        const session = fold(events.slice(0, index + 1)).projects[project.id]?.sessions.find(
          (s) => s.ticket === p.ticket,
        );
        if (!session || ended(session.phase) || session.runtime === "tracker") continue;
        if (this.#live.get(session.session)?.briefPending) {
          failedAt ??= event.seq;
          continue;
        }
        const key = `forge:${hash(JSON.stringify([project.id, session.session, p.pr, p.comment, p.version ?? p.at]))}`;
        try {
          await this.tool(
            project.id,
            "worker.message",
            {
              ticket: p.ticket,
              session: session.session,
              message: `GitHub review from ${p.author} on PR #${p.pr}:\n${p.body}\n${p.url}`,
            },
            key,
            () => {
              const current = this.#tables(project.id)?.sessions.find((s) => s.ticket === p.ticket);
              if (this.#closing || !current || current.session !== session.session || ended(current.phase))
                throw new WorkerRefusal("Worker generation changed; review input skipped");
            },
          );
        } catch {
          const current = this.#tables(project.id)?.sessions.find((s) => s.ticket === p.ticket);
          if (current?.session === session.session && !ended(current.phase)) failedAt ??= event.seq;
        }
      }
      this.#forgeCursors.set(project.id, failedAt ? failedAt - 1 : cursor);
    }
  }

  #at() {
    return this.#options.now?.() ?? new Date().toISOString();
  }
  #tables(project: string) {
    return this.#options.store.fold(project).projects[project];
  }
  #append(event: { project: string; kind: EventInput["kind"]; payload: Json }, actor = "coordinator") {
    return this.#options.store.append({ ...event, at: this.#at(), actor } as EventInput);
  }
  #serial<T>(project: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(project) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.#queues.set(project, next);
    void next
      .finally(() => {
        if (this.#queues.get(project) === next) this.#queues.delete(project);
      })
      .catch(() => {});
    return next;
  }
  #check(ref: WorkerRef, beforeWrite: () => void = () => {}, allowEnded = false) {
    beforeWrite();
    const current = this.#tables(ref.project)?.sessions.find((s) => s.ticket === ref.ticket);
    if (!current || (!allowEnded && ended(current.phase)) || !same({ project: ref.project, ...current }, ref))
      throw new WorkerRefusal("Worker generation changed; runtime untouched");
  }
  #row(project: string, ticket: string, allowEnded = false) {
    const current = this.#tables(project)?.sessions.find((s) => s.ticket === ticket);
    const row = current && this.#live.get(current.session);
    if (!row) throw new WorkerRefusal("No live worker in this daemon; inspect the session before relaunching");
    this.#check(row.ref, () => {}, allowEnded);
    return row;
  }
  #checkpoint(project: string, value: Record<string, Json>) {
    this.#append({
      project,
      kind: "coordinator.checkpoint",
      payload: { checkpoint: { format: "armada.worker", version: 1, ...value } },
    });
  }

  /** Hold the same queue as launch until the project has been unregistered. */
  async removingProject<T>(project: string, action: () => Promise<T>): Promise<T> {
    this.#removing.add(project);
    try {
      return await this.#serial(project, async () => {
        if (this.#tables(project)?.sessions.some((s) => !ended(s.phase)))
          throw new WorkerRefusal("Project has a worker in flight");
        const checkpoints = this.#options.store.readSince(0, project).flatMap((e) => {
          const c = e.kind === "coordinator.checkpoint" ? e.payload.checkpoint : null;
          return c && typeof c === "object" && !Array.isArray(c) && c.format === "armada.worker" ? [c] : [];
        });
        if (
          checkpoints.some(
            (c) => c.type === "launch-intent" && !checkpoints.some((r) => r.type === "receipt" && r.key === c.key),
          )
        )
          throw new WorkerRefusal("Project has an unresolved worker launch; inspect it before removing the project");
        return action();
      });
    } finally {
      this.#removing.delete(project);
    }
  }

  async tool(
    project: string,
    name: WorkerTool,
    args: unknown,
    key: string,
    beforeWrite: () => void,
    progress: (step: ToolProgress) => Promise<void> = async () => {},
  ): Promise<Record<string, Json>> {
    const parsed = workerToolSchemas[name].parse(args);
    if (this.#removing.has(project)) throw new WorkerRefusal("Project is being removed");
    return this.#serial(project, async () => {
      beforeWrite();
      if (this.#closing) throw new Error("Worker service is stopping");
      const input = hash(JSON.stringify({ name, args: parsed }));
      const previous = this.#options.store.readSince(0, project).flatMap((e) => {
        if (e.kind !== "coordinator.checkpoint") return [];
        const c = e.payload.checkpoint;
        return c && typeof c === "object" && !Array.isArray(c) && c.format === "armada.worker" && c.key === key
          ? [c]
          : [];
      });
      if (previous.some((c) => c.input !== input))
        throw new Error("Worker call identity already used with different arguments");
      const completed = previous.find((c) => c.type === "receipt");
      if (completed) return completed.result as Record<string, Json>;
      // A launch that may have taken effect is never repeated after a daemon crash.
      if ((name === "worker.launch" || name === "worker.relaunch") && previous.length)
        throw new Error("Launch outcome unknown; inspect the existing generation, do not retry launch");
      if (name === "worker.launch" || name === "worker.relaunch") {
        const action = parsed as { ticket: string; rule?: number; reason?: string };
        const tables = this.#tables(project);
        const ticket = tables?.tickets.find((ticket) => ticket.id === action.ticket);
        let route: ReturnType<typeof workerRoute> | undefined;
        try {
          if (ticket) route = workerRoute(tables?.rules?.value, ticket, action);
        } catch {
          /* Fresh launch facts own route refusals. */
        }
        if (route && this.#options.registry.get("runtime", route.cli, project)?.needsLaunchToken) {
          if (!this.#options.account) throw new WorkerRefusal("Sign in to Armada in Settings to launch in Conductor");
          try {
            await this.#options.account.assertWorkerSignIn();
          } catch {
            throw new WorkerRefusal("Sign in to Armada in Settings to launch in Conductor");
          }
          beforeWrite();
        }
      }
      if ((name === "worker.launch" || name === "worker.relaunch") && this.#options.refresh) {
        const started = Date.parse(this.#at());
        const cursor = this.#options.store.sequence;
        await this.#options.refresh(project).catch(() => {});
        beforeWrite();
        const tracker = this.#options.projects.find((p) => p.id === project)?.tracker ?? "linear";
        const readAt = Date.parse(this.#tables(project)?.readAt?.[tracker] ?? "");
        const confirmed = this.#options.store.readSince(cursor, project).some((event) => {
          const checkpoint = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
          return (
            checkpoint &&
            typeof checkpoint === "object" &&
            !Array.isArray(checkpoint) &&
            checkpoint.format === "armada.readers" &&
            checkpoint.version === 1 &&
            checkpoint.provider === tracker
          );
        });
        if (!confirmed || !Number.isFinite(readAt) || readAt < started)
          throw new WorkerRefusal("Ticket reading could not be refreshed; nothing was launched");
      }
      let result: Record<string, Json>;
      if (name === "worker.launch") {
        const launch = workerToolSchemas["worker.launch"].parse(parsed);
        result = await this.#launch(project, launch, key, input, beforeWrite, undefined, progress);
      } else {
        const action = parsed as { ticket: string; session?: string };
        const current = this.#tables(project)?.sessions.find((s) => s.ticket === action.ticket);
        if (
          current &&
          !this.#live.has(current.session) &&
          (name === "worker.stop" || (this.#lost.has(current.session) && name !== "worker.message"))
        ) {
          if (action.session && action.session !== current.session)
            throw new WorkerRefusal("Worker generation changed");
          const ref = {
            project,
            ticket: current.ticket,
            session: current.session,
            generation: current.generation,
            handle: current.handle,
          };
          await this.#adopt(ref, name === "worker.stop").catch(() => {});
          this.#check(ref, () => {}, name === "worker.stop");
        }
        if (current && name === "worker.stop" && !this.#live.has(current.session)) {
          const result = this.#finishStopped(
            { project, ...current },
            workerToolSchemas["worker.stop"].parse(parsed).reason,
            beforeWrite,
          );
          if (result) {
            this.#checkpoint(project, { type: "receipt", key, input, result });
            return result;
          }
        }
        if (current && this.#lost.has(current.session) && name !== "worker.message") {
          if (action.session && action.session !== current.session)
            throw new WorkerRefusal("Worker generation changed");
          if (name === "worker.stop") {
            const reason = workerToolSchemas["worker.stop"].parse(parsed).reason;
            const ref = {
              project,
              ticket: current.ticket,
              session: current.session,
              generation: current.generation,
              handle: current.handle,
            };
            const result = await this.#stopLost(ref, reason, beforeWrite);
            this.#checkpoint(project, { type: "receipt", key, input, result });
            return result;
          }
          const relaunch = workerToolSchemas["worker.relaunch"].parse(parsed);
          const old = {
            project,
            ticket: current.ticket,
            session: current.session,
            generation: current.generation,
            handle: current.handle,
          };
          const candidate = this.#unconfirmed.get(current.session);
          if (!candidate && this.#notStarted(project, current.session)?.workspaceDisposed === true) {
            const replacement = { ...relaunch, branch: this.#notStarted(project, current.session)!.branch as string };
            const facts = this.#launchFacts(project, replacement, old);
            const briefing = await this.#prepareBrief(facts, replacement);
            this.#checkPreparedBrief(project, replacement, old, briefing, beforeWrite);
            this.#releaseLost(project, old.ticket, old.session, `relaunch: ${relaunch.reason}`, beforeWrite);
            const result = await this.#launch(
              project,
              replacement,
              key,
              input,
              beforeWrite,
              undefined,
              progress,
              briefing,
            );
            this.#checkpoint(project, { type: "receipt", key, input, result });
            return result;
          }
          if (!candidate)
            throw new WorkerRefusal(
              "Lost worker cannot be safely stopped; restore its runtime or release the ticket explicitly",
            );
          const replacement = { ...relaunch, branch: candidate.branch };
          const facts = this.#launchFacts(project, replacement, old);
          if (facts.node !== candidate.node)
            throw new WorkerRefusal("Replacement placement changed; restore the worker node first");
          const resume = candidate.runtime.needsLaunchToken ? undefined : candidate;
          const briefing = await this.#prepareBrief(facts, replacement, resume);
          this.#checkPreparedBrief(project, replacement, old, briefing, beforeWrite);
          await this.#stop(candidate, `relaunch: ${relaunch.reason}`, beforeWrite, false);
          const result = await this.#launch(project, replacement, key, input, beforeWrite, resume, progress, briefing);
          this.#checkpoint(project, { type: "receipt", key, input, result });
          return result;
        }
        const row = this.#row(project, action.ticket, name !== "worker.message");
        if (
          (action.session && action.session !== row.ref.session) ||
          previous.some((c) => c.session && c.session !== row.ref.session)
        )
          throw new WorkerRefusal(`${action.ticket}'s worker generation changed; nothing was released`);
        if (name === "worker.relaunch") {
          const relaunch = workerToolSchemas["worker.relaunch"].parse(parsed);
          if (!relaunch.reason.trim()) throw new WorkerRefusal("worker.relaunch needs a reason");
          // V1 cli/src/relaunch.ts: complete preflight before ending the old generation.
          const facts = this.#launchFacts(project, { ...relaunch, branch: row.branch }, row.ref);
          if (facts.bound.needsLaunchToken)
            throw new WorkerRefusal("Conductor relaunch in place is not supported; stop and launch a fresh worker");
          if (facts.node !== row.node)
            throw new WorkerRefusal("Replacement placement changed; keep the existing workspace and inspect its node");
          const briefing = await this.#prepareBrief(facts, relaunch, row);
          this.#checkPreparedBrief(project, { ...relaunch, branch: row.branch }, row.ref, briefing, beforeWrite);
          this.#checkpoint(project, {
            type: "relaunch-intent",
            key,
            input,
            ticket: row.ref.ticket,
            session: row.ref.session,
          });
          await this.#stop(row, `relaunch: ${relaunch.reason}`, beforeWrite, false);
          result = await this.#launch(
            project,
            { ...relaunch, branch: row.branch },
            key,
            input,
            beforeWrite,
            row,
            progress,
            briefing,
          );
        } else {
          this.#checkpoint(project, {
            type: "action-intent",
            key,
            input,
            ticket: row.ref.ticket,
            session: row.ref.session,
            generation: row.ref.generation,
          });
          if (name === "worker.message") {
            const message = workerToolSchemas["worker.message"].parse(parsed).message;
            const queued = queueDelivery({
              project,
              at: this.#at(),
              actor: "coordinator",
              ticket: row.ref.ticket,
              session: row.ref.session,
              generation: row.ref.generation,
              source: "coordinator-message",
              text: row.mask(message),
              key,
            });
            result = { ok: true, session: row.ref.session, queued: queued.payload.id };
            this.#check(row.ref, beforeWrite);
            this.#options.store.appendMany([
              queued,
              {
                project,
                at: this.#at(),
                actor: "coordinator",
                kind: "coordinator.checkpoint",
                payload: { checkpoint: { format: "armada.worker", version: 1, type: "receipt", key, input, result } },
              },
            ]);
            return result;
          } else {
            const reason = workerToolSchemas["worker.stop"].parse(parsed).reason;
            if (!reason.trim()) throw new WorkerRefusal("Stopping a worker needs a reason");
            result = await this.#stop(row, reason, beforeWrite, true);
          }
        }
      }
      this.#checkpoint(project, { type: "receipt", key, input, result });
      return result;
    });
  }

  #launchFacts(project: string, args: z.infer<(typeof workerToolSchemas)["worker.launch"]>, replacing?: WorkerRef) {
    const config = this.#options.projects.find((p) => p.id === project);
    if (!config) throw new WorkerRefusal("Unknown worker project");
    const events = this.#options.store.readSince(0, project);
    const pending = events.flatMap((e) => {
      const c = e.kind === "coordinator.checkpoint" ? e.payload.checkpoint : null;
      return c && typeof c === "object" && !Array.isArray(c) && c.format === "armada.worker" ? [c] : [];
    });
    if (
      pending.some(
        (c) =>
          c.type === "launch-intent" &&
          c.ticket === args.ticket &&
          c.session !== replacing?.session &&
          this.#tables(project)?.sessions.some((session) => session.session === c.session && !ended(session.phase)) &&
          !pending.some((done) => done.type === "receipt" && done.key === c.key),
      )
    )
      throw new WorkerRefusal("Ticket has an unresolved launch intent; inspect its process before relaunching");
    for (const event of evaluateBudget({ project, events, now: this.#at() })) this.#options.store.append(event);
    const tables = this.#tables(project);
    const budgetHolds = tables?.holds.filter((hold) => hold.reason.startsWith("budget:")) ?? [];
    if (budgetHolds.length) throw new WorkerRefusal(`Project paused: ${budgetHolds.map((h) => h.reason).join("; ")}`);
    if (!tables) throw new WorkerRefusal(`ticket ${args.ticket} not found in Linear`);
    const ticket = tables.tickets.find((t) => t.id === args.ticket);
    // Copied from V1 cli/src/launch.ts prepareLaunch and core/src/brief.ts loadBrief.
    if (!ticket) throw new WorkerRefusal(`ticket ${args.ticket} not found in Linear`);
    if (["completed", "canceled"].includes(ticket.status))
      throw new WorkerRefusal(`${ticket.id} is ${ticket.status}; there is nothing to launch`);
    if (!ticket.labels?.includes("ready-for-agent")) throw new WorkerRefusal(`${ticket.id} lacks ready-for-agent`);
    if (ticket.labels.includes("parked"))
      throw new WorkerRefusal(`${ticket.id} is parked; remove the parked label before launching`);
    if (!ticket.blockers)
      throw new WorkerRefusal(`${ticket.id} blocker evidence is unavailable; refresh the tracker before launching`);
    if (ticket.blockers.some((b) => !["completed", "canceled"].includes(b.status)))
      throw new WorkerRefusal(`${ticket.id} has open blockers; resolve them before launching`);
    const active = tables.sessions.filter((s) => !ended(s.phase) && s.session !== replacing?.session);
    if (active.some((s) => s.ticket === args.ticket))
      throw new WorkerRefusal(`${ticket.id} is already in flight; inspect its worker before launching again`);
    const rules = tables.rules?.value;
    let route: ReturnType<typeof workerRoute>;
    try {
      route = workerRoute(rules, ticket, args);
    } catch (error) {
      throw new WorkerRefusal(error instanceof Error ? error.message : "Routing refused");
    }
    // node-local publishes node.local; the app's placement names registry kinds.
    const nodeKind = rules?.placement?.workers ?? "local";
    const max = rules?.policy?.maxWorkers;
    if (max != null && active.length >= max)
      throw new WorkerRefusal(`worker cap reached: ${active.length} of ${max} workers; nothing was launched`);
    const runtime = this.#options.registry.get("runtime", route.cli, project);
    const node = this.#options.registry.get("node", nodeKind, project);
    if (!runtime || (!runtime.needsLaunchToken && !node))
      throw new WorkerRefusal(
        "Selected runtime or node provider is unavailable",
        "capability_missing",
        !runtime ? `runtime.${route.cli}` : `node.${nodeKind}`,
      );
    let bound = runtime;
    if (!runtime.needsLaunchToken) {
      if (!runtime.withNode || !node) throw new WorkerRefusal("Runtime cannot bind the selected node");
      if (!config.checkout) throw new WorkerRefusal("Local runtime needs a project checkout");
      bound = runtime.withNode(node);
    }
    const branch = args.branch ?? ticket.branchName;
    if (!branch) throw new WorkerRefusal(`${ticket.id} has no suggested branch in Linear`);
    return {
      config,
      tables,
      ticket,
      rules,
      route,
      nodeKind,
      max,
      bound,
      node: runtime.needsLaunchToken ? undefined : node,
      branch,
    };
  }

  #briefFacts(facts: BriefFacts): string {
    const policy = facts.tables.rules?.value.policy;
    const has = (name: string) => facts.ticket.labels?.some((label) => labelKey(label) === labelKey(name)) === true;
    return JSON.stringify({
      config: facts.config,
      branch: facts.branch,
      route: facts.route,
      hosted: facts.bound.needsLaunchToken === true,
      placement: facts.tables.rules?.value.placement?.workers ?? "local",
      revision: facts.tables.rules?.revision,
      plan: [
        policy?.plans,
        has(policy?.approvalLabel ?? "needs-plan-approval"),
        has(policy?.preApprovedLabel ?? "plan-approved"),
      ],
    });
  }

  #checkPreparedBrief(
    project: string,
    args: z.infer<(typeof workerToolSchemas)["worker.launch"]>,
    ref: WorkerRef,
    brief: PreparedBrief,
    beforeWrite: () => void,
  ) {
    this.#check(ref, beforeWrite);
    if (this.#closing) throw new WorkerRefusal("Worker service is stopping");
    if (brief.facts !== this.#briefFacts(this.#launchFacts(project, args, ref)))
      throw new WorkerRefusal("Replacement prerequisites changed during brief preflight");
  }

  async #prepareBrief(
    facts: BriefFacts,
    args: z.infer<(typeof workerToolSchemas)["worker.launch"]>,
    resume?: LiveWorker,
  ) {
    const { config, tables, ticket, route, bound, branch } = facts;
    const hosted = bound.needsLaunchToken;
    if (hosted && (!this.#options.account || !config.programRoot))
      throw new WorkerRefusal(
        !this.#options.account
          ? "Sign in to Armada in Settings to launch in Conductor"
          : "Configure the project program root before launching in Conductor",
      );
    if (this.#closing) throw new WorkerRefusal("Worker service is stopping");
    let context: Awaited<ReturnType<typeof loadBriefContext>>;
    try {
      context = await loadBriefContext(config.root ?? config.checkout);
    } catch {
      throw new WorkerRefusal(
        "Cannot read repository brief context; check AGENTS.md, CLAUDE.md and [brief] extra in the project root",
      );
    }
    if (this.#closing) throw new WorkerRefusal("Worker service is stopping");
    const makeBrief = (token: string) => {
      try {
        return workerBrief({
          ticket,
          tables,
          repository: config.repository,
          branch,
          ...context,
          notes: args.brief,
          profileInstructions: route.instructions,
          ...(hosted
            ? { hosted: { token, apiUrl: this.#options.account!.apiUrl, profile: route.model, project: config.id } }
            : {}),
          ...(resume
            ? {
                resume: `Relaunch reason: ${args.reason}. Previous session: ${resume.ref.session}. Continue branch ${branch} in this same worktree.`,
              }
            : {}),
        });
      } catch (error) {
        if (error instanceof BriefRefusal) throw new WorkerRefusal(error.message);
        throw error;
      }
    };
    // Validate protected content before minting a token or ending the old generation.
    // Launch-token exchange accepts at most 200 ASCII characters; reserve that
    // space before minting. The issued token is rendered from this same context.
    makeBrief("_".repeat(200));
    return { create: makeBrief, facts: this.#briefFacts(facts) };
  }

  async #launch(
    project: string,
    args: z.infer<(typeof workerToolSchemas)["worker.launch"]>,
    key: string,
    input: string,
    beforeWrite: () => void,
    resume?: LiveWorker,
    progress: (step: ToolProgress) => Promise<void> = async () => {},
    preparedBrief?: PreparedBrief,
  ) {
    await progress("preparing");
    const facts = this.#launchFacts(project, args);
    const { config, tables, ticket, route, nodeKind, max, bound, node, branch } = facts;
    if (preparedBrief && preparedBrief.facts !== this.#briefFacts(facts))
      throw new WorkerRefusal("Replacement prerequisites changed after brief preflight");
    const generation =
      Math.max(0, ...tables.sessions.filter((s) => s.ticket === args.ticket).map((s) => s.generation)) + 1;
    const worker = { project, ticket: args.ticket, session: randomUUID(), generation };
    const hosted = bound.needsLaunchToken;
    const account = this.#options.account;
    if (hosted && (!account || !config.programRoot)) {
      if (!account) throw new WorkerRefusal("Sign in to Armada in Settings to launch in Conductor");
      throw new WorkerRefusal("Configure the project program root before launching in Conductor");
    }
    const makeBrief = (preparedBrief ?? (await this.#prepareBrief(facts, args, resume))).create;
    beforeWrite();
    this.#checkpoint(project, {
      type: "launch-intent",
      ...(hosted ? { hosted: true } : {}),
      key,
      input,
      ticket: args.ticket,
      session: worker.session,
      generation,
      branch,
      runtime: route.cli,
      step: "preparing",
      ...(args.rule ? { rule: args.rule, reason: args.reason ?? "" } : {}),
    });
    const launch = hosted
      ? await (async () => {
          let minting = false;
          try {
            await account!.workerFleet(
              {
                slug: project,
                name: config.name ?? project,
                repository: config.repository,
                programRoot: config.programRoot!,
              },
              "runtime/handle",
              { ticket: args.ticket },
            );
            beforeWrite();
            minting = true;
            return await account!.launchWorkerToken(project, args.ticket);
          } catch (error) {
            if (this.#closing) throw new WorkerRefusal("Daemon stopped during launch; ticket retained for recovery");
            if (!minting || isRuntimeLaunchRefusal(error)) {
              this.#append({
                project,
                kind: "session.released",
                payload: {
                  ticket: worker.ticket,
                  session: worker.session,
                  reason: "Armada launch authorization refused",
                },
              });
              this.#checkpoint(project, {
                type: "receipt",
                key,
                input,
                result: refuse(
                  "authorization_refused",
                  "Conductor launch authorization failed",
                  "worker.launch again after signing in through Settings",
                ),
              });
            }
            throw new WorkerRefusal(
              error instanceof Error && error.message === "Sign in to Armada in Settings to launch in Conductor"
                ? error.message
                : "Armada could not authorize the Conductor launch",
            );
          }
        })()
      : undefined;
    const token = launch?.token ?? randomBytes(32).toString("base64url");
    const launchTarget = launch ? { project, ticket: args.ticket, id: launch.worker.id } : undefined;
    const revoke = async () => {
      if (launchTarget) await account!.revokeWorkerLaunch(launchTarget).catch(() => {});
    };
    let brief: string;
    try {
      brief = makeBrief(token);
    } catch (error) {
      await revoke();
      if (!this.#closing)
        this.#append({
          project,
          kind: "session.released",
          payload: {
            ticket: worker.ticket,
            session: worker.session,
            reason: "Worker brief refused before native launch",
          },
        });
      this.#checkpoint(project, {
        type: "receipt",
        key,
        input,
        ...(this.#closing
          ? {
              ticket: worker.ticket,
              session: worker.session,
              generation,
              branch,
              nativeStarted: false,
              workspaceDisposed: true,
            }
          : {}),
        result: { ok: false, code: "brief_refused" },
      });
      throw error;
    }
    if (launch)
      this.#checkpoint(project, {
        type: "launch-intent",
        key,
        input,
        ...worker,
        branch,
        runtime: route.cli,
        hosted: true,
        launchId: launch.worker.id,
        step: "preparing",
      });
    const revision = tables?.rules?.revision;
    const checkLaunch = () => {
      beforeWrite();
      if (this.#closing) throw new Error("Worker service is stopping");
      for (const event of evaluateBudget({
        project,
        events: this.#options.store.readSince(0, project),
        now: this.#at(),
      }))
        this.#options.store.append(event);
      const fresh = this.#tables(project);
      const budgetHolds = fresh?.holds.filter((hold) => hold.reason.startsWith("budget:")) ?? [];
      if (budgetHolds.length) throw new WorkerRefusal(`Project paused: ${budgetHolds.map((h) => h.reason).join("; ")}`);
      const current = fresh?.sessions.find((s) => s.ticket === args.ticket);
      if (
        !current ||
        current.session !== worker.session ||
        current.generation !== generation ||
        ended(current.phase) ||
        fresh?.rules?.revision !== revision
      )
        throw new Error("Launch prerequisites changed");
      const freshTicket = fresh?.tickets.find((t) => t.id === args.ticket);
      if (!freshTicket || ["completed", "canceled"].includes(freshTicket.status))
        throw new Error("Ticket closed during preparation");
      if (args.branch === undefined && freshTicket.branchName !== branch)
        throw new WorkerRefusal("The ticket branch changed during preparation; nothing was launched");
      if (
        !freshTicket.labels?.includes("ready-for-agent") ||
        freshTicket.labels.includes("parked") ||
        !freshTicket.blockers ||
        freshTicket.blockers.some((b) => !["completed", "canceled"].includes(b.status))
      )
        throw new WorkerRefusal(`${args.ticket} launch prerequisites changed; nothing was launched`);
      if (JSON.stringify(workerRoute(fresh?.rules?.value, freshTicket, args)) !== JSON.stringify(route))
        throw new Error("Ticket routing changed during preparation");
      if (
        max != null &&
        (fresh?.sessions.filter((s) => s.session !== worker.session && !ended(s.phase)).length ?? 0) >= max
      )
        throw new Error("Worker capacity changed during preparation");
    };
    let workspace: Workspace | undefined;
    const retainNotStarted = async () => {
      let workspaceDisposed = false;
      if (workspace && node?.dispose && !resume) {
        try {
          await node.dispose(workspace);
          workspaceDisposed = true;
        } catch {
          /* Preserve dirty work. */
        }
      }
      await revoke();
      this.#checkpoint(project, {
        type: "receipt",
        key,
        input,
        ticket: worker.ticket,
        session: worker.session,
        generation,
        branch,
        nativeStarted: false,
        workspaceDisposed,
        ...(workspace ? { workspace: { ...workspace } } : {}),
        result: { ok: false, code: "daemon_closed_before_launch" },
      });
    };
    try {
      beforeWrite();
      workspace =
        resume?.workspace ??
        (await bound.prepare({
          project,
          ticket: args.ticket,
          repository: hosted ? config.repository : (config.checkout ?? ""),
          ...(hosted ? { labels: ticket.labels, profile: route.model } : {}),
          branch,
        }));
      checkLaunch();
    } catch (error) {
      if (this.#closing) {
        await retainNotStarted();
        throw new WorkerRefusal("Daemon stopped before native launch; ticket retained for recovery");
      }
      if (workspace && node?.dispose) await node.dispose(workspace).catch(() => {});
      await revoke();
      this.#append({
        project,
        kind: "session.released",
        payload: {
          ticket: worker.ticket,
          session: worker.session,
          reason: error instanceof WorkerRefusal ? error.message : "Workspace preparation failed",
        },
      });
      // No CLI launch was attempted: a known workspace refusal must not strand this ticket.
      this.#checkpoint(project, {
        type: "receipt",
        key,
        input,
        result:
          error instanceof WorkerRefusal
            ? refuse("worker_refused", error.message, "fleet.status")
            : refuse(
                "workspace_prepare_failed",
                "Workspace preparation failed before launch",
                "worker.launch again after the workspace provider recovers",
              ),
      });
      if (error instanceof WorkerRefusal) throw error;
      throw new Error("Workspace preparation failed before launching a CLI");
    }
    const prepared = workspace;
    const reservedHandle = hosted ? undefined : randomUUID();
    this.#checkpoint(project, {
      type: "launch",
      ticket: worker.ticket,
      session: worker.session,
      generation,
      runtime: route.cli,
      branch,
      ...(reservedHandle
        ? {
            handle: reservedHandle,
            workspace: { ...prepared },
            node: nodeKind,
            capabilityHash: hash(token),
            runtimeRecovery: { native: true, stream: true },
          }
        : {}),
      step: "starting",
    });
    let enteredProvider = false;
    await progress("starting");
    let ref: WorkerRef;
    try {
      ref = await guarded(worker, checkLaunch, () => {
        enteredProvider = true;
        return bound.launch({
          workspace: prepared,
          ...(reservedHandle ? { handle: reservedHandle } : {}),
          worker,
          ...(hosted ? { brief, labels: ticket.labels } : {}),
          command: "",
          args: [...(route.model ? ["--model", route.model] : []), ...(route.effort ? ["--effort", route.effort] : [])],
          env: {
            ...(hosted ? {} : { ARMADA_WORKER_SOCKET: this.#options.socketPath, ARMADA_WORKER_TOKEN: token }),
            ARMADA_TICKET: args.ticket,
          },
        });
      });
    } catch (error) {
      if (this.#closing) {
        if (!enteredProvider || isRuntimeLaunchRefusal(error)) await retainNotStarted();
        throw new WorkerRefusal("Daemon stopped during launch; ticket retained for recovery");
      }
      if (!enteredProvider || isRuntimeLaunchRefusal(error)) {
        if (node?.dispose) await node.dispose(prepared).catch(() => {});
        await revoke();
        this.#append({
          project,
          kind: "session.released",
          payload: { ticket: worker.ticket, session: worker.session, reason: "Launch refused" },
        });
        this.#checkpoint(project, {
          type: "receipt",
          key,
          input,
          result: refuse(
            "launch_refused",
            "The runtime refused the launch",
            "fleet.status, then worker.launch after resolving the runtime refusal",
          ),
        });
      }
      // Once a provider was entered, an error without a handle has an unknown native outcome.
      throw error;
    }
    if (
      ref.project !== project ||
      ref.ticket !== worker.ticket ||
      ref.session !== worker.session ||
      ref.generation !== generation ||
      !ref.handle ||
      (reservedHandle !== undefined && ref.handle !== reservedHandle) ||
      ref.handle.includes(token)
    )
      throw new Error("Runtime returned a different worker generation; launch outcome unknown");
    const row: LiveWorker = {
      ref,
      runtime: bound,
      node,
      workspace,
      tokenHash: hosted ? "" : hash(token),
      mask: (value) => maskHostedText(value.replaceAll(token, "[redacted]")),
      briefPending: !hosted,
      branch,
      runtimeKind: route.cli,
      ...(launch ? { launchId: launch.worker.id } : {}),
    };
    this.#live.set(ref.session, row);
    const retain = () =>
      this.#checkpoint(project, {
        type: "launch",
        ...(launch ? { hosted: true, launchId: launch.worker.id } : {}),
        ...worker,
        handle: ref.handle,
        workspace: { ...prepared },
        node: hosted ? "conductor" : nodeKind,
        capabilityHash: row.tokenHash,
        runtimeRecovery: { ...bound.checkpoint?.(ref) },
        runtime: route.cli,
        branch,
        step: "launched",
      });
    try {
      checkLaunch();
      retain();
      if (launchTarget) {
        await account!.bindWorkerLaunch({ ...launchTarget, handle: ref.handle });
      } else {
        await progress("briefing");
        await this.#deliver(row, brief, `brief:${worker.session}`, beforeWrite);
        row.briefPending = false;
      }
    } catch (error) {
      if (this.#closing) {
        retain();
        throw new WorkerRefusal("Daemon stopped during launch; worker retained for recovery");
      }
      row.tokenHash = "";
      // A returned handle is owned even if publishing its claim failed. Clean up exactly it.
      await guarded(
        ref,
        () => this.#cleanupCheck(ref),
        () => bound.stop(ref),
      );
      const current = this.#tables(project)?.sessions.find((s) => s.ticket === args.ticket);
      if (current?.session === ref.session && !ended(current.phase))
        this.#append({
          project,
          kind: "session.released",
          payload: { ticket: ref.ticket, session: ref.session, reason: "Launch did not complete" },
        });
      if (launchTarget && config.programRoot)
        await account!
          .releaseHostedWorker(
            {
              slug: project,
              name: config.name ?? project,
              repository: config.repository,
              programRoot: config.programRoot,
            },
            { ticket: worker.ticket, handle: ref.handle, id: launchTarget.id, reason: "Launch did not complete" },
          )
          .catch(() => {});
      if (node?.dispose) await node.dispose(prepared).catch(() => {});
      await revoke();
      this.#checkpoint(project, {
        type: "receipt",
        key,
        input,
        result: refuse(
          "launch_failed",
          "Worker launch did not complete",
          "fleet.status to inspect the worker before worker.relaunch",
        ),
      });
      throw error;
    }
    this.#usage(ref, { state: "starting", usage: "unknown" });
    for (const event of evaluateBudget({ project, events: this.#options.store.readSince(0, project), now: this.#at() }))
      this.#options.store.append(event);
    await progress("launched");
    return {
      ok: true,
      ticket: args.ticket,
      session: ref.session,
      generation,
      runtime: route.cli,
      node: hosted ? workspace.node : nodeKind,
      handle: ref.handle,
    };
  }

  /** Shared with merge execution. A caller supplies the exact historical generation, never just a ticket. */
  async stop(ref: WorkerRef, reason: string, beforeWrite: () => void) {
    return this.#serial(ref.project, async () => {
      this.#check(ref, beforeWrite, true);
      if (!this.#live.has(ref.session)) {
        await this.#adopt(ref, true).catch(() => {});
        this.#check(ref, beforeWrite, true);
      }
      if (!this.#live.has(ref.session)) {
        const completed = this.#finishStopped(ref, reason, beforeWrite);
        if (completed) return completed;
      }
      if (this.#lost.has(ref.session)) {
        return this.#stopLost(ref, reason, beforeWrite);
      }
      const row = this.#row(ref.project, ref.ticket, true);
      if (!same(row.ref, ref)) throw new WorkerRefusal("Worker generation changed; runtime untouched");
      return this.#stop(row, reason, beforeWrite, true);
    });
  }

  #finishStopped(ref: WorkerRef, reason: string, beforeWrite: () => void): Record<string, Json> | undefined {
    const confirmed = this.#options.store.readSince(0, ref.project).some((event) => {
      const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
      return (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        c.format === "armada.worker" &&
        c.type === "native-stopped" &&
        c.session === ref.session &&
        c.generation === ref.generation &&
        c.handle === ref.handle
      );
    });
    if (!confirmed) return;
    this.#check(ref, beforeWrite, true);
    this.#append({
      project: ref.project,
      kind: "session.released",
      payload: { ticket: ref.ticket, session: ref.session, reason },
    });
    return { ok: true, session: ref.session, stopped: true, disposed: false };
  }

  #retire(row: LiveWorker) {
    row.tokenHash = "";
    this.#checkpoint(row.ref.project, {
      type: "capability-retired",
      session: row.ref.session,
      generation: row.ref.generation,
    });
  }

  async #stop(
    row: LiveWorker,
    reason: string,
    beforeWrite: () => void,
    dispose: boolean,
  ): Promise<Record<string, Json>> {
    this.#check(row.ref, beforeWrite, true);
    this.#retire(row);
    await guarded(
      row.ref,
      () => this.#check(row.ref, beforeWrite, true),
      () => row.runtime.stop(row.ref),
    );
    const stopped = await row.runtime.observe(row.ref);
    this.#check(row.ref, beforeWrite, true);
    this.#record(row.ref, stopped);
    // Hosted cancellation ends the active turn; its session remains available in an idle workspace.
    const confirmed =
      stopped.state === "stopped" ||
      stopped.state === "failed" ||
      (row.runtime.needsLaunchToken && stopped.state === "running" && stopped.activity === "idle");
    if (!confirmed) throw new WorkerRefusal("Runtime has not confirmed the worker stopped; generation retained");
    if (row.runtime.needsLaunchToken) {
      const project = this.#options.projects.find((project) => project.id === row.ref.project);
      if (!project?.programRoot || !row.launchId || !this.#options.account)
        throw new Error("Hosted release identity unavailable");
      await this.#options.account.releaseHostedWorker(
        {
          slug: project.id,
          name: project.name ?? project.id,
          repository: project.repository,
          programRoot: project.programRoot,
        },
        {
          ticket: row.ref.ticket,
          handle: row.ref.handle,
          id: row.launchId,
          reason,
          terminal:
            this.#tables(row.ref.project)?.sessions.find((session) => session.session === row.ref.session)?.phase ===
            "merged"
              ? "merged"
              : "released",
        },
      );
      this.#check(row.ref, beforeWrite, true);
    }
    // Keep host proof before disposal can remove the supervisor's terminal metadata.
    this.#checkpoint(row.ref.project, { type: "native-stopped", ...row.ref });
    this.#append({
      project: row.ref.project,
      kind: "session.released",
      payload: { ticket: row.ref.ticket, session: row.ref.session, reason },
    });
    let disposed = false;
    if (dispose && row.runtime.archive) {
      await guarded(
        row.ref,
        () => this.#check(row.ref, beforeWrite, true),
        () => row.runtime.archive!(row.ref),
      );
      disposed = true;
    }
    if (dispose && row.node?.dispose) {
      this.#check(row.ref, beforeWrite, true);
      try {
        await row.node.dispose(row.workspace);
        disposed = true;
      } catch {
        /* Dirty or unpushed work stays recoverable. */
      }
    }
    return { ok: true, session: row.ref.session, stopped: true, disposed };
  }

  async #deliver(row: LiveWorker, message: string, key: string, beforeWrite: () => void) {
    const prior = this.#options.store.readSince(0, row.ref.project).find((e) => {
      const c = e.kind === "coordinator.checkpoint" ? e.payload.checkpoint : null;
      return (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        c.format === "armada.worker" &&
        c.type === "delivered" &&
        c.session === row.ref.session &&
        c.key === hash(key)
      );
    });
    if (prior?.kind === "coordinator.checkpoint") {
      const checkpoint = prior.payload.checkpoint as Record<string, Json>;
      const textHash = checkpoint.textHash ?? checkpoint.messageHash;
      if (textHash && textHash !== hash(message)) throw new Error("Delivery key already used with different message");
      this.#check(row.ref, beforeWrite);
      return;
    }
    await guarded(
      row.ref,
      () => this.#check(row.ref, beforeWrite),
      () => row.runtime.deliver(row.ref, message, key),
    );
    this.#check(row.ref, beforeWrite);
    // Message contents and credentials do not enter event history.
    this.#checkpoint(row.ref.project, {
      type: "delivered",
      session: row.ref.session,
      ticket: row.ref.ticket,
      key: hash(key),
      textHash: hash(message),
    });
  }

  /** Recover only a uniquely named native session, never a worker-supplied arbitrary handle or a second create. */
  async recoverHosted(project: string): Promise<void> {
    return this.#serial(project, async () => {
      if (this.#closing || !this.#options.account) return;
      const config = this.#options.projects.find((projectConfig) => projectConfig.id === project);
      if (!config) return;
      const events = this.#options.store.readSince(0, project);
      const intents = new Map<
        string,
        {
          key: string;
          input: string;
          ticket: string;
          session: string;
          generation: number;
          branch: string;
          runtime: string;
          launchId: string;
          since: string;
        }
      >();
      for (const event of events) {
        const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
        if (
          c &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          c.format === "armada.worker" &&
          c.type === "launch-intent" &&
          c.hosted === true &&
          typeof c.key === "string" &&
          typeof c.input === "string" &&
          typeof c.ticket === "string" &&
          typeof c.session === "string" &&
          typeof c.generation === "number" &&
          typeof c.branch === "string" &&
          typeof c.runtime === "string" &&
          typeof c.launchId === "string"
        )
          intents.set(c.session, {
            key: c.key,
            input: c.input,
            ticket: c.ticket,
            session: c.session,
            generation: c.generation,
            branch: c.branch,
            runtime: c.runtime,
            launchId: c.launchId,
            since: event.at,
          });
      }
      for (const intent of intents.values()) {
        if (
          events.some((event) => {
            const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
            return (
              c &&
              typeof c === "object" &&
              !Array.isArray(c) &&
              c.format === "armada.worker" &&
              c.type === "receipt" &&
              c.key === intent.key
            );
          })
        )
          continue;
        const current = this.#tables(project)?.sessions.find((session) => session.ticket === intent.ticket);
        if (
          !current ||
          current.session !== intent.session ||
          current.generation !== intent.generation ||
          ended(current.phase)
        )
          continue;
        const runtime = this.#options.registry.get("runtime", intent.runtime, project);
        if (!runtime?.recover || !runtime.needsLaunchToken) continue;
        const worker = { project, ticket: intent.ticket, session: intent.session, generation: intent.generation };
        const ref = await runtime.recover({
          project,
          ticket: intent.ticket,
          repository: config.repository,
          branch: intent.branch,
          worker,
          since: intent.since,
        });
        if (!ref || !same({ ...worker, handle: ref.handle }, ref) || maskHostedText(ref.handle) !== ref.handle)
          continue;
        const check = () => {
          const fresh = this.#tables(project)?.sessions.find((session) => session.ticket === intent.ticket);
          if (
            this.#closing ||
            !fresh ||
            fresh.session !== intent.session ||
            fresh.generation !== intent.generation ||
            ended(fresh.phase)
          )
            throw new WorkerRefusal("Recovery generation changed; runtime untouched");
        };
        check();
        this.#checkpoint(project, {
          type: "launch",
          ...worker,
          handle: ref.handle,
          hosted: true,
          launchId: intent.launchId,
          branch: intent.branch,
          runtime: intent.runtime,
          step: "launched",
        });
        await this.#options.account.bindWorkerLaunch({
          project,
          ticket: intent.ticket,
          id: intent.launchId,
          handle: ref.handle,
        });
        check();
        await this.#adopt(ref);
        this.#checkpoint(project, {
          type: "receipt",
          key: intent.key,
          input: intent.input,
          result: {
            ok: true,
            ...worker,
            handle: ref.handle,
            runtime: intent.runtime,
            node: "conductor",
            recovered: true,
          },
        });
      }
    });
  }

  /** Called before starting the coordinator, so its first wake includes every recovery result. */
  recover(): Promise<RecoverySummary> {
    this.#recovery ??= (async () => {
      const summary: RecoverySummary = { readopted: [], lost: [] };
      const boot = randomUUID();
      for (const project of this.#options.projects) {
        const history = this.#options.store.readSince(0, project.id);
        if (
          (this.#tables(project.id)?.sessions ?? []).some(
            (session) => !ended(session.phase) && session.runtime !== "tracker",
          ) ||
          history.some((event) => event.kind === "worker.readopted" || event.kind === "worker.lost")
        )
          this.#checkpoint(project.id, { type: "recovery", boot });
        await this.recoverHosted(project.id).catch(() => {});
        await this.#serial(project.id, async () => {
          for (const session of this.#tables(project.id)?.sessions ?? []) {
            if (ended(session.phase) || session.runtime === "tracker") continue;
            const ref = {
              project: project.id,
              ticket: session.ticket,
              session: session.session,
              generation: session.generation,
              handle: session.handle,
            };
            try {
              if (!this.#live.has(ref.session)) await this.#adopt(ref);
              this.#check(ref);
              this.#append({
                project: project.id,
                kind: "worker.readopted",
                payload: {
                  ticket: ref.ticket,
                  session: ref.session,
                  generation: ref.generation,
                  handle: ref.handle,
                  boot,
                  ...(this.#live.get(ref.session)?.briefPending ? { briefPending: true } : {}),
                },
              });
              summary.readopted.push(ref);
            } catch (error) {
              // A delayed observation can never label a replacement as lost.
              try {
                this.#check(ref);
              } catch {
                continue;
              }
              if (this.#closing) continue;
              if (!this.#observations.has(ref.session)) this.#record(ref, { state: "unknown" });
              const detail =
                error instanceof WorkerRefusal ? error.message : "Runtime observation or reattachment failed";
              const reason = `${detail}; relaunch or release, never assume it runs`;
              this.#lost.add(ref.session);
              this.#append({
                project: project.id,
                kind: "worker.lost",
                payload: {
                  ticket: ref.ticket,
                  session: ref.session,
                  generation: ref.generation,
                  handle: ref.handle,
                  reason,
                  boot,
                },
              });
              summary.lost.push({ ...ref, reason });
            }
          }
        });
        if (!this.#closing)
          for (const event of evaluateBudget({
            project: project.id,
            events: this.#options.store.readSince(0, project.id),
            now: this.#at(),
          }))
            this.#options.store.append(event);
      }
      return summary;
    })();
    return this.#recovery;
  }

  #notStarted(project: string, session: string) {
    return this.#options.store
      .readSince(0, project)
      .flatMap((event) => {
        const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
        return c &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          c.format === "armada.worker" &&
          c.type === "receipt" &&
          c.session === session &&
          c.nativeStarted === false
          ? [c]
          : [];
      })
      .at(-1);
  }

  async #adopt(ref: WorkerRef, allowEnded = false) {
    if (this.#notStarted(ref.project, ref.session))
      throw new WorkerRefusal("Daemon closed before native launch; no worker was started");
    const events = this.#options.store.readSince(0, ref.project);
    const launch = events
      .flatMap((event) => {
        const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
        return c &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          c.format === "armada.worker" &&
          c.version === 1 &&
          c.type === "launch" &&
          (c.step === "launched" || (c.step === "starting" && c.hosted !== true)) &&
          c.ticket === ref.ticket &&
          c.session === ref.session &&
          c.generation === ref.generation &&
          c.handle === ref.handle
          ? [c]
          : [];
      })
      .at(-1);
    if (!launch || typeof launch.runtime !== "string") throw new WorkerRefusal("Worker recovery facts unavailable");
    let runtime = this.#options.registry.get("runtime", launch.runtime, ref.project);
    if (!runtime) throw new WorkerRefusal("Worker runtime unavailable");
    const hosted = runtime.needsLaunchToken;
    const node =
      !hosted && typeof launch.node === "string"
        ? this.#options.registry.get("node", launch.node, ref.project)
        : undefined;
    const workspace = z
      .object({ id: z.string(), path: z.string(), node: z.string() })
      .parse(launch.workspace ?? (hosted ? { id: ref.handle, path: "", node: "conductor" } : null));
    if (!hosted) {
      if (!node || !runtime.withNode) throw new WorkerRefusal("Worker node unavailable");
      runtime = runtime.withNode(node);
      if (!runtime.adopt) throw new WorkerRefusal("Worker runtime cannot reattach");
      const recovery = z
        .object({ native: z.boolean().optional(), stream: z.boolean().optional() })
        .parse(launch.runtimeRecovery ?? {});
      await runtime.adopt(ref, workspace, { ...recovery, starting: launch.step === "starting" });
    }
    this.#check(ref, () => {}, allowEnded);
    const row: LiveWorker = {
      ref,
      runtime,
      node,
      workspace,
      tokenHash:
        hosted ||
        events.some((e) => {
          const c = e.kind === "coordinator.checkpoint" ? e.payload.checkpoint : null;
          return (
            c &&
            typeof c === "object" &&
            !Array.isArray(c) &&
            c.format === "armada.worker" &&
            c.type === "capability-retired" &&
            c.session === ref.session &&
            c.generation === ref.generation
          );
        })
          ? ""
          : z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(launch.capabilityHash),
      briefPending:
        !hosted &&
        !events.some((event) => {
          const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
          return (
            c &&
            typeof c === "object" &&
            !Array.isArray(c) &&
            c.format === "armada.worker" &&
            c.session === ref.session &&
            (c.type === "recovery-handoff" || (c.type === "delivered" && c.key === hash(`brief:${ref.session}`)))
          );
        }),
      mask: maskHostedText,
      branch: typeof launch.branch === "string" ? launch.branch : "",
      runtimeKind: launch.runtime,
      ...(typeof launch.launchId === "string" ? { launchId: launch.launchId } : {}),
    };
    this.#unconfirmed.set(ref.session, row);
    const observation = await runtime.observe(ref);
    this.#check(ref, () => {}, allowEnded);
    if (this.#closing) throw new WorkerRefusal("Daemon is closing");
    this.#record(ref, observation);
    const terminalCleanup =
      allowEnded &&
      ended(this.#tables(ref.project)?.sessions.find((session) => session.session === ref.session)?.phase ?? "");
    if (!["starting", "running", ...(terminalCleanup ? ["stopped", "failed"] : [])].includes(observation.state))
      throw new WorkerRefusal(`Worker runtime reported ${observation.state}`);
    this.#live.set(ref.session, row);
    this.#unconfirmed.delete(ref.session);
    this.#lost.delete(ref.session);
  }

  async #stopLost(ref: WorkerRef, reason: string, beforeWrite: () => void): Promise<Record<string, Json>> {
    const candidate = this.#unconfirmed.get(ref.session);
    if (candidate) {
      try {
        return await this.#stop(candidate, reason, beforeWrite, true);
      } catch {
        this.#check(ref, beforeWrite);
      }
    }
    // Explicit Release remains possible for a lost worker. This retires its ticket;
    // it deliberately makes no claim that an unreachable native process was stopped.
    return this.#releaseLost(
      ref.project,
      ref.ticket,
      ref.session,
      `Lost worker released without a confirmed runtime stop: ${reason}`,
      beforeWrite,
    );
  }

  #releaseLost(
    project: string,
    ticket: string,
    session: string,
    reason: string,
    beforeWrite: () => void,
  ): Record<string, Json> {
    beforeWrite();
    const current = this.#tables(project)?.sessions.find((s) => s.ticket === ticket);
    if (!current || current.session !== session || ended(current.phase) || !this.#lost.has(session))
      throw new WorkerRefusal("Lost worker generation changed; nothing released");
    this.#append({ project, kind: "session.released", payload: { ticket, session, reason } });
    return { ok: true, session, stopped: false, released: true };
  }

  /** Read only the pinned generation; unsupported runtime tails are empty. */
  async transcript(project: string, session: { ticket: string; session: string; generation: number }): Promise<string> {
    const row = this.#row(project, session.ticket);
    if (row.ref.session !== session.session || row.ref.generation !== session.generation)
      throw new WorkerRefusal("Transcript generation changed");
    this.#check(row.ref);
    const tail = (await row.runtime.transcript?.(row.ref, 4096)) ?? "";
    this.#check(row.ref);
    return maskedTail(tail, row.mask);
  }

  async observe(project: string, ticket: string): Promise<WorkerObservation> {
    const row = this.#row(project, ticket);
    const previous = this.#reads.get(row.ref.session);
    if (previous) return previous;
    const reading = (async () => {
      const observation = await row.runtime.observe(row.ref);
      this.#check(row.ref);
      this.#record(row.ref, observation);
      return { ...observation, ...(observation.reply ? { reply: row.mask(observation.reply) } : {}) };
    })().finally(() => {
      this.#reads.delete(row.ref.session);
    });
    this.#reads.set(row.ref.session, reading);
    return reading;
  }
  #usage(ref: WorkerRef, observation: WorkerObservation) {
    const parsed = reportedUsageSchema.safeParse(observation.usage ?? "unknown");
    const usage = parsed.success ? parsed.data : "unknown";
    const prior = this.#options.store
      .readSince(0, ref.project)
      .findLast((e) => e.kind === "session.usage" && e.payload.session === ref.session);
    const zone = this.#tables(ref.project)?.rules?.value.policy?.budget?.zone ?? "UTC";
    if (
      prior?.kind === "session.usage" &&
      usageTime(prior.at, zone).day === usageTime(this.#at(), zone).day &&
      JSON.stringify(prior.payload.usage) === JSON.stringify(usage)
    )
      return;
    this.#append(
      {
        project: ref.project,
        kind: "session.usage",
        payload: { ticket: ref.ticket, session: ref.session, generation: ref.generation, usage },
      },
      "daemon",
    );
  }
  #record(ref: WorkerRef, observation: WorkerObservation) {
    this.#usage(ref, observation);
    const value = JSON.stringify({ state: observation.state, activity: observation.activity });
    if (this.#observations.get(ref.session) === value) return;
    this.#append({
      project: ref.project,
      kind: "session.runtime-observed",
      payload: {
        ticket: ref.ticket,
        session: ref.session,
        generation: ref.generation,
        state: observation.state,
        ...(observation.activity ? { activity: observation.activity } : {}),
      },
    });
    this.#observations.set(ref.session, value);
  }
  observeAll(): Promise<void> {
    if (this.#observing) return this.#observing;
    this.#observing = (async () => {
      for (const row of this.#live.values()) {
        const now = Date.parse(this.#at());
        if (row.runtime.needsLaunchToken && now - (this.#lastRead.get(row.ref.session) ?? -Infinity) < 15_000) continue;
        this.#lastRead.set(row.ref.session, now);
        try {
          await this.observe(row.ref.project, row.ref.ticket);
        } catch {
          /* Ended/stale generations never mutate the replacement. */
        }
      }
    })().finally(() => {
      this.#observing = undefined;
    });
    return this.#observing;
  }

  /** Authenticate from the issued capability, never from caller-supplied project/session ownership. */
  async request(token: string, input: unknown): Promise<Record<string, Json>> {
    const request = workerRequestSchema.parse(input);
    await this.#recovery;
    const row = [...this.#live.values()].find((row) => row.tokenHash && row.tokenHash === hash(token));
    if (!row) throw new Error("Worker authorization refused");
    return this.#serial<Record<string, Json>>(row.ref.project, async (): Promise<Record<string, Json>> => {
      if (this.#closing || !row.tokenHash || row.tokenHash !== hash(token))
        throw new Error("Worker capability retired");
      this.#check(row.ref);
      if (request.ticket !== row.ref.ticket) {
        if (request.command === "ticket") throw new WorkerTicketScopeRefusal(row.ref.ticket);
        throw new Error("Worker authorization refused");
      }
      const { project, ticket, session } = row.ref;
      if (request.command === "ticket")
        return { ...workerTicket(this.#options.store.readSince(0, project), project, ticket) };
      const mask = (value: string) => row.mask(value.replaceAll(token, "[redacted]"));
      if (request.command === "claim") {
        if (
          !this.#options.store
            .readSince(0, project)
            .some((e) => e.kind === "session.claimed" && e.payload.session === session)
        )
          this.#append(
            {
              project,
              kind: "session.claimed",
              payload: {
                ticket,
                session,
                generation: row.ref.generation,
                handle: row.ref.handle,
                runtime: row.runtimeKind,
                owner: "coordinator",
              },
            },
            `worker:${session}`,
          );
        return { ok: true, ticket, session, generation: row.ref.generation, handle: row.ref.handle };
      }
      if (request.command === "heartbeat")
        this.#append({ project, kind: "session.heartbeat", payload: { ticket, session } });
      else if (request.command === "report") {
        if (request.phase === "ready-to-merge" && (!request.pr || !request.sha))
          throw new Error("A hand-back needs its pull request and full head SHA");
        this.#append({
          project,
          kind: "session.reported",
          payload: {
            ticket,
            session,
            phase: request.phase,
            reason: mask(request.message),
            ...(request.stage ? { stage: request.stage } : {}),
          },
        });
        if (request.phase === "awaiting-approval" || request.phase === "ready-to-merge") {
          const body =
            request.phase === "ready-to-merge"
              ? `Agent status: ready-to-merge — PR #${request.pr}, head ${request.sha}\n\n${mask(request.message)}`
              : mask(request.message);
          this.#append(
            {
              project,
              kind: "inbox.opened",
              payload: {
                id: `worker:${session}:${hash(body)}`,
                ticket,
                kind: request.phase === "ready-to-merge" ? "hand-back" : "plan",
                body,
              },
            },
            `worker:${session}`,
          );
        }
      } else if (request.command === "ask") {
        const item = `worker:${session}:${hash(request.key)}`;
        if (
          !this.#options.store.readSince(0, project).some((e) => e.kind === "inbox.opened" && e.payload.id === item)
        ) {
          this.#append(
            {
              project,
              kind: "inbox.opened",
              payload: { id: item, ticket, kind: "question", body: mask(request.question) },
            },
            `worker:${session}`,
          );
          this.#append({
            project,
            kind: "session.reported",
            payload: { ticket, session, phase: "blocked", reason: mask(request.question) },
          });
        }
        return { ok: true, id: item };
      } else if (request.command === "release") {
        // A release retires authorization; it does not send a signal to a still-running CLI.
        row.tokenHash = "";
        this.#append({
          project,
          kind: "session.released",
          payload: { ticket, session, reason: mask(request.reason) },
        });
        // Final counters are unverified: retain their known floor without waiting on a runtime read.
        try {
          this.#usage(row.ref, { state: "unknown", usage: "unknown" });
        } catch {
          console.warn("armada: worker released; final usage checkpoint unavailable");
        }
      }
      return { ok: true, ticket, session };
    });
  }

  async answer(
    input: {
      key: string;
      item?: string;
      session: { ticket: string; session: string };
      answer: string;
      beforeWrite: () => void;
    },
    project: string,
  ) {
    const row = this.#row(project, input.session.ticket);
    if (row.ref.session !== input.session.session) throw new Error("Answer generation changed");
    await this.#deliver(row, input.answer, input.key, input.beforeWrite);
    if (row.runtime.needsLaunchToken && input.item?.startsWith("armada:inbox:")) {
      const config = this.#options.projects.find((p) => p.id === project);
      const item = Number(/^armada:inbox:(\d+)(?::[a-f0-9]+)?$/.exec(input.item)?.[1]);
      if (!config?.programRoot || !this.#options.account || !Number.isSafeInteger(item) || item < 1)
        throw new Error("Hosted answer identity unavailable");
      this.#check(row.ref, input.beforeWrite);
      await this.#options.account.workerFleet(
        { slug: project, name: config.name ?? project, repository: config.repository, programRoot: config.programRoot },
        "answer",
        { item, ticket: row.ref.ticket, text: input.answer, note: false },
      );
      this.#check(row.ref, input.beforeWrite);
    }
    return true;
  }

  #cleanupCheck(ref: WorkerRef) {
    const current = this.#tables(ref.project)?.sessions.find((s) => s.ticket === ref.ticket);
    if (current && current.handle === ref.handle && !same({ project: ref.project, ...current }, ref))
      throw new Error("Worker handle reused by a different generation");
  }

  /** Stop only host scheduling. The supervisor and hosted workspaces own their workers. */
  async close() {
    this.#closing = true;
    this.#stopForge();
    await this.#outbox.close();
    await Promise.allSettled([...this.#queues.values()]);
    await this.#observing;
    await Promise.allSettled([...this.#reads.values()]);
  }

  /** Owner-only explicit shutdown; attempt every generation and report partial failures. */
  async shutdown(project: string, reason: string, beforeWrite: () => void) {
    if (!reason.trim()) throw new WorkerRefusal("Fleet shutdown needs a reason");
    return this.#serial(project, async () => {
      const sessions = this.#tables(project)?.sessions.filter((s) => !ended(s.phase) && s.runtime !== "tracker") ?? [];
      const released: string[] = [];
      const failed: string[] = [];
      for (const session of sessions) {
        try {
          beforeWrite();
          if (this.#lost.has(session.session)) {
            await this.#adopt({
              project,
              ticket: session.ticket,
              session: session.session,
              generation: session.generation,
              handle: session.handle,
            }).catch(() => {});
            beforeWrite();
          }
          const row = this.#live.get(session.session);
          if (row) await this.#stop(row, reason, beforeWrite, false);
          else if (this.#unconfirmed.has(session.session))
            await this.#stop(this.#unconfirmed.get(session.session)!, reason, beforeWrite, false);
          else throw new WorkerRefusal("Worker runtime is unavailable; stop could not be confirmed");
          released.push(session.ticket);
        } catch {
          failed.push(session.ticket);
        }
      }
      return { ok: failed.length === 0, released, failed };
    });
  }
}
