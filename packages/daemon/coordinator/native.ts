import { createHash } from "node:crypto";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import type { EventInput, FleetEvent } from "../src/events.ts";
import { fold, type ProjectTables, type Session } from "../src/fold.ts";
import { emptyRules, type ProjectRules, type RulesState, rulesSchema } from "./rules.ts";
import { readV1RulesFile } from "./rules-file.ts";
import type { CoordinatorStorage } from "./storage.ts";
import { type CoordinatorToolName, TOOL_NAMES } from "./tools.ts";

export interface NativeToolOptions {
  now: () => string;
  /** Optional host restriction/adapter for explicitly requested, local V1 file imports. */
  readRulesImport?: (file: string) => Promise<ProjectRules>;
  mergeEvidence?: (pr: number) => Promise<MergeEvidence | null>;
  /** Must deduplicate by key across restarts, and call beforeWrite immediately before delivery.
   * Unknown outcomes must return false; never retry an unkeyed runtime write here. */
  deliverAnswerOnce?: (input: {
    key: string;
    session: Session;
    item: string;
    answer: string;
    beforeWrite: () => void;
  }) => Promise<boolean>;
}

const text = Type.String({ maxLength: 4000 });
const id = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const checkState = Type.Union([
  Type.Literal("none"),
  Type.Literal("pending"),
  Type.Literal("success"),
  Type.Literal("failure"),
]);
const mergeEvidenceSchema = object({
  head: sha,
  base: sha,
  observedAt: Type.String(),
  checksComplete: Type.Boolean(),
  title: Type.String(),
  draft: Type.Boolean(),
  mergeState: Type.String(),
  checks: Type.Array(object({ name: id, state: checkState })),
  requiredChecks: Type.Array(id),
  reviewThreads: object({
    complete: Type.Boolean(),
    total: Type.Integer({ minimum: 0 }),
    read: Type.Integer({ minimum: 0 }),
    unresolved: Type.Integer({ minimum: 0 }),
  }),
  acceptance: object({
    state: Type.Union([Type.Literal("passed"), Type.Literal("not-required"), Type.Literal("unknown")]),
    head: sha,
  }),
  ownerApproval: object({
    state: Type.Union([
      Type.Literal("approved"),
      Type.Literal("not-required"),
      Type.Literal("pending"),
      Type.Literal("unknown"),
    ]),
    head: sha,
  }),
  baseTest: object({ state: Type.Union([Type.Literal("passed"), Type.Literal("unknown")]), head: sha, base: sha }),
});
/** Adapter facts must explicitly prove complete enumeration and name the heads/base they concern. */
export type MergeEvidence = Static<typeof mergeEvidenceSchema>;

const schemas = {
  "fleet.status": object({}),
  "inbox.list": object({}),
  "inbox.answer": object({ id, answer: text }),
  "worker.launch": Type.Object({}, { additionalProperties: true }),
  "worker.relaunch": Type.Object({}, { additionalProperties: true }),
  "worker.message": Type.Object({}, { additionalProperties: true }),
  "worker.stop": Type.Object({}, { additionalProperties: true }),
  "merge.check": object({ pr: Type.Integer({ minimum: 1 }) }),
  "merge.run": Type.Object({}, { additionalProperties: true }),
  "hold.add": object({ reason: text }),
  "hold.clear": object({ id, reason: text }),
  "owner.ask": object({ ticket: id, question: text, choices: Type.Array(text, { maxItems: 6 }) }),
  "rules.set": object({
    expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
    reason: text,
    rules: Type.Optional(rulesSchema),
    importFile: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  }),
};
const descriptions: Record<CoordinatorToolName, string> = {
  "fleet.status": "Read the project's folded fleet and current rules. Missing evidence is listed explicitly.",
  "inbox.list": "Read open project inbox items in event order without resolving them.",
  "inbox.answer":
    "Deliver and record an answer to a question or plan once. Refuses without a keyed delivery adapter; the worker reports its resumed phase.",
  "worker.launch": "Launch a worker (not available yet; Spec 3).",
  "worker.relaunch": "Replace a worker (not available yet; Spec 3).",
  "worker.message": "Message a worker (not available yet; Spec 3).",
  "worker.stop": "Stop a worker (not available yet; Spec 3).",
  "merge.check":
    "Check a pinned hand-back against recorded fleet facts and adapter evidence. Missing evidence refuses the check.",
  "merge.run": "Merge a checked PR (not available yet; Spec 4).",
  "hold.add": "Pause project merges with a concrete reason.",
  "hold.clear": "Clear a known project pause with a recorded recovery reason.",
  "owner.ask": "Record a ticket's owner decision with numbered choices. Only the owner may decide it.",
  "rules.set":
    "Patch project routing (ordered labels or when descriptions), defaultRoute, placement and policy with the revision from fleet.status. Alternatively importFile (absolute local file path) imports V1 routing/profiles/policy once into an unconfigured project; never pass file contents in chat. Placement must be chosen explicitly. A reason is required.",
};
const refuse = (code: string, message: string, next: string, extra: JsonObject = {}): JsonObject => ({
  ok: false,
  code,
  message,
  next,
  ...extra,
});
const output = (details: JsonObject) => ({
  output: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
  isError: details.ok === false,
});

interface Receipt {
  format: "armada.tools";
  version: 1;
  key: string;
  input: string;
  result: JsonObject;
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyTables = (): ProjectTables => ({
  rules: emptyRules(),
  tickets: [],
  pullRequests: [],
  sessions: [],
  sessionsByState: {
    blocked: [],
    "waiting-for-owner": [],
    "in-progress": [],
    "ready-to-merge": [],
    merged: [],
    released: [],
  },
  inbox: [],
  queue: [],
  holds: [],
  validations: [],
});
/** Receipt metadata stays in the raw log, never in native fleet/inbox facts. */
function projectFacts(events: FleetEvent[], project: string): ProjectTables {
  const tables = fold(events).projects[project] ?? emptyTables();
  for (const row of [...tables.holds, ...tables.inbox]) Reflect.deleteProperty(row, "receipt");
  return tables;
}

type Decision = { result: JsonObject; event?: EventInput };

function rulesProblem(args: JsonObject, rules: RulesState): JsonObject | null {
  if ((args.rules === undefined) === (args.importFile === undefined))
    return refuse(
      "invalid_arguments",
      "supply exactly one of rules or importFile",
      "rules.set with either a patch or a one-time import",
    );
  const reason = (args.reason as string).trim();
  if (!reason) return refuse("empty_reason", "a rules change needs a reason", "rules.set with the owner's intent");
  if (args.importFile !== undefined && rules.revision !== 0)
    return refuse(
      "rules_already_set",
      "the project's rules have already been configured",
      "use a rules patch with the current revision",
    );
  if (args.expectedRevision !== rules.revision)
    return refuse(
      "rules_changed",
      "the project's rules changed since they were read",
      "fleet.status, then rules.set with its rules revision",
    );
  return null;
}

/** Pure decisions over a fresh, project-scoped reading. Writes are published by the admitted owner below. */
function decide(
  name: CoordinatorToolName,
  args: JsonObject,
  project: string,
  events: FleetEvent[],
  at: string,
  operation: string,
  evidence: MergeEvidence | null,
  importedRules?: ProjectRules,
): Decision {
  const tables = projectFacts(events, project);
  const rules = tables.rules;
  const no = (code: string, message: string, next: string): Decision => ({ result: refuse(code, message, next) });
  const changed = (event: EventInput, result: JsonObject): Decision => ({ event, result: { ok: true, ...result } });
  const base = { project, at, actor: "coordinator" };
  switch (name) {
    case "fleet.status":
      return {
        result: {
          ok: true,
          project,
          seq: events.at(-1)?.seq ?? 0,
          tables: JSON.parse(JSON.stringify(tables)),
          rules: JSON.parse(JSON.stringify(rules)),
          unavailable: [
            "frontier-blockers",
            "runtime-observations",
            "jobs",
            "default-branch-health",
            "launch-capacity",
          ],
        },
      };
    case "inbox.list":
      return { result: { ok: true, project, items: JSON.parse(JSON.stringify(tables.inbox)) } };
    case "inbox.answer": {
      const answer = (args.answer as string).trim();
      // Copied from core/src/inbox.ts answerItem; limits from core/src/requests.ts requestAnswer.
      if (!answer) return no("empty_answer", "the answer is empty", "inbox.answer with an answer");
      const item = tables.inbox.find((i) => i.id === args.id);
      if (!item) {
        const closed = events.some((e) => e.kind === "inbox.answered" && e.payload.id === args.id);
        return no(
          closed ? "item_closed" : "no_item",
          closed
            ? `inbox item #${args.id} was already resolved`
            : `inbox item #${args.id} does not exist in project ${project}`,
          "inbox.list",
        );
      }
      // Hand-backs require merge.run, launches worker.launch, and owner requests an owner's decision.
      if (item.kind !== "question" && item.kind !== "plan")
        return no(
          "not_answerable",
          `inbox item #${item.id} is a ${item.kind}, not something to answer`,
          item.kind === "hand-back"
            ? "merge.check"
            : item.kind === "launch"
              ? "worker.launch"
              : "wait for the owner's decision",
        );
      return changed(
        { ...base, kind: "inbox.answered", payload: { id: item.id, answer } },
        { id: item.id, answer, delivery: "confirmed" },
      );
    }
    case "hold.add": {
      const reason = (args.reason as string).trim();
      if (!reason) return no("empty_reason", "a merge hold needs a reason", "hold.add with a reason and recovery work");
      return changed({ ...base, kind: "hold.opened", payload: { id: operation, reason } }, { id: operation, reason });
    }
    case "hold.clear": {
      const reason = (args.reason as string).trim();
      if (!reason) return no("empty_reason", "clearing a hold needs a reason", "hold.clear with the recovery evidence");
      const hold = tables.holds.find((h) => h.id === args.id);
      if (!hold) {
        const closed = events.some((e) => e.kind === "hold.cleared" && e.payload.id === args.id);
        return no(
          closed ? "hold_closed" : "no_hold",
          closed ? `hold ${args.id} was already cleared` : `hold ${args.id} does not exist in project ${project}`,
          "fleet.status",
        );
      }
      return changed({ ...base, kind: "hold.cleared", payload: { id: hold.id, reason } }, { id: hold.id, reason });
    }
    case "owner.ask": {
      const question = (args.question as string).trim();
      const choices = (args.choices as string[]).map((s) => s.trim());
      // Copied from core/src/validate.ts submitValidation and core/src/inbox.ts questionBody.
      if (!question) return no("empty_question", "say what the owner checks", "owner.ask with a question");
      if (!choices.length || choices.some((s) => !s))
        return no("no_choices", "a question for the owner needs its choices", "owner.ask with nonempty choices");
      const ticket = tables.tickets.find((t) => t.id === args.ticket);
      if (!ticket) return no("no_ticket", `ticket ${args.ticket} not found`, "fleet.status");
      if (ticket.status === "completed" || ticket.status === "canceled")
        return no("ticket_closed", `${ticket.id} is ${ticket.status}`, "fleet.status");
      const body = `${question}\n\nOptions:\n${choices.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
      return changed(
        { ...base, kind: "inbox.opened", payload: { id: operation, ticket: ticket.id, kind: "owner-request", body } },
        { id: operation, ticket: ticket.id, question, choices },
      );
    }
    case "rules.set": {
      const problem = rulesProblem(args, rules);
      if (problem) return { result: problem };
      const reason = (args.reason as string).trim();
      const patch = args.importFile === undefined ? (args.rules as JsonObject) : importedRules;
      if (!patch) throw new Error("Missing normalized import");
      if (!Object.keys(patch).length)
        return no("empty_rules", "say which rules change", "rules.set with routing, placement or policy");
      const value = {
        ...rules.value,
        ...patch,
        ...(patch.policy
          ? { policy: { ...((rules.value.policy as JsonObject) ?? {}), ...(patch.policy as JsonObject) } }
          : {}),
      };
      const next = { revision: rules.revision + 1, value };
      return changed(
        {
          ...base,
          kind: "coordinator.checkpoint",
          payload: { checkpoint: { format: "armada.tools", version: 1, type: "rules", rules: next, reason } },
        },
        { rules: next },
      );
    }
    case "merge.check": {
      const pr = tables.pullRequests.find((p) => p.number === args.pr);
      if (!pr) return no("no_pr", `PR #${args.pr} is not open in ${project}`, "fleet.status");
      const session = tables.sessions.find((s) => s.ticket === pr.ticket);
      const handBack = [...tables.inbox]
        .reverse()
        .find(
          (i) =>
            i.ticket === pr.ticket &&
            i.kind === "hand-back" &&
            /^Agent status: ready-to-merge — (?!note:|answer:|acceptance:)/m.test(i.body) &&
            i.actor !== "coordinator",
        );
      const problems: string[] = [];
      // Copied from core/src/merge.ts assess / mergeProblems. Unknown evidence always refuses.
      if (session?.phase !== "ready-to-merge")
        problems.push(
          `${pr.ticket} has not been handed back: its agent phase is ${session?.phase ?? "not set"}, not ready-to-merge`,
        );
      if (!handBack) problems.push(`${pr.ticket} has no "Agent status: ready-to-merge" comment carrying the head SHA`);
      else {
        const sha = handBack.body.match(/\bhead ([0-9a-f]+)\b/i)?.[1]?.toLowerCase();
        const number = handBack.body.match(/\bPR #(\d+)/i)?.[1];
        if (number && Number(number) !== pr.number)
          problems.push(`the hand-back on ${pr.ticket} names PR #${number}, not #${pr.number}`);
        if (!sha || !/^[0-9a-f]{40}$/.test(sha))
          problems.push(
            `the handed-back SHA ${sha ?? "missing"} is not a full 40-character SHA; ask the worker to report ready-to-merge again`,
          );
        else if (sha !== pr.head)
          problems.push(
            `the head of #${pr.number} is ${pr.head}, not the handed-back ${sha}: it moved after the hand-back; ask the worker to report again`,
          );
      }
      if (pr.state !== "open") problems.push(`#${pr.number} is ${pr.state}, not open`);
      if (pr.conflicting)
        problems.push(`#${pr.number} conflicts with its base; ask the worker to merge it in or rebase`);
      if (pr.ci !== "success") problems.push(`#${pr.number} checks are ${pr.ci}`);
      for (const hold of tables.holds) problems.push(`merge hold ${hold.id}: ${hold.reason}`);
      // Copied from core/src/validations.ts lastValidation: a newer submission replaces the earlier decision.
      const validation = tables.validations
        .filter((v) => v.ticket === pr.ticket && v.session === session?.session)
        .at(-1);
      if (validation && validation.decision?.decision !== "approved")
        problems.push("owner validation is pending or changes were requested");
      if (!evidence) problems.push("merge review, acceptance, approval and base-test evidence is unavailable");
      else {
        if (evidence.head !== pr.head) problems.push("merge evidence is for a different head");
        if (evidence.draft) problems.push(`#${pr.number} is a draft`);
        if (
          !/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./,-]+\))?!?: \S/.test(evidence.title)
        )
          problems.push(`the title "${evidence.title}" is not in Commitizen format, e.g. "feat(cli): add a command"`);
        if (!["CLEAN", "HAS_HOOKS"].includes(evidence.mergeState))
          problems.push(`GitHub reports #${pr.number} as ${evidence.mergeState}, not CLEAN`);
        for (const name of evidence.requiredChecks)
          if (!evidence.checks.some((c) => c.name === name && c.state === "success"))
            problems.push(`required check ${name} has not passed`);
        if (!evidence.checks.length || evidence.checks.some((c) => c.state !== "success"))
          problems.push("not every visible check is green");
        if (!evidence.checksComplete) problems.push("check enumeration is incomplete");
        const { total, read, unresolved, complete } = evidence.reviewThreads;
        if (!complete || total !== read || unresolved > read)
          problems.push("review-thread evidence is incomplete or inconsistent");
        if (unresolved)
          problems.push(`#${pr.number} has ${unresolved} unresolved review thread${unresolved > 1 ? "s" : ""}`);
        else if (total > read)
          problems.push(`#${pr.number} has more than ${read} review threads; check they are resolved by hand`);
        if (!["passed", "not-required"].includes(evidence.acceptance.state))
          problems.push("acceptance evidence is unavailable");
        if (!["approved", "not-required"].includes(evidence.ownerApproval.state))
          problems.push("owner merge approval is pending or unavailable");
        if (evidence.baseTest.state !== "passed") problems.push("fresh-main test evidence is unavailable");
        if (
          evidence.acceptance.head !== pr.head ||
          evidence.ownerApproval.head !== pr.head ||
          evidence.baseTest.head !== pr.head ||
          evidence.baseTest.base !== evidence.base
        )
          problems.push("acceptance, approval or base-test evidence is for an earlier head/base");
      }
      return {
        result: problems.length
          ? refuse(
              "merge_refused",
              `#${pr.number} cannot be merged`,
              "fix the listed prerequisites, then merge.check",
              { problems },
            )
          : { ok: true, pr: pr.number, head: pr.head, ticket: pr.ticket },
      };
    }
    default:
      return no(
        "not_available_yet",
        "not available yet",
        name.startsWith("worker.") ? "wait for Spec 3 worker runtime tools" : "wait for Spec 4 merge execution",
      );
  }
}

/** Defaults for the real pi registry. Each successful write + receipt is ONE SQLite append. */
export function nativeTools(
  scope: CoordinatorStorage,
  options: NativeToolOptions,
): Record<CoordinatorToolName, ToolRegistration> {
  return Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      defineTool({
        name,
        description: descriptions[name],
        parameters: schemas[name],
        replay: "safe",
        executionMode: "sequential",
        async execute(args, api) {
          let events: FleetEvent[];
          try {
            events = scope.readEvents();
          } catch {
            return output(
              refuse(
                "coordinator_inactive",
                "the project's coordinator no longer owns its writer scope",
                "open the project's coordinator before calling tools",
              ),
            );
          }
          if (!Value.Check(schemas[name], args))
            return output(
              refuse(
                "invalid_arguments",
                "tool arguments do not match its schema",
                `call ${name} with its declared parameters`,
              ),
            );
          const mutation = ["inbox.answer", "hold.add", "hold.clear", "owner.ask", "rules.set"].includes(name);
          if (mutation && (!api.callId || !Number.isSafeInteger(api.taskId)))
            return output(
              refuse(
                "missing_call_id",
                "a write needs its durable tool call identity",
                "invoke through the coordinator harness",
              ),
            );
          const key = JSON.stringify([scope.project, api.taskId, api.callId]);
          const input = canonical({ name, args });
          for (const event of events) {
            const receipt = (event.payload as typeof event.payload & { receipt?: Receipt }).receipt;
            if (receipt?.format !== "armada.tools" || receipt.key !== key) continue;
            if (receipt.version !== 1)
              return output(
                refuse(
                  "unsupported_receipt",
                  "unsupported tool receipt version",
                  "upgrade the daemon before replaying this call",
                ),
              );
            return output(
              receipt.input === input
                ? receipt.result
                : refuse(
                    "call_conflict",
                    "this call identity already committed different arguments",
                    "inspect the original call; use a new call for a new decision",
                  ),
            );
          }
          let importedRules: ProjectRules | undefined;
          if (name === "rules.set" && typeof (args as JsonObject).importFile === "string") {
            let problem: JsonObject | null;
            try {
              problem = rulesProblem(args as JsonObject, projectFacts(events, scope.project).rules);
            } catch {
              return output(
                refuse(
                  "state_unavailable",
                  "the project's durable rules state is unsupported or invalid",
                  "upgrade or repair the project log",
                ),
              );
            }
            if (problem) return output(problem);
            try {
              importedRules = await (options.readRulesImport ?? readV1RulesFile)(
                (args as JsonObject).importFile as string,
              );
              if (!Value.Check(rulesSchema, importedRules)) throw new Error("Invalid imported rules");
            } catch {
              return output(
                refuse(
                  "invalid_import",
                  "V1 routing, profiles or policy cannot be imported from that local file",
                  "check the absolute file path, TOML syntax, profile references, supported CLIs and policy numbers",
                ),
              );
            }
            // A file read can yield: re-read revisions and fence a closed writer before deciding.
            try {
              events = scope.readEvents();
            } catch {
              return output(
                refuse(
                  "coordinator_inactive",
                  "the project's coordinator no longer owns its writer scope",
                  "open the project's coordinator",
                ),
              );
            }
          }
          let evidence: MergeEvidence | null = null;
          const readStarted = Date.parse(options.now());
          if (name === "merge.check" && options.mergeEvidence) {
            try {
              evidence = await options.mergeEvidence((args as JsonObject).pr as number);
            } catch {
              return output(
                refuse(
                  "evidence_unavailable",
                  "merge evidence could not be read",
                  "retry merge.check after the reader recovers",
                ),
              );
            }
            if (
              evidence &&
              (!Value.Check(mergeEvidenceSchema, evidence) ||
                !Number.isFinite(Date.parse(evidence.observedAt)) ||
                Date.parse(evidence.observedAt) < readStarted ||
                Date.parse(evidence.observedAt) > Date.parse(options.now()))
            )
              return output(
                refuse(
                  "evidence_unavailable",
                  "merge evidence is malformed, stale or incomplete",
                  "refresh all merge evidence, then merge.check",
                ),
              );
            // An asynchronous reader must not authorize a decision from an old snapshot or a closed owner.
            try {
              events = scope.readEvents();
            } catch {
              return output(
                refuse(
                  "coordinator_inactive",
                  "the project's coordinator no longer owns its writer scope",
                  "open the project's coordinator",
                ),
              );
            }
          }
          let decision: Decision;
          try {
            decision = decide(
              name,
              args as JsonObject,
              scope.project,
              events,
              options.now(),
              `tool:${digest(key)}`,
              evidence,
              importedRules,
            );
          } catch {
            return output(
              refuse(
                "state_unavailable",
                "the project's durable fleet or rules state is unsupported or invalid",
                "upgrade or repair the project log before deciding",
              ),
            );
          }
          if (decision.event?.kind === "inbox.answered") {
            const deliver = options.deliverAnswerOnce;
            if (!deliver)
              return output(
                refuse(
                  "delivery_unavailable",
                  "no keyed answer delivery adapter is available",
                  "install the worker runtime adapter; keep the inbox item open",
                ),
              );
            const answeredId = decision.event.payload.id;
            const item = projectFacts(events, scope.project).inbox.find((i) => i.id === answeredId);
            const session = projectFacts(events, scope.project).sessions.find((s) => s.ticket === item?.ticket);
            const claim = events.find((e) => e.kind === "session.claimed" && e.payload.session === session?.session);
            // Copied from core/src/inbox.ts answerItem's generation and ended-worker guards.
            if (!session || !claim || session.phase === "merged" || session.phase === "released")
              return output(refuse("no_worker", "the runtime worker has ended; no answer was delivered", "inbox.list"));
            if (!item || item.seq < claim.seq)
              return output(
                refuse(
                  "stale_question",
                  "the question belongs to an earlier worker claim; no answer was delivered",
                  "inbox.list",
                ),
              );
            const beforeWrite = () => {
              const fresh = projectFacts(scope.readEvents(), scope.project);
              const current = fresh?.sessions.find((s) => s.ticket === session.ticket);
              if (
                current?.session !== session.session ||
                current.phase === "merged" ||
                current.phase === "released" ||
                !fresh?.inbox.some((i) => i.id === item.id)
              )
                throw new Error("Answer target changed");
            };
            try {
              beforeWrite();
              const confirmed = await deliver({
                key,
                session,
                item: item.id,
                answer: decision.event.payload.answer,
                beforeWrite,
              });
              if (!confirmed)
                return output(
                  refuse(
                    "delivery_unconfirmed",
                    "answer delivery is unconfirmed; the inbox item stays open",
                    "inspect delivery, then retry the same call identity",
                  ),
                );
              beforeWrite();
            } catch {
              return output(
                refuse(
                  "delivery_unconfirmed",
                  "answer delivery or its target could not be confirmed; the inbox item stays open",
                  "inspect delivery, then retry the same call identity",
                ),
              );
            }
          }
          if (decision.event) {
            const receipt: Receipt = { format: "armada.tools", version: 1, key, input, result: decision.result };
            // The native projection strips receipt metadata; effect and receipt commit atomically.
            const event = decision.event;
            Object.assign(event.payload, { receipt });
            try {
              scope.appendEvent(event);
            } catch {
              return output(
                refuse("write_failed", "the decision was not recorded", `retry ${name} with the same call identity`),
              );
            }
          }
          return output(decision.result);
        },
      }) as ToolRegistration,
    ]),
  ) as Record<CoordinatorToolName, ToolRegistration>;
}
