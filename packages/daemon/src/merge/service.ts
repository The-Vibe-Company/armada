import { createHash } from "node:crypto";
import {
  type ForgeInspection,
  type ForgeProvider,
  forgeInspectionSchema,
  type Json,
  type TrackerProvider,
} from "@armada/plugin-api";
import type { JsonObject } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { CoordinatorStorage } from "../../coordinator/storage.ts";
import type { EventInput, FleetEvent } from "../events.ts";
import { fold, type ProjectTables, type Session } from "../fold.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { checkMerge, type MergeEvidence } from "./checklist.ts";
import { MergeFailure, type MergeFailureCode, refusalLine, refuse } from "./refusal.ts";

interface Options {
  registry: PluginRegistry;
  projects: readonly { id: string; checkout?: string; forge?: string; tracker?: string }[];
  now?: () => string;
  /** Same admitted worker.stop dispatch as the coordinator registry. Must pin the generation. */
  stop?: (scope: CoordinatorStorage, session: Session, key: string, signal: AbortSignal) => Promise<JsonObject>;
}
const progressSchema = z.object({
  format: z.literal("armada.merge"),
  version: z.literal(1),
  key: z.string(),
  pr: z.number().int().positive(),
  stage: z.enum(["intent", "confirmed", "tracker", "finished", "refused"]),
  ticket: z.string(),
  session: z.string(),
  generation: z.number().int(),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  baseRef: z.string(),
  mergeCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  result: z.record(z.string(), z.json()).optional(),
});
type Progress = z.infer<typeof progressSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const locks = new WeakMap<PluginRegistry, Set<string>>();

/** Bound reversible local work/cleanup even if a provider does not settle after cancellation.
 * Callers keep the exact-generation fence on every late native mutation.
 */
async function bounded<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Merge operation deadline elapsed"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}

/** V1 core/src/merge.ts pinned merge and queue-drain.ts lease/recovery, copied without imports.
 * The single daemon owns this lease; it never expires while an effect can still be running.
 */
export class Merges {
  readonly #options: Options;
  constructor(options: Options) {
    this.#options = options;
  }
  #now() {
    return this.#options.now?.() ?? new Date().toISOString();
  }
  #facts(scope: CoordinatorStorage) {
    return fold(scope.readEvents()).projects[scope.project];
  }
  #append(scope: CoordinatorStorage, kind: EventInput["kind"], payload: Json) {
    scope.appendEvent({ project: scope.project, actor: "coordinator", at: this.#now(), kind, payload } as EventInput);
  }
  #save(scope: CoordinatorStorage, progress: Progress) {
    this.#append(scope, "coordinator.checkpoint", { checkpoint: JSON.parse(JSON.stringify(progress)) });
  }
  #progress(events: FleetEvent[]): Progress[] {
    return events.flatMap((e) => {
      if (e.kind !== "coordinator.checkpoint") return [];
      const value = e.payload.checkpoint;
      if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== "armada.merge") return [];
      // Never turn an unknown journal version into permission to repeat an effect.
      return [progressSchema.parse(value)];
    });
  }
  #providers(project: string) {
    const settings = this.#options.projects.find((p) => p.id === project);
    const forge = this.#options.registry.get("forge", settings?.forge ?? "github", project);
    const tracker = this.#options.registry.get("tracker", settings?.tracker ?? "linear", project);
    if (!forge?.inspect)
      throw new MergeFailure(
        "forge_unreachable",
        "Forge inspection provider unavailable",
        "merge.check again after the forge provider is available",
      );
    if (!tracker)
      throw new MergeFailure(
        "tracker_write_failed",
        "Tracker provider unavailable",
        "merge.run again after the tracker provider is available",
      );
    return { forge, tracker };
  }
  async #inspect(scope: CoordinatorStorage, forge: ForgeProvider, pr: number): Promise<ForgeInspection> {
    scope.readEvents();
    const started = Date.parse(this.#now());
    const signal = AbortSignal.timeout(30_000);
    let result: ForgeInspection;
    try {
      result = forgeInspectionSchema.parse(await forge.inspect?.({ project: scope.project, number: pr, signal }));
    } catch (error) {
      throw new MergeFailure(
        "forge_unreachable",
        refusalLine(error, "Forge evidence unavailable"),
        "merge.check again after the forge reader recovers",
      );
    }
    signal.throwIfAborted();
    scope.readEvents();
    if (
      result.number !== pr ||
      Date.parse(result.observedAt) < started ||
      Date.parse(result.observedAt) > Date.parse(this.#now())
    )
      throw new MergeFailure(
        "forge_unreachable",
        "Stale or mismatched forge evidence",
        "merge.check again after fresh forge evidence is available",
      );
    return result;
  }
  #guard(
    scope: CoordinatorStorage,
    progress: Pick<Progress, "ticket" | "session" | "generation">,
    allowMerged = false,
  ) {
    const tables = this.#facts(scope);
    const current = tables?.sessions.find((s) => s.ticket === progress.ticket);
    if (
      !current ||
      current.session !== progress.session ||
      current.generation !== progress.generation ||
      (current.phase !== "ready-to-merge" &&
        !(allowMerged && (current.phase === "merged" || current.phase === "released")))
    )
      throw new MergeFailure(
        "worker_changed",
        "Worker generation changed",
        "fleet.status, then merge.check for the current worker hand-back",
      );
    return { tables: tables as ProjectTables, session: current };
  }
  #evidence(pull: ForgeInspection, tables: ProjectTables, passed: boolean): MergeEvidence {
    return {
      ...pull,
      requiredChecks: [...new Set([...pull.requiredChecks, ...(tables.rules?.value.gates?.requiredChecks ?? [])])],
      // V2 has no acceptance/merge-approval policy yet. Open owner validations are checked from the log.
      acceptance: { state: "not-required", head: pull.head },
      ownerApproval: { state: "not-required", head: pull.head },
      baseTest: { state: passed ? "passed" : "unknown", head: pull.head, base: pull.base },
    };
  }
  #assess(scope: CoordinatorStorage, pull: ForgeInspection, passed: boolean) {
    const tables = this.#facts(scope);
    if (!tables) return refuse("no_pr", `PR #${pull.number} is not open in ${scope.project}`);
    // Fresh forge facts override cached CI/state; the cached ticket/head still bind the hand-back.
    const tracked = tables.pullRequests.find((p) => p.number === pull.number);
    if (tracked && !tracked.ticket)
      return refuse(
        "no_ticket",
        `PR #${pull.number} has no ticket hand-back in ${scope.project}`,
        "hand back a ticket-owned pull request",
      );
    const claim = scope
      .readEvents()
      .findLast(
        (e) =>
          e.kind === "session.claimed" &&
          e.payload.session ===
            tables.sessions.find((s) => s.ticket === tables.pullRequests.find((p) => p.number === pull.number)?.ticket)
              ?.session,
      );
    const facts = {
      ...tables,
      inbox: tables.inbox.filter((i) => i.kind !== "hand-back" || !claim || i.seq > claim.seq),
      pullRequests: tables.pullRequests.map((p) =>
        p.number === pull.number
          ? {
              ...p,
              state: pull.state,
              conflicting: pull.mergeState === "DIRTY",
              ci:
                pull.checks.length && pull.checks.every((c) => c.state === "success")
                  ? ("success" as const)
                  : pull.checks.some((c) => c.state === "failure")
                    ? ("failure" as const)
                    : ("pending" as const),
            }
          : p,
      ),
    };
    return checkMerge(facts, pull.number, scope.project, this.#evidence(pull, tables, passed)).result;
  }
  async #check(scope: CoordinatorStorage, forge: ForgeProvider, number: number) {
    const pull = await this.#inspect(scope, forge, number);
    const tables = this.#facts(scope);
    const row = tables?.pullRequests.find((p) => p.number === number);
    const session = tables?.sessions.find((s) => s.ticket === row?.ticket);
    let result = this.#assess(scope, pull, true);
    if (!result.ok || !tables || !session) return { pull, result, session, rules: tables?.rules };
    const commands = tables.rules?.value.gates?.localCommands ?? [];
    if (pull.behindBy === null)
      result = refuse(
        "forge_unreachable",
        `GitHub could not compare the head of #${number} with ${pull.baseRef}`,
        "merge.check again after the forge comparison recovers",
      );
    else if (pull.behindBy > 0) {
      if (!commands.length)
        result = refuse(
          "merge_refused",
          `The head lacks ${pull.behindBy} commits of ${pull.baseRef}; configure local tests with rules.set gates localCommands`,
          `worker.message to bring ${pull.baseRef} in and hand back, or rules.set gates localCommands, then merge.check`,
        );
      else {
        const node = this.#options.registry.get("node", "local", scope.project);
        const checkout = this.#options.projects.find((p) => p.id === scope.project)?.checkout;
        if (!node?.testMerge || !checkout)
          result = refuse(
            "local_gate_failed",
            `The head lacks commits of ${pull.baseRef} and the local test provider or checkout is unavailable`,
            "merge.check again after the local test provider and project checkout are available",
          );
        else {
          const testMerge = node.testMerge.bind(node);
          const signal = AbortSignal.timeout(15 * 60_000);
          try {
            const test = await bounded(signal, () =>
              testMerge({
                signal,
                project: scope.project,
                repository: checkout,
                number,
                branch: pull.baseRef,
                base: pull.base,
                head: pull.head,
                commands,
              }),
            );
            scope.readEvents();
            if (!test.ok)
              result = refuse(
                test.step.startsWith("git merge ") ? "base_conflict" : "local_gate_failed",
                `Local step ${refusalLine(test.step)}: ${refusalLine(test.output, "Local test failed")}`,
                "worker.message to fix the failed local merge or gate and hand back, then merge.check",
              );
          } catch (error) {
            if (error instanceof MergeFailure) throw error;
            throw new MergeFailure(
              "local_gate_failed",
              refusalLine(error, "Local merge tests failed"),
              "worker.message to inspect the local gates, then merge.check",
            );
          }
        }
      }
    }
    if (result.ok) {
      // Tests and async reads may have yielded to a hold, changed policy or replacement claim.
      this.#guard(scope, { ...session, ticket: session.ticket });
      const fresh = this.#facts(scope);
      if (JSON.stringify(fresh?.rules) !== JSON.stringify(tables.rules))
        result = refuse("rules_changed", "the project's rules changed since they were read", "merge.check");
      else result = this.#assess(scope, pull, true);
    }
    return { pull, result, session, rules: tables?.rules };
  }

  async tool(
    scope: CoordinatorStorage,
    name: "merge.check" | "merge.run",
    pr: number,
    key: string,
  ): Promise<JsonObject> {
    const held = locks.get(this.#options.registry) ?? new Set<string>();
    locks.set(this.#options.registry, held);
    if (held.has(scope.project))
      return refuse(
        "lease_held",
        "another coordinator holds the merge lock",
        "retry merge.check after the active merge finishes",
      );
    held.add(scope.project);
    try {
      const journal = this.#progress(scope.readEvents());
      const sameCall = journal.filter((p) => p.key === key);
      if (sameCall.some((p) => p.pr !== pr))
        return refuse("call_conflict", "this call identity already committed different arguments");
      const receipt = sameCall.findLast((p) => p.stage === "finished" || p.stage === "refused");
      if (receipt && name === "merge.run") return receipt.result as JsonObject;
      // A new call may finish an interrupted merge, but cannot bypass another unresolved intent.
      const pending = journal.findLast(
        (p) => !journal.some((q) => q.key === p.key && (q.stage === "finished" || q.stage === "refused")),
      );
      if (pending && pending.pr !== pr)
        return refuse("merge_pending", `PR #${pending.pr} has an unfinished merge`, `merge.run for PR #${pending.pr}`);
      const { forge, tracker } = this.#providers(scope.project);
      if (name === "merge.run" && pending) {
        const result = await this.#recover(scope, forge, tracker, pending);
        if (result.ok && pending.key !== key) this.#save(scope, { ...pending, key, stage: "finished", result });
        return result;
      }
      const checked = await this.#check(scope, forge, pr);
      if (!checked.result.ok || name === "merge.check") return checked.result;
      if (!checked.session) return refuse("no_worker", "the runtime worker has ended");
      const { pull, session } = checked;
      const sameRules = () => JSON.stringify(this.#facts(scope)?.rules) === JSON.stringify(checked.rules);
      const progress: Progress = {
        format: "armada.merge",
        version: 1,
        key,
        pr,
        stage: "intent",
        ticket: session.ticket,
        session: session.session,
        generation: session.generation,
        head: pull.head,
        base: pull.base,
        baseRef: pull.baseRef,
        mergeCommit: null,
      };
      // Refresh after the local gates. A moved base requires another complete check/test.
      const final = await this.#inspect(scope, forge, pr);
      if (
        final.head !== pull.head ||
        final.base !== pull.base ||
        final.baseRef !== pull.baseRef ||
        final.behindBy === null ||
        final.behindBy !== pull.behindBy
      )
        return refuse("head_moved", "the head or base moved during the merge checklist", "merge.check");
      if (!sameRules())
        return refuse("rules_changed", "the project's rules changed since they were read", "merge.check");
      const finalResult = this.#assess(scope, final, true);
      if (!finalResult.ok) return finalResult;
      this.#guard(scope, progress);
      this.#save(scope, progress); // Durable intent precedes the external write.
      this.#guard(scope, progress);
      let writeStarted = false;
      const writeSignal = AbortSignal.timeout(30_000);
      try {
        const outcome = await forge.merge({
          signal: writeSignal,
          project: scope.project,
          number: pr,
          head: progress.head,
          beforeWrite: () => {
            this.#guard(scope, progress);
            writeSignal.throwIfAborted();
            if (!sameRules())
              throw new MergeFailure("rules_changed", "Local gates changed", "merge.check with the current rules");
            const current = this.#assess(scope, final, true);
            if (!current.ok)
              throw new MergeFailure(
                current.code as MergeFailureCode,
                current.reason as string,
                current.next as string,
              );
            writeStarted = true;
          },
        });
        if (!outcome.merged) {
          const result = refuse("merge_refused", `GitHub refused to merge #${pr}`, "merge.check");
          this.#save(scope, { ...progress, stage: "refused", result });
          return result;
        }
        progress.mergeCommit = outcome.mergeCommit ?? null;
      } catch (error) {
        if (!writeStarted) {
          const result =
            error instanceof MergeFailure
              ? error.result()
              : refuse(
                  "forge_unreachable",
                  refusalLine(error, "Forge write could not start"),
                  "merge.check again after the forge provider recovers, using a new call identity",
                );
          this.#save(scope, { ...progress, stage: "refused", result });
          return result;
        }
        // Never repeat an unknown write. A later call may confirm the exact GitHub fact.
        return refuse(
          "merge_unconfirmed",
          `GitHub merge outcome is unconfirmed: ${refusalLine(error)}; no second merge was attempted`,
          "merge.run again after the forge reader recovers to confirm the outcome and finish cleanup",
        );
      }
      return await this.#confirmed(scope, tracker, progress);
    } catch (error) {
      if (error instanceof MergeFailure) return error.result();
      return refuse(
        "merge_unavailable",
        refusalLine(error),
        "fleet.status, then merge.run for cleanup or merge.check for evidence",
      );
    } finally {
      held.delete(scope.project);
    }
  }

  async #recover(scope: CoordinatorStorage, forge: ForgeProvider, tracker: TrackerProvider, progress: Progress) {
    if (progress.stage === "intent") {
      const pull = await this.#inspect(scope, forge, progress.pr);
      if (pull.state !== "merged" || pull.head !== progress.head || pull.baseRef !== progress.baseRef)
        return refuse(
          "merge_unconfirmed",
          "GitHub merge outcome is unconfirmed; no second merge was attempted",
          "merge.run again after the forge confirms the pinned head was merged; never repeat an unconfirmed forge write",
        );
      progress = { ...progress, mergeCommit: pull.mergeCommit };
      return this.#confirmed(scope, tracker, progress);
    }
    return this.#cleanup(scope, tracker, progress);
  }
  async #confirmed(scope: CoordinatorStorage, tracker: TrackerProvider, progress: Progress) {
    scope.readEvents();
    const id = `merge:${hash(progress.key)}`;
    const recorded = scope.readEvents().some((e) => e.kind === "merge.confirmed" && e.payload.id === id);
    if (!recorded)
      this.#append(scope, "merge.confirmed", {
        id,
        ticket: progress.ticket,
        session: progress.session,
        pr: progress.pr,
        head: progress.head,
      });
    const confirmed: Progress = { ...progress, stage: "confirmed" };
    this.#save(scope, confirmed);
    return this.#cleanup(scope, tracker, confirmed);
  }
  async #cleanup(scope: CoordinatorStorage, tracker: TrackerProvider, progress: Progress): Promise<JsonObject> {
    // A replacement never authorizes cleanup of its predecessor's runtime or tracker state.
    const { session } = this.#guard(scope, progress, true);
    if (progress.stage !== "tracker") {
      // V1 core/src/merge.ts closeTicket wording; stable UUID prevents duplicate comments on retry.
      const hex = hash(`merged:${scope.project}:${progress.pr}:${progress.head}`).slice(0, 32);
      const commentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
      try {
        await tracker.write({
          project: scope.project,
          ticket: progress.ticket,
          state: "completed",
          signal: AbortSignal.timeout(30_000),
          commentId,
          beforeWrite: () => {
            this.#guard(scope, progress, true);
          },
          comment: `Agent status: merged — PR #${progress.pr} squash-merged into ${progress.baseRef} as ${progress.mergeCommit ?? "unknown"}, head ${progress.head}`,
        });
      } catch (error) {
        if (error instanceof MergeFailure) throw error;
        throw new MergeFailure(
          "tracker_write_failed",
          `Merged #${progress.pr}; ${refusalLine(error, "Tracker write failed")}`,
          "merge.run again after the tracker recovers to finish cleanup; the confirmed merge will not be repeated",
        );
      }
      this.#guard(scope, progress, true);
      progress = { ...progress, stage: "tracker" };
      this.#save(scope, progress);
    }
    if (!this.#options.stop)
      return refuse(
        "cleanup_pending",
        `Merged #${progress.pr}; worker stop and workspace disposal remain`,
        "install the worker.stop provider, then retry merge.run",
      );
    const stop = this.#options.stop;
    const signal = AbortSignal.timeout(30_000);
    const stopped = await bounded(signal, () => stop(scope, session, `merge-stop:${hash(progress.key)}`, signal));
    this.#guard(scope, progress, true);
    if (!stopped.ok)
      return refuse("cleanup_pending", `Merged #${progress.pr}; worker cleanup remains`, "retry merge.run");
    // Close only this worker generation's hand-back after confirmed merge/cleanup.
    const facts = this.#facts(scope);
    const claim = scope
      .readEvents()
      .findLast((e) => e.kind === "session.claimed" && e.payload.session === progress.session);
    for (const item of facts?.inbox ?? []) {
      if (item.ticket !== progress.ticket || item.kind !== "hand-back" || !claim || item.seq <= claim.seq) continue;
      const number = item.body.match(/\bPR #(\d+)/i)?.[1];
      const head = item.body.match(/\bhead ([0-9a-f]+)/i)?.[1]?.toLowerCase();
      if ((number === undefined || Number(number) === progress.pr) && head === progress.head)
        this.#append(scope, "inbox.answered", { id: item.id, answer: `Merged #${progress.pr}` });
    }
    const result: JsonObject = {
      ok: true,
      pr: progress.pr,
      head: progress.head,
      ticket: progress.ticket,
      merged: true,
      cleanup: stopped,
    };
    this.#save(scope, { ...progress, stage: "finished", result });
    return result;
  }
}
