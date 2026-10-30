import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NodeProvider, RuntimeProvider, WorkerObservation, WorkerRef, Workspace } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import { activePhaseSchema } from "@armada/protocol";
import { z } from "zod";
import type { EventInput, Json } from "../events.ts";
import { fold } from "../fold.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { EventStore } from "../store.ts";
import { workerBrief } from "./brief.ts";
import { workerRoute } from "./routing.ts";

interface WorkerProject {
  id: string;
  repository: string;
  checkout: string;
  tracker?: string;
}
interface Options {
  store: EventStore;
  registry: PluginRegistry;
  projects: readonly WorkerProject[];
  socketPath: string;
  now?: () => string;
  /** Host refresh commits a provider checkpoint only on success; actions require that evidence. */
  refresh?: (project: string) => Promise<void>;
}
interface LiveWorker {
  ref: WorkerRef;
  runtime: RuntimeProvider;
  node: NodeProvider;
  workspace: Workspace;
  tokenHash: string;
  mask: (value: string) => string;
  deliveries: Map<string, string>;
  branch: string;
  runtimeKind: string;
}
const id = z.string().min(1).max(200).regex(/\S/);
export class WorkerRefusal extends Error {}
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
  readonly #live = new Map<string, LiveWorker>();
  readonly #observations = new Map<string, string>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #closing = false;
  readonly #removing = new Set<string>();
  constructor(options: Options) {
    this.#options = options;
  }
  #at() {
    return this.#options.now?.() ?? new Date().toISOString();
  }
  #tables(project: string) {
    return fold(this.#options.store.readSince(0, project)).projects[project];
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
        result = await this.#launch(project, launch, key, input, beforeWrite);
      } else {
        const action = parsed as { ticket: string; session?: string };
        const row = this.#row(project, action.ticket, name !== "worker.message");
        if (
          (action.session && action.session !== row.ref.session) ||
          previous.some((c) => c.session && c.session !== row.ref.session)
        )
          throw new WorkerRefusal(`${action.ticket}'s worker generation changed; nothing was released`);
        if (name === "worker.relaunch") {
          const relaunch = workerToolSchemas["worker.relaunch"].parse(parsed);
          if (!relaunch.reason.trim()) throw new WorkerRefusal('relaunch needs --reason "<why>"');
          // V1 cli/src/relaunch.ts: complete preflight before ending the old generation.
          const facts = this.#launchFacts(project, { ...relaunch, branch: row.branch }, row.ref);
          if (facts.node !== row.node)
            throw new WorkerRefusal("Replacement placement changed; keep the existing workspace and inspect its node");
          this.#checkpoint(project, {
            type: "relaunch-intent",
            key,
            input,
            ticket: row.ref.ticket,
            session: row.ref.session,
          });
          await this.#stop(row, `relaunch: ${relaunch.reason}`, beforeWrite, false);
          result = await this.#launch(project, { ...relaunch, branch: row.branch }, key, input, beforeWrite, row);
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
            await this.#deliver(row, message, key, beforeWrite);
            result = { ok: true, session: row.ref.session, delivery: "confirmed" };
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
          !pending.some((done) => done.type === "receipt" && done.key === c.key),
      )
    )
      throw new WorkerRefusal("Ticket has an unresolved launch intent; inspect its process before relaunching");
    const tables = this.#tables(project);
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
    if (!runtime || !node) throw new WorkerRefusal("Selected runtime or node provider is unavailable");
    if (!runtime.withNode) throw new WorkerRefusal("Runtime cannot bind the selected node");
    const branch = args.branch ?? ticket.branchName;
    if (!branch) throw new WorkerRefusal(`${ticket.id} has no suggested branch in Linear`);
    return { config, tables, ticket, rules, route, nodeKind, max, bound: runtime.withNode(node), node, branch };
  }

  async #launch(
    project: string,
    args: z.infer<(typeof workerToolSchemas)["worker.launch"]>,
    key: string,
    input: string,
    beforeWrite: () => void,
    resume?: LiveWorker,
  ) {
    const { config, tables, ticket, route, nodeKind, max, bound, node, branch } = this.#launchFacts(project, args);
    const generation =
      Math.max(0, ...tables.sessions.filter((s) => s.ticket === args.ticket).map((s) => s.generation)) + 1;
    const worker = { project, ticket: args.ticket, session: randomUUID(), generation };
    const token = randomBytes(32).toString("base64url");
    beforeWrite();
    this.#checkpoint(project, {
      type: "launch-intent",
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
    const revision = tables?.rules?.revision;
    const checkLaunch = () => {
      beforeWrite();
      if (this.#closing) throw new Error("Worker service is stopping");
      const fresh = this.#tables(project);
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
    try {
      workspace =
        resume?.workspace ??
        (await bound.prepare({
          project,
          ticket: args.ticket,
          repository: config.checkout,
          branch,
        }));
      checkLaunch();
    } catch {
      if (workspace && node.dispose) await node.dispose(workspace).catch(() => {});
      this.#append({
        project,
        kind: "session.released",
        payload: { ticket: worker.ticket, session: worker.session, reason: "Workspace preparation failed" },
      });
      // No CLI launch was attempted: a known workspace refusal must not strand this ticket.
      this.#checkpoint(project, {
        type: "receipt",
        key,
        input,
        result: { ok: false, code: "workspace_prepare_failed" },
      });
      throw new Error("Workspace preparation failed before launching a CLI");
    }
    const prepared = workspace;
    this.#checkpoint(project, {
      type: "launch",
      ticket: worker.ticket,
      session: worker.session,
      generation,
      runtime: route.cli,
      branch,
      step: "starting",
    });
    let enteredProvider = false;
    let ref: WorkerRef;
    try {
      ref = await guarded(worker, checkLaunch, () => {
        enteredProvider = true;
        return bound.launch({
          workspace: prepared,
          worker,
          command: "",
          args: [...(route.model ? ["--model", route.model] : []), ...(route.effort ? ["--effort", route.effort] : [])],
          env: {
            ARMADA_WORKER_SOCKET: this.#options.socketPath,
            ARMADA_WORKER_TOKEN: token,
            ARMADA_TICKET: args.ticket,
          },
        });
      });
    } catch (error) {
      if (!enteredProvider) {
        if (node.dispose) await node.dispose(prepared).catch(() => {});
        this.#append({
          project,
          kind: "session.released",
          payload: { ticket: worker.ticket, session: worker.session, reason: "Launch refused" },
        });
        this.#checkpoint(project, { type: "receipt", key, input, result: { ok: false, code: "launch_refused" } });
      }
      // Once a provider was entered, an error without a handle has an unknown native outcome.
      throw error;
    }
    if (
      ref.project !== project ||
      ref.ticket !== worker.ticket ||
      ref.session !== worker.session ||
      ref.generation !== generation ||
      !ref.handle
    )
      throw new Error("Runtime returned a different worker generation; launch outcome unknown");
    const row: LiveWorker = {
      ref,
      runtime: bound,
      node,
      workspace,
      tokenHash: hash(token),
      mask: (value) => value.replaceAll(token, "[redacted]"),
      deliveries: new Map(),
      branch,
      runtimeKind: route.cli,
    };
    this.#live.set(ref.session, row);
    try {
      checkLaunch();
      this.#append({
        project,
        kind: "coordinator.checkpoint",
        payload: {
          checkpoint: {
            format: "armada.worker",
            version: 1,
            type: "launch",
            ...worker,
            handle: ref.handle,
            runtime: route.cli,
            branch,
            step: "launched",
          },
        },
      });
      await this.#deliver(
        row,
        workerBrief({
          ticket,
          tables,
          repository: config.repository,
          branch,
          notes: args.brief,
          ...(resume
            ? {
                resume: `Relaunch reason: ${args.reason}. Previous session: ${resume.ref.session}. Continue branch ${branch} in this same worktree.`,
              }
            : {}),
        }),
        `brief:${worker.session}`,
        beforeWrite,
      );
    } catch (error) {
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
      if (node.dispose) await node.dispose(prepared).catch(() => {});
      this.#checkpoint(project, { type: "receipt", key, input, result: { ok: false, code: "launch_failed" } });
      throw error;
    }
    return {
      ok: true,
      ticket: args.ticket,
      session: ref.session,
      generation,
      runtime: route.cli,
      node: nodeKind,
      handle: ref.handle,
    };
  }

  /** Shared with merge execution. A caller supplies the exact historical generation, never just a ticket. */
  async stop(ref: WorkerRef, reason: string, beforeWrite: () => void) {
    return this.#serial(ref.project, async () => {
      this.#check(ref, beforeWrite, true);
      const row = this.#row(ref.project, ref.ticket, true);
      if (!same(row.ref, ref)) throw new WorkerRefusal("Worker generation changed; runtime untouched");
      return this.#stop(row, reason, beforeWrite, true);
    });
  }

  async #stop(
    row: LiveWorker,
    reason: string,
    beforeWrite: () => void,
    dispose: boolean,
  ): Promise<Record<string, Json>> {
    await guarded(
      row.ref,
      () => this.#check(row.ref, beforeWrite, true),
      () => row.runtime.stop(row.ref),
    );
    row.tokenHash = "";
    const stopped = await row.runtime.observe(row.ref);
    this.#check(row.ref, beforeWrite, true);
    this.#record(row.ref, stopped);
    this.#append({
      project: row.ref.project,
      kind: "session.released",
      payload: { ticket: row.ref.ticket, session: row.ref.session, reason },
    });
    let disposed = false;
    if (dispose && row.node.dispose) {
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
    const prior = row.deliveries.get(key);
    if (prior !== undefined) {
      if (prior !== hash(message)) throw new Error("Delivery key already used with different message");
      return;
    }
    await guarded(
      row.ref,
      () => this.#check(row.ref, beforeWrite),
      () => row.runtime.deliver(row.ref, message, key),
    );
    this.#check(row.ref, beforeWrite);
    row.deliveries.set(key, hash(message));
    // Message contents and credentials do not enter event history.
    this.#checkpoint(row.ref.project, {
      type: "delivered",
      session: row.ref.session,
      ticket: row.ref.ticket,
      key: hash(key),
    });
  }

  async observe(project: string, ticket: string): Promise<WorkerObservation> {
    const row = this.#row(project, ticket);
    const observation = await row.runtime.observe(row.ref);
    this.#check(row.ref);
    this.#record(row.ref, observation);
    return { ...observation, ...(observation.reply ? { reply: row.mask(observation.reply) } : {}) };
  }
  #record(ref: WorkerRef, observation: WorkerObservation) {
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
  async observeAll() {
    for (const row of this.#live.values()) {
      try {
        await this.observe(row.ref.project, row.ref.ticket);
      } catch {
        /* Ended/stale generations never mutate the replacement. */
      }
    }
  }

  /** Authenticate from the issued capability, never from caller-supplied project/session ownership. */
  async request(token: string, input: unknown): Promise<Record<string, Json>> {
    const request = workerRequestSchema.parse(input);
    const row = [...this.#live.values()].find((row) => row.tokenHash && row.tokenHash === hash(token));
    if (!row || request.ticket !== row.ref.ticket) throw new Error("Worker authorization refused");
    return this.#serial<Record<string, Json>>(row.ref.project, async (): Promise<Record<string, Json>> => {
      if (this.#closing || !row.tokenHash || row.tokenHash !== hash(token))
        throw new Error("Worker capability retired");
      this.#check(row.ref);
      const { project, ticket, session } = row.ref;
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
            reason: row.mask(request.message),
            ...(request.stage ? { stage: request.stage } : {}),
          },
        });
        if (request.phase === "awaiting-approval" || request.phase === "ready-to-merge") {
          const body =
            request.phase === "ready-to-merge"
              ? `Agent status: ready-to-merge — PR #${request.pr}, head ${request.sha}\n\n${row.mask(request.message)}`
              : row.mask(request.message);
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
              payload: { id: item, ticket, kind: "question", body: row.mask(request.question) },
            },
            `worker:${session}`,
          );
          this.#append({
            project,
            kind: "session.reported",
            payload: { ticket, session, phase: "blocked", reason: row.mask(request.question) },
          });
        }
        return { ok: true, id: item };
      } else if (request.command === "release") {
        // A release retires authorization; it does not send a signal to a still-running CLI.
        row.tokenHash = "";
        this.#append({
          project,
          kind: "session.released",
          payload: { ticket, session, reason: row.mask(request.reason) },
        });
      }
      return { ok: true, ticket, session };
    });
  }

  async answer(
    input: { key: string; session: { ticket: string; session: string }; answer: string; beforeWrite: () => void },
    project: string,
  ) {
    const row = this.#row(project, input.session.ticket);
    if (row.ref.session !== input.session.session) throw new Error("Answer generation changed");
    await this.#deliver(row, input.answer, input.key, input.beforeWrite);
    return true;
  }

  #cleanupCheck(ref: WorkerRef) {
    const current = this.#tables(ref.project)?.sessions.find((s) => s.ticket === ref.ticket);
    if (current && current.handle === ref.handle && !same({ project: ref.project, ...current }, ref))
      throw new Error("Worker handle reused by a different generation");
  }

  async close() {
    this.#closing = true;
    await Promise.allSettled([...this.#queues.values()]);
    // Shutdown attempts every owned generation even if one provider is stuck or fails.
    const results = await Promise.allSettled(
      [...this.#live.values()].map(async (row) => {
        row.tokenHash = "";
        await guarded(
          row.ref,
          () => this.#cleanupCheck(row.ref),
          () => row.runtime.stop(row.ref),
        );
        this.#record(row.ref, { state: "stopped" });
        const current = this.#tables(row.ref.project)?.sessions.find((s) => s.ticket === row.ref.ticket);
        if (current && same({ project: row.ref.project, ...current }, row.ref) && !ended(current.phase))
          this.#append({
            project: row.ref.project,
            kind: "session.released",
            payload: {
              ticket: row.ref.ticket,
              session: row.ref.session,
              reason: "Daemon stopped",
            },
          });
      }),
    );
    const failed = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failed.length) throw new AggregateError(failed, "Some owned workers could not be stopped");
  }
}
