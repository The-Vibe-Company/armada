import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NodeProvider, RuntimeProvider, WorkerObservation, WorkerRef, Workspace } from "@armada/plugin-api";
import { isRuntimeLaunchRefusal } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import { activePhaseSchema } from "@armada/protocol";
import { z } from "zod";
import type { EventInput, Json } from "../events.ts";
import { fold } from "../fold.ts";
import { refuse } from "../merge/refusal.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { Account } from "../server/account.ts";
import type { EventStore } from "../store.ts";
import { workerBrief } from "./brief.ts";
import { maskHostedText } from "./hosted.ts";
import { workerRoute } from "./routing.ts";

interface WorkerProject {
  id: string;
  repository: string;
  checkout?: string;
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
interface LiveWorker {
  ref: WorkerRef;
  runtime: RuntimeProvider;
  node?: NodeProvider;
  workspace: Workspace;
  tokenHash: string;
  mask: (value: string) => string;
  deliveries: Map<string, string>;
  branch: string;
  runtimeKind: string;
  launchId?: string;
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
  readonly #reads = new Map<string, Promise<WorkerObservation>>();
  readonly #lastRead = new Map<string, number>();
  #observing: Promise<void> | undefined;
  readonly #queues = new Map<string, Promise<unknown>>();
  #closing = false;
  constructor(options: Options) {
    this.#options = options;
    for (const project of options.projects) {
      for (const session of this.#tables(project.id)?.sessions ?? []) {
        if (!ended(session.phase) && options.registry.get("runtime", session.runtime)?.needsLaunchToken)
          try {
            this.#row(project.id, session.ticket);
          } catch {
            /* Unconfirmed or unmanaged launches remain inspectable, never adopted. */
          }
      }
    }
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
    let row = current && this.#live.get(current.session);
    if (current && !row) {
      const runtime = this.#options.registry.get("runtime", current.runtime);
      const launch = this.#options.store.readSince(0, project).findLast((event) => {
        const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
        return (
          c &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          c.format === "armada.worker" &&
          c.type === "launch" &&
          c.hosted === true &&
          c.session === current.session &&
          c.handle === current.handle
        );
      });
      if (runtime?.needsLaunchToken && launch) {
        row = {
          ref: { project, ticket, session: current.session, generation: current.generation, handle: current.handle },
          runtime,
          workspace: { id: current.handle, path: "", node: "conductor" },
          tokenHash: "",
          mask: maskHostedText,
          deliveries: new Map(),
          branch: "",
          runtimeKind: current.runtime,
          launchId:
            launch.kind === "coordinator.checkpoint" &&
            launch.payload.checkpoint &&
            typeof launch.payload.checkpoint === "object" &&
            !Array.isArray(launch.payload.checkpoint) &&
            typeof launch.payload.checkpoint.launchId === "string"
              ? launch.payload.checkpoint.launchId
              : undefined,
        };
        this.#live.set(current.session, row);
      }
    }
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

  async tool(
    project: string,
    name: WorkerTool,
    args: unknown,
    key: string,
    beforeWrite: () => void,
  ): Promise<Record<string, Json>> {
    const parsed = workerToolSchemas[name].parse(args);
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
        if (route && this.#options.registry.get("runtime", route.cli)?.needsLaunchToken) {
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
          if (!relaunch.reason.trim()) throw new WorkerRefusal("worker.relaunch needs a reason");
          // V1 cli/src/relaunch.ts: complete preflight before ending the old generation.
          const facts = this.#launchFacts(project, { ...relaunch, branch: row.branch }, row.ref);
          if (facts.bound.needsLaunchToken)
            throw new WorkerRefusal("Conductor relaunch in place is not supported; stop and launch a fresh worker");
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
    const runtime = this.#options.registry.get("runtime", route.cli);
    const node = this.#options.registry.get("node", nodeKind);
    if (!runtime || (!runtime.needsLaunchToken && !node))
      throw new WorkerRefusal("Selected runtime or node provider is unavailable");
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
    const hosted = bound.needsLaunchToken;
    const account = this.#options.account;
    if (hosted && (!account || !config.programRoot)) {
      if (!account) throw new WorkerRefusal("Sign in to Armada in Settings to launch in Conductor");
      throw new WorkerRefusal("Configure the project program root before launching in Conductor");
    }
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
    const brief = workerBrief({
      ticket,
      tables,
      repository: config.repository,
      branch,
      notes: args.brief,
      ...(hosted ? { hosted: { token, apiUrl: account!.apiUrl, profile: route.model, project } } : {}),
      ...(resume
        ? {
            resume: `Relaunch reason: ${args.reason}. Previous session: ${resume.ref.session}. Continue branch ${branch} in this same worktree.`,
          }
        : {}),
    });
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
    } catch {
      if (workspace && node?.dispose) await node.dispose(workspace).catch(() => {});
      await revoke();
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
        result: refuse(
          "workspace_prepare_failed",
          "Workspace preparation failed before launch",
          "worker.launch again after the workspace provider recovers",
        ),
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
      deliveries: new Map(),
      branch,
      runtimeKind: route.cli,
      ...(launch ? { launchId: launch.worker.id } : {}),
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
            ...(launch ? { hosted: true, launchId: launch.worker.id } : {}),
            ...worker,
            handle: ref.handle,
            runtime: route.cli,
            branch,
            step: "launched",
          },
        },
      });
      if (launchTarget) {
        await account!.bindWorkerLaunch({ ...launchTarget, handle: ref.handle });
      } else {
        await this.#deliver(row, brief, `brief:${worker.session}`, beforeWrite);
      }
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
        const runtime = this.#options.registry.get("runtime", intent.runtime);
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

  async close() {
    this.#closing = true;
    await Promise.allSettled([...this.#queues.values()]);
    // Shutdown attempts every owned generation even if one provider is stuck or fails.
    const results = await Promise.allSettled(
      [...this.#live.values()]
        .filter((row) => !row.runtime.needsLaunchToken)
        .map(async (row) => {
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
