import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { TrackerProvider } from "@armada/plugin-api";
import type { FleetEvent, ProjectTables, Session, Ticket } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import pkg from "../../plugins/internal-tracker/package.json" with { type: "json" };
import { activate } from "../../plugins/internal-tracker/src/index.ts";
import { activate as activateLinear } from "../../plugins/linear/src/index.ts";
import {
  issue as linearIssue,
  page as linearPage,
  recorded as linearRecorded,
} from "../../plugins/linear/test/support/program.ts";
import { type MergeEvidence, nativeTools } from "../coordinator/native.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import type { CoordinatorToolName } from "../coordinator/tools.ts";
import { bootDaemon } from "../src/boot.ts";
import { fold, type InboxItem } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";
import { fakeWorkers } from "./support/fake-worker.ts";

interface TestFacts {
  ok: boolean;
  code: string;
  message: string;
  project: string;
  id: string;
  next: string;
  queued: string;
  sessions: {
    ticket: string;
    title: string;
    phase: string;
    step: number;
    runtime: string;
    drive: "daemon" | "tracker";
    head: string | null;
    checks: string | null;
    lastReport: string | null;
    ageSeconds: number | null;
  }[];
  inbox: { total: number; byKind: Record<string, number> };
  frontier: { id: string; title: string; blockers: { id: string; status: string }[] }[];
  pullRequests: { number: number; ticket: string; head: string; checks: string; mergeable: boolean }[];
  holds: { id: string; reason: string }[];
  ticket: Omit<Ticket, "parent"> & { parent: { id: string; title: string | null } | null };
  session: Session | null;
  reports: { at: string; phase: string; body: string }[];
  events: FleetEvent[];
  more: boolean;
  defaultBranch?: ProjectTables["defaultBranch"];
  unavailable: { capability: string; reason: string; fix: string }[];
  items: InboxItem[];
  problems: string[];
  rules: { value: { policy: { maxWorkers: number }; coordinatorModel?: { kind: string } } };
}

const at = "2030-01-01T00:00:00.000Z";
const head = "a".repeat(40);
const seed = (store: EventStore, project = "orchard") => {
  const append = (event: Parameters<EventStore["append"]>[0]) => store.append(event);
  append({
    project,
    at,
    actor: "reader",
    kind: "ticket.seen",
    payload: { id: "SEED-1", title: "Plant", status: "started" },
  });
  append({
    project,
    at,
    actor: "worker",
    kind: "session.claimed",
    payload: { ticket: "SEED-1", session: "one", generation: 1, owner: "Mira", runtime: "codex", handle: "local/one" },
  });
  append({
    project,
    at,
    actor: "worker",
    kind: "session.reported",
    payload: { ticket: "SEED-1", session: "one", phase: "ready-to-merge", reason: "Green" },
  });
  append({
    project,
    at,
    actor: "reader",
    kind: "pull-request.seen",
    payload: { number: 7, ticket: "SEED-1", head, state: "open", ci: "success", conflicting: false },
  });
  append({
    project,
    at,
    actor: "worker",
    kind: "inbox.opened",
    payload: { id: "q", ticket: "SEED-1", kind: "question", body: "Which seed?" },
  });
  append({
    project,
    at,
    actor: "worker",
    kind: "inbox.opened",
    payload: {
      id: "back",
      ticket: "SEED-1",
      kind: "hand-back",
      body: `Agent status: ready-to-merge — PR #7, head ${head}`,
    },
  });
};
const evidence: MergeEvidence = {
  head,
  base: "c".repeat(40),
  observedAt: at,
  checksComplete: true,
  title: "feat(garden): plant seeds",
  draft: false,
  mergeState: "CLEAN",
  checks: [{ name: "verify", state: "success" }],
  requiredChecks: ["verify"],
  reviewThreads: { complete: true, total: 1, read: 1, unresolved: 0 },
  acceptance: { state: "passed", head },
  ownerApproval: { state: "not-required", head },
  baseTest: { state: "passed", head, base: "c".repeat(40) },
};

async function fixture(t: TestContext) {
  const store = new EventStore(":memory:");
  seed(store);
  seed(store, "other");
  const scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  const tools = nativeTools(scope, {
    now: () => at,
    mergeEvidence: async () => evidence,
  });
  t.after(async () => {
    await scope.close(context);
    store.close();
  });
  let call = 0;
  const run = async (name: CoordinatorToolName, args: object = {}, id = String(++call)) => {
    const result = await tools[name].execute(args, { taskId: 1, callId: id } as ToolExecutionApi, context);
    const first = result.output?.[0];
    assert.ok(first?.type === "text");
    assert.deepEqual(JSON.parse(first.text), result.details);
    return result.details as unknown as TestFacts;
  };
  return { store, scope, run };
}

test("fleet.status returns detached project facts and refuses an inactive coordinator", async (t) => {
  const { store, scope, run } = await fixture(t);
  const facts = await run("fleet.status");
  assert.equal(facts.ok, true);
  assert.equal(facts.project, "orchard");
  assert.equal(facts.sessions.length, 1);
  assert.equal(facts.sessions[0]?.drive, "daemon");
  facts.sessions.length = 0;
  assert.equal((await run("fleet.status")).sessions.length, 1);
  assert.equal(store.readSince(0, "other").length, 6);
  assert.ok(facts.unavailable.some((gap) => gap.capability === "default-branch-health"));
  const health = { branch: "trunk", head: "e".repeat(40), ci: "failure" as const };
  store.append({ project: "orchard", at, actor: "github", kind: "default-branch.seen", payload: health });
  store.append({
    project: "other",
    at,
    actor: "github",
    kind: "default-branch.seen",
    payload: { branch: "other-main", head: "f".repeat(40), ci: "success" },
  });
  const current = await run("fleet.status");
  assert.deepEqual(current.defaultBranch, health);
  assert.equal(
    current.unavailable.some((gap) => gap.capability === "default-branch-health"),
    false,
  );

  await scope.close(context);
  assert.equal((await run("fleet.status")).code, "coordinator_inactive");
});

test("fleet.status keeps ten active sessions before compact fleet facts and below both tool byte limits", async (t) => {
  const { store, run } = await fixture(t);
  for (let i = 2; i <= 40; i++) {
    store.append({
      project: "orchard",
      at,
      actor: "reader",
      kind: "ticket.seen",
      payload: {
        id: `SEED-${i}`,
        title: `Plant orchard row ${i}`,
        status: i <= 10 ? "started" : "unstarted",
        labels: i === 14 ? [] : i === 15 ? ["ready-for-agent", "parked"] : ["ready-for-agent"],
        ...(i === 13 ? {} : { blockers: i === 12 ? [{ id: "SEED-1", status: "started" as const }] : [] }),
        ...(i === 18 ? { parent: "SEED-17" } : {}),
        description: "Full spec and details. ".repeat(1000),
        comments: [{ author: "Mira", at, body: "Long discussion. ".repeat(1000) }],
        ...(i <= 10
          ? { phase: "implementing" as const, reason: `Working on row ${i}\n${"details".repeat(1000)}` }
          : {}),
      },
    });
  }
  for (let i = 2; i <= 10; i++)
    store.append({
      project: "orchard",
      at,
      actor: "reader",
      kind: "pull-request.seen",
      payload: {
        number: i + 6,
        ticket: `SEED-${i}`,
        head,
        state: "open",
        ci: "pending",
        conflicting: false,
      },
    });
  await run("rules.set", {
    expectedRevision: 0,
    reason: "Owner routing",
    rules: {
      routing: [
        { labels: ["api"], cli: "codex", model: "gpt-6.1-sol", effort: "high" },
        { when: "Frontend work", cli: "claude", model: "sonnet" },
      ],
      defaultRoute: { cli: "codex", model: "gpt-6.1-sol" },
      policy: { plans: "approve", maxWorkers: 10 },
      gates: { requiredChecks: ["verify"], localCommands: ["bun run verify"] },
      coordinatorModel: { provider: "openai", model: "gpt-6.1-sol" },
    },
  });
  for (const [id, phase] of [
    ["OLD-1", "merged"],
    ["OLD-2", "released"],
  ] as const) {
    store.append({
      project: "orchard",
      at: "2029-12-31T00:00:00.000Z",
      actor: "reader",
      kind: "ticket.seen",
      payload: { id, title: "Old work", status: "completed", phase },
    });
  }
  await run("hold.add", { reason: "Main is red" });
  const facts = await run("fleet.status");
  const serialized = JSON.stringify(facts);
  const bytes = Buffer.byteLength(serialized);
  t.diagnostic(`forty tickets, ten sessions/open PRs: status ${bytes} bytes`);
  assert.ok(bytes < 8 * 1024, `status is ${bytes} bytes`);
  assert.ok(bytes < 50 * 1024, "pi-durable must receive the entire JSON text block");
  assert.deepEqual(Object.keys(facts).slice(0, 5), ["followUps", "at", "readAt", "sessions", "inbox"]);
  assert.deepEqual(
    facts.sessions.map((s) => s.ticket),
    Array.from({ length: 10 }, (_, i) => `SEED-${i + 1}`),
  );
  assert.deepEqual(facts.inbox, { total: 2, byKind: { question: 1, "hand-back": 1 } });
  assert.deepEqual(
    facts.frontier.find((row) => row.id === "SEED-11"),
    { id: "SEED-11", title: "Plant orchard row 11", blockers: [] },
  );
  for (const id of ["SEED-12", "SEED-13", "SEED-14", "SEED-15", "SEED-17"])
    assert.equal(
      facts.frontier.some((row) => row.id === id),
      false,
      id,
    );
  assert.ok(facts.unavailable.some((gap) => gap.capability === "frontier-blockers"));
  assert.equal(facts.pullRequests.length, 10);
  assert.deepEqual(facts.pullRequests[0], {
    number: 7,
    ticket: "SEED-1",
    head,
    checks: "success",
    mergeable: true,
    behind: false,
    unresolvedThreads: 0,
  });
  assert.equal(facts.holds[0]?.reason, "Main is red");
  assert.equal(facts.sessions[0]?.lastReport, "Green");
  assert.equal(facts.sessions[0]?.head, head);
  assert.equal(facts.sessions[0]?.checks, "success");
  assert.equal(facts.sessions[0]?.ageSeconds, 0);
  assert.equal(facts.sessions[1]?.lastReport, "Working on row 2");
  assert.equal(Object.hasOwn(facts, "tables"), false);
  assert.doesNotMatch(serialized, /Full spec|Long discussion|OLD-1|OLD-2|sessionsByState/);
  store.append({
    project: "orchard",
    at,
    actor: "reader",
    kind: "pull-request.seen",
    payload: {
      number: 41,
      ticket: "SEED-1",
      head: "b".repeat(40),
      state: "open",
      ci: "failure",
      conflicting: false,
    },
  });
  const refreshed = await run("fleet.status");
  assert.equal(refreshed.sessions[0]?.head, "b".repeat(40), "the latest PR supplies the session evidence");
  assert.equal(refreshed.sessions[0]?.checks, "failure");
});

test("ticket.read returns full ticket, parent, latest twelve comments and reports within its project", async (t) => {
  const { store, run, scope } = await fixture(t);
  const description = "A complete ticket description. ".repeat(1000);
  store.append({
    project: "orchard",
    at,
    actor: "reader",
    kind: "ticket.seen",
    payload: {
      id: "SPEC-1",
      title: "The orchard spec",
      status: "started",
      description: "Parent specification",
    },
  });
  store.append({
    project: "orchard",
    at,
    actor: "reader",
    kind: "ticket.seen",
    payload: {
      id: "SEED-1",
      title: "Plant",
      status: "started",
      parent: "SPEC-1",
      description,
      labels: ["api"],
      blockers: [{ id: "SEED-9", status: "completed" }],
      comments: Array.from({ length: 15 }, (_, i) => ({
        author: "Mira",
        at: `2029-12-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        body: `Comment ${i}`,
      })).reverse(),
    },
  });
  const facts = await run("ticket.read", { id: "SEED-1" });
  assert.equal(facts.ticket.description, description);
  assert.deepEqual(facts.ticket.parent, { id: "SPEC-1", title: "The orchard spec" });
  assert.deepEqual(facts.ticket.labels, ["api"]);
  assert.deepEqual(facts.ticket.blockers, [{ id: "SEED-9", status: "completed" }]);
  assert.deepEqual(
    facts.ticket.comments?.map((c) => c.body),
    Array.from({ length: 12 }, (_, i) => `Comment ${14 - i}`),
  );
  assert.equal(facts.session?.session, "one");
  assert.deepEqual(
    facts.reports.map((r) => [r.phase, r.body]),
    [["ready-to-merge", "Green"]],
  );
  assert.equal((await run("ticket.read", { id: "SPEC-1" })).ticket.description, "Parent specification");
  assert.equal((await run("ticket.read", { id: "missing" })).code, "no_ticket");
  assert.equal((await run("ticket.read", { id: "SEED-1", extra: true })).code, "invalid_arguments");
  store.append({
    project: "other",
    at,
    actor: "reader",
    kind: "ticket.seen",
    payload: { id: "PRIVATE-1", title: "Private", status: "started" },
  });
  assert.equal((await run("ticket.read", { id: "PRIVATE-1" })).code, "no_ticket");
  store.append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "session.claimed",
    payload: {
      ticket: "SEED-1",
      session: "two",
      generation: 2,
      owner: "Mira",
      runtime: "codex",
      handle: "local/two",
    },
  });
  store.append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "session.reported",
    payload: {
      ticket: "SEED-1",
      session: "two",
      phase: "implementing",
      reason: "New roots",
    },
  });
  const replacement = await run("ticket.read", { id: "SEED-1" });
  assert.equal(replacement.session?.session, "two");
  assert.deepEqual(
    replacement.reports.map((r) => r.body),
    ["New roots"],
    "superseded generation reports belong in history",
  );
  await scope.close(context);
  assert.equal((await run("ticket.read", { id: "SEED-1" })).code, "coordinator_inactive");
});

test("fleet.history filters ticket and time, limits the newest events and omits durable internals", async (t) => {
  const { run, store } = await fixture(t);
  await run("inbox.answer", { id: "q", answer: "Oak" });
  await run("hold.add", { reason: "Pause" });
  store.append({
    project: "orchard",
    at,
    actor: "reader",
    kind: "coordinator.checkpoint",
    payload: { checkpoint: { format: "internal", data: "PRIVATE CHECKPOINT" } },
  });
  const result = await run("fleet.history", { ticket: "SEED-1", limit: 2 });
  assert.deepEqual(
    result.events.map((e) => e.kind),
    ["inbox.answered", "delivery.queued"],
  );
  assert.equal(result.more, true);
  assert.doesNotMatch(JSON.stringify(result), /receipt|PRIVATE CHECKPOINT|other/);
  assert.deepEqual(
    (await run("fleet.history", { limit: 1 })).events.map((e) => e.kind),
    ["hold.opened"],
  );
  assert.deepEqual((await run("fleet.history", { since: at, limit: 5 })).events, []);
  store.append({
    project: "orchard",
    at: "2030-01-01T00:01:00.000Z",
    actor: "worker",
    kind: "session.heartbeat",
    payload: { ticket: "SEED-1", session: "one" },
  });
  assert.deepEqual(
    (await run("fleet.history", { since: at, limit: 5 })).events.map((e) => e.kind),
    ["session.heartbeat"],
  );
  assert.equal((await run("fleet.history", { ticket: "PRIVATE-1", limit: 5 })).events.length, 0);
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { since: "yesterday", limit: 1 },
    { since: "2030-99-01T00:00:00Z", limit: 1 },
  ])
    assert.equal((await run("fleet.history", args)).code, "invalid_arguments");
});

test("inbox.list reads open items oldest first without resolving them", async (t) => {
  const { run, store } = await fixture(t);
  const before = store.sequence;
  assert.deepEqual(
    (await run("inbox.list")).items.map((i: InboxItem) => i.id),
    ["q", "back"],
  );
  assert.equal((await run("inbox.list", { extra: true })).code, "invalid_arguments");
  assert.equal(store.sequence, before);
});

test("inbox.answer resolves a question once, preserves phase and refuses missing/empty/unanswerable targets", async (t) => {
  const { run, store } = await fixture(t);
  assert.equal((await run("inbox.answer", { id: "q", answer: " " })).code, "empty_answer");
  assert.equal((await run("inbox.answer", { id: "missing", answer: "Oak" })).code, "no_item");
  assert.equal((await run("inbox.answer", { id: "back", answer: "Merged" })).code, "not_answerable");
  const args = { id: "q", answer: "Oak" };
  const result = await run("inbox.answer", args, "answer");
  assert.equal(result.ok, true);
  assert.equal(typeof result.queued, "string");
  assert.equal(store.readSince(0, "orchard").filter((e) => e.kind === "delivery.queued").length, 1);
  const seq = store.sequence;
  assert.deepEqual(await run("inbox.answer", args, "answer"), result);
  assert.equal(store.sequence, seq);
  const different = await run("inbox.answer", { ...args, answer: "Pine" }, "new-answer");
  assert.equal(different.code, "item_closed");
  assert.match(different.message, /already answered, use worker\.message for a follow-up/);
  assert.deepEqual(await run("inbox.answer", args, "new-call"), result);
  assert.equal(store.sequence, seq);
  assert.equal(fold(store.readSince(0)).projects.orchard?.sessions[0]?.phase, "ready-to-merge");
  assert.ok(fold(store.readSince(0)).projects.other?.inbox.some((i) => i.id === "q"));
});

for (const name of ["worker.launch", "worker.relaunch", "worker.message", "worker.stop", "merge.run"] as const) {
  test(`${name} records an unavailable action as follow-up without performing it`, async (t) => {
    const { run, store } = await fixture(t);
    const before = store.sequence;
    const args =
      name === "worker.launch"
        ? { ticket: "SEED-1", branch: "worker/seed", brief: "Plant" }
        : name === "worker.message"
          ? { ticket: "SEED-1", message: "Plant" }
          : name === "worker.stop" || name === "worker.relaunch"
            ? { ticket: "SEED-1", reason: "Finished" }
            : name === "merge.run"
              ? { pr: 7 }
              : { ticket: "SEED-1", session: "one", pr: 7 };
    const result = await run(name, args);
    const launch = name === "worker.launch" || name === "worker.relaunch";
    assert.equal(result.code, launch ? "capability_missing" : "not_available_yet");
    assert.equal(result.message, launch ? "no runtime provider enabled" : "not available yet");
    assert.ok(result.next);
    const added = store.readSince(before, "orchard");
    assert.deepEqual(
      added.map((e) => e.kind),
      ["inbox.opened"],
    );
    assert.equal((await run("inbox.list")).items.filter((i) => i.kind === "follow-up").length, 1);
  });
}

test("merge.check requires the pinned hand-back, all checks, review evidence and cleared holds", async (t) => {
  const { run, scope, store } = await fixture(t);
  assert.equal((await run("merge.check", { pr: 7 })).ok, true);
  assert.equal((await run("merge.check", { pr: 99 })).code, "no_pr");
  const missing = nativeTools(scope, { now: () => at });
  const result = await missing["merge.check"].execute({ pr: 7 }, {} as ToolExecutionApi, context);
  assert.equal((result.details as unknown as TestFacts).code, "merge_refused");
  assert.ok((result.details as unknown as TestFacts).problems.some((s: string) => s.includes("evidence")));
  for (const change of [
    { head: "b".repeat(40) },
    { draft: true },
    { title: "plant seeds" },
    { mergeState: "DIRTY" },
    { checks: [{ name: "verify", state: "failure" as const }] },
    { checks: [] },
    { checksComplete: false },
    { observedAt: "2029-12-31T23:59:59.000Z" },
    { checks: undefined },
    { reviewThreads: { complete: false, total: 0, read: 0, unresolved: 0 } },
    { reviewThreads: { complete: true, total: 0, read: 1, unresolved: 0 } },
    { acceptance: { state: "passed" as const, head: "b".repeat(40) } },
    { baseTest: { state: "passed" as const, head, base: "d".repeat(40) } },
    { reviewThreads: { complete: true, total: 2, read: 1, unresolved: 0 } },
    { reviewThreads: { complete: true, total: 1, read: 1, unresolved: 1 } },
    { acceptance: { state: "unknown" as const, head } },
    { ownerApproval: { state: "pending" as const, head } },
    { baseTest: { state: "unknown" as const, head, base: "c".repeat(40) } },
  ]) {
    const tools = nativeTools(scope, {
      now: () => at,
      mergeEvidence: async () => ({ ...evidence, ...change }) as MergeEvidence,
    });
    assert.equal((await tools["merge.check"].execute({ pr: 7 }, {} as ToolExecutionApi, context)).isError, true);
  }
  await run("hold.add", { reason: "Main is red" });
  assert.equal((await run("merge.check", { pr: 7 })).ok, false);
  assert.equal(store.readSince(0).filter((e) => e.kind.startsWith("merge.")).length, 0);
});

test("hold.add opens a visible merge pause and refuses an empty reason", async (t) => {
  const { run, store } = await fixture(t);
  assert.equal((await run("hold.add", { reason: " " })).code, "empty_reason");
  const opened = await run("hold.add", { reason: "Main is red" });
  assert.equal(opened.ok, true);
  assert.equal(fold(store.readSince(0)).projects.orchard?.holds[0]?.id, opened.id);
  const facts = await run("fleet.status");
  assert.equal(Object.hasOwn(facts.holds[0] ?? {}, "receipt"), false);
});

test("hold.clear requires a known pause and recovery reason", async (t) => {
  const { run, store } = await fixture(t);
  const { id } = await run("hold.add", { reason: "Main is red" });
  assert.equal((await run("hold.clear", { id, reason: " " })).code, "empty_reason");
  assert.equal((await run("hold.clear", { id: "missing", reason: "Recovered" })).code, "no_hold");
  assert.equal((await run("hold.clear", { id, reason: "Verified main is green" })).ok, true);
  assert.equal(fold(store.readSince(0)).projects.orchard?.holds.length, 0);
  assert.equal((await run("hold.clear", { id, reason: "Again" })).code, "hold_closed");
});

test("owner.ask records choices in a project inbox and refuses missing choices or ticket", async (t) => {
  const { run, store } = await fixture(t);
  const args = { ticket: "SEED-1", question: "Which tree?", choices: ["Oak", "Pine"] };
  assert.equal((await run("owner.ask", { ...args, choices: [] })).code, "no_choices");
  assert.equal((await run("owner.ask", { ...args, question: " " })).code, "empty_question");
  assert.equal((await run("owner.ask", { ...args, ticket: "SEED-9" })).code, "no_ticket");
  const result = await run("owner.ask", args);
  const item = fold(store.readSince(0)).projects.orchard?.inbox.find((i) => i.id === result.id);
  assert.ok(item);
  assert.equal(item.kind, "owner-request");
  assert.equal(Object.hasOwn((await run("inbox.list")).items.find((i) => i.id === result.id) ?? {}, "receipt"), false);
  assert.match(item.body, /1\. Oak\n2\. Pine/);
  assert.equal((await run("inbox.answer", { id: result.id, answer: "Oak" })).code, "not_answerable");
});

test("rules.set persists validated intent with revision checks and cannot overwrite newer rules on replay", async (t) => {
  const { run, store } = await fixture(t);
  const args = {
    expectedRevision: 0,
    reason: "Owner chose local workers",
    rules: {
      placement: { workers: "local", coordinator: "local" },
      policy: { maxWorkers: 3 },
      coordinatorModel: {
        kind: "openai-compatible",
        config: { model: "night-model", baseURL: "https://example.invalid/v1", apiKeySecret: "ZAI_API_KEY" },
      },
    },
  };
  assert.equal((await run("rules.set", { ...args, reason: " " })).code, "empty_reason");
  assert.equal((await run("rules.set", { ...args, rules: { policy: { maxWorkers: -1 } } })).code, "invalid_arguments");
  assert.equal((await run("rules.set", args, "rules-one")).ok, true);
  assert.equal((await run("rules.set", args)).code, "rules_changed");
  assert.equal(
    (await run("rules.set", { ...args, expectedRevision: 1, rules: { policy: { maxWorkers: 5 } } })).ok,
    true,
  );
  assert.equal((await run("rules.set", args, "rules-one")).ok, true);
  assert.equal((await run("fleet.status")).rules.value.policy.maxWorkers, 5);
  assert.equal((await run("fleet.status")).rules.value.coordinatorModel?.kind, "openai-compatible");
  assert.deepEqual(fold(store.readSince(0)).projects.orchard?.rules, {
    revision: 2,
    value: {
      placement: { workers: "local", coordinator: "local" },
      policy: { maxWorkers: 5 },
      coordinatorModel: args.rules.coordinatorModel,
    },
  });
  assert.deepEqual(fold(store.readSince(0)).projects.other?.rules, { revision: 0, value: {} });
  assert.equal(
    (
      await run("rules.set", {
        ...args,
        expectedRevision: 2,
        rules: { policy: { silenceMinutes: 0, quietMinutes: 1 } },
      })
    ).code,
    "invalid_arguments",
  );
  assert.equal(
    (
      await run("rules.set", {
        ...args,
        expectedRevision: 2,
        rules: { routing: [{ labels: [], cli: "codex", model: "garden" }] },
      })
    ).code,
    "invalid_arguments",
  );
  assert.equal(
    (
      await run("rules.set", {
        ...args,
        expectedRevision: 2,
        rules: { policy: { silenceMinutes: 0.5, quietMinutes: 600000, maxWorkers: 1001 } },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await run("rules.set", { ...args, expectedRevision: 3, rules: { policy: { maxWorkers: null } } })).ok,
    true,
  );
  assert.equal((await run("fleet.status")).rules.value.policy.maxWorkers, null);
});

test("only one coordinator owns project writes; disk replay preserves receipts and permits a successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-native-"));
  const file = join(directory, "fleet.sqlite");
  let store = new EventStore(file);
  let scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  try {
    const tools = nativeTools(scope, { now: () => at });
    assert.throws(() => openCoordinatorStorage({ store, project: "orchard", now: () => at }), /already open/);
    const api = { taskId: 9, callId: "pause" } as ToolExecutionApi;
    const first = await tools["hold.add"].execute({ reason: "Recover main" }, api, context);
    await tools["rules.set"].execute(
      {
        expectedRevision: 0,
        reason: "Owner chose VM workers",
        rules: {
          placement: { workers: "vm", coordinator: "local" },
        },
      },
      { taskId: 10, callId: "rules" } as ToolExecutionApi,
      context,
    );
    const before = store.sequence;
    await scope.close(context);
    assert.equal((await tools["hold.add"].execute({ reason: "Stale owner" }, api, context)).isError, true);
    store.close();
    store = new EventStore(file);
    scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
    const restored = nativeTools(scope, { now: () => at });
    assert.deepEqual(await restored["hold.add"].execute({ reason: "Recover main" }, api, context), first);
    assert.equal(store.sequence, before);
    assert.equal(fold(store.readSince(0)).projects.orchard?.holds.length, 1);
    const rules = { revision: 1, value: { placement: { workers: "vm", coordinator: "local" } } };
    assert.deepEqual(fold(store.readSince(0)).projects.orchard?.rules, rules);
    assert.deepEqual(
      ((await restored["fleet.status"].execute({}, {} as ToolExecutionApi, context)).details as unknown as TestFacts)
        .rules,
      rules,
    );
  } finally {
    await scope.close(context);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queueing an answer and its receipt is atomic when the store refuses the queue event", async (t) => {
  const { store, scope } = await fixture(t);
  const original = store.appendMany.bind(store);
  store.appendMany = (events) =>
    original([
      ...events,
      { project: "", at, actor: "coordinator", kind: "inbox.answered", payload: { id: "bad", answer: "bad" } },
    ]);
  const tools = nativeTools(scope, { now: () => at });
  const args = { id: "q", answer: "Oak" };
  const api = { taskId: 20, callId: "answer" } as ToolExecutionApi;
  const before = store.sequence;
  const result = await tools["inbox.answer"].execute(args, api, context);
  assert.equal((result.details as unknown as TestFacts).code, "write_failed");
  assert.equal(store.sequence, before);
  assert.ok(fold(store.readSince(0)).projects.orchard?.inbox.some((i) => i.id === "q"));
  store.appendMany = original;
  assert.equal((await tools["inbox.answer"].execute(args, api, context)).isError, false);
  assert.equal(store.readSince(0).filter((e) => e.kind === "delivery.queued").length, 1);
});

test("answer retries reuse the queued delivery and replay the committed receipt after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-native-"));
  const file = join(directory, "fleet.sqlite");
  let store = new EventStore(file);
  seed(store);
  let scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  const args = { id: "q", answer: "Oak" };
  try {
    let tools = nativeTools(scope, { now: () => at });
    const receipt = await tools["inbox.answer"].execute(
      args,
      { taskId: 1, callId: "first" } as ToolExecutionApi,
      context,
    );
    assert.equal(receipt.isError, false);
    assert.equal(typeof (receipt.details as unknown as TestFacts).queued, "string");
    const intent = store.readSince(0).filter((e) => e.kind === "delivery.queued");
    assert.equal(intent.length, 1);
    assert.equal(intent[0]?.payload.text, "Oak");
    const seq = store.sequence;
    assert.deepEqual(
      await tools["inbox.answer"].execute(args, { taskId: 2, callId: "retry" } as ToolExecutionApi, context),
      receipt,
    );
    await scope.close(context);
    store.close();
    store = new EventStore(file);
    scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
    tools = nativeTools(scope, { now: () => at });
    assert.deepEqual(
      await tools["inbox.answer"].execute(
        { ...args, answer: " Oak " },
        { taskId: 3, callId: "after-restart" } as ToolExecutionApi,
        context,
      ),
      receipt,
    );
    assert.equal(store.sequence, seq);
    assert.deepEqual(
      store.readSince(0).filter((e) => e.kind === "delivery.queued"),
      intent,
    );
  } finally {
    await scope.close(context);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("merge.check re-reads after an adapter yields and refuses changed evidence or a closed owner", async (t) => {
  const { store, scope } = await fixture(t);
  let release: (value: MergeEvidence) => void = () => {
    throw new Error("reader not started");
  };
  const tools = nativeTools(scope, {
    now: () => at,
    mergeEvidence: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const checked = tools["merge.check"].execute({ pr: 7 }, {} as ToolExecutionApi, context);
  store.append({
    project: "orchard",
    at,
    actor: "reader",
    kind: "pull-request.seen",
    payload: { number: 7, ticket: "SEED-1", head: "b".repeat(40), state: "open", ci: "success", conflicting: false },
  });
  release(evidence);
  assert.equal((await checked).isError, true);
  const closed = tools["merge.check"].execute({ pr: 7 }, {} as ToolExecutionApi, context);
  await scope.close(context);
  release(evidence);
  assert.equal(((await closed).details as unknown as TestFacts).code, "coordinator_inactive");
});

test("answer queue identity is scoped to its project", async (t) => {
  const { store, scope } = await fixture(t);
  const other = openCoordinatorStorage({ store, project: "other", now: () => at });
  t.after(() => other.close(context));
  const api = { taskId: 50, callId: "same-provider-id" } as ToolExecutionApi;
  for (const owner of [scope, scope, other]) {
    const tools = nativeTools(owner, { now: () => at });
    assert.equal((await tools["inbox.answer"].execute({ id: "q", answer: "Oak" }, api, context)).isError, false);
  }
  const queued = store.readSince(0).filter((e) => e.kind === "delivery.queued");
  assert.equal(queued.length, 2);
  assert.equal(new Set(queued.map((e) => e.payload.id)).size, 2);
  assert.equal(new Set(queued.map((e) => e.payload.key)).size, 2);
});

test("unsupported or malformed durable rules produce a structured refusal without writing", async (t) => {
  for (const checkpoint of [
    { format: "armada.tools", version: 2, type: "rules", rules: { revision: 1, value: {} } },
    { format: "armada.tools", version: 1, type: "future", rules: { revision: 1, value: {} } },
    { format: "armada.tools", version: 1, type: "rules", rules: { revision: -1, value: {} } },
  ]) {
    const { store, run } = await fixture(t);
    assert.equal((await run("fleet.status")).ok, true);
    store.append({
      project: "orchard",
      at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: { checkpoint },
    });
    const before = store.sequence;
    const result = await run("fleet.status");
    assert.equal(result.code, "state_unavailable");
    assert.ok(result.next);
    assert.equal(store.sequence, before);
  }
});

test("merge.check refuses malformed hand-backs and coordinator notes instead of treating PR text as approval", async (t) => {
  const { store, run } = await fixture(t);
  assert.equal((await run("merge.check", { pr: 7 })).ok, true);
  store.append({
    project: "orchard",
    at,
    actor: "coordinator",
    kind: "inbox.answered",
    payload: { id: "back", answer: "replaced for test" },
  });
  for (const [index, body] of [
    `PR #7, head ${head}`,
    `Agent status: ready-to-merge — note: PR #7, head ${head}`,
    `Agent status: ready-to-merge — acceptance: PR #7, head ${head}`,
  ].entries()) {
    store.append({
      project: "orchard",
      at,
      actor: "worker",
      kind: "inbox.opened",
      payload: { id: `bad-${index}`, ticket: "SEED-1", kind: "hand-back", body },
    });
    assert.equal((await run("merge.check", { pr: 7 })).code, "merge_refused");
  }
});

test("merge.check uses the latest validation so corrected work can be approved", async (t) => {
  const { store, run } = await fixture(t);
  assert.equal((await run("merge.check", { pr: 7 })).ok, true);
  const append = (event: Parameters<EventStore["append"]>[0]) => store.append(event);
  append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "validation.opened",
    payload: { id: "first", ticket: "SEED-1", session: "one", question: "Is the tree right?", checks: [] },
  });
  assert.equal((await run("merge.check", { pr: 7 })).code, "merge_refused");
  append({
    project: "orchard",
    at,
    actor: "owner",
    kind: "validation.decided",
    payload: { id: "first", decision: "changes-requested", note: "Use oak" },
  });
  assert.equal((await run("merge.check", { pr: 7 })).code, "merge_refused");
  append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "validation.opened",
    payload: { id: "corrected", ticket: "SEED-1", session: "one", question: "Is the oak right?", checks: [] },
  });
  append({
    project: "orchard",
    at,
    actor: "owner",
    kind: "validation.decided",
    payload: { id: "corrected", decision: "approved", note: "Yes" },
  });
  assert.equal((await run("merge.check", { pr: 7 })).ok, true);
  append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "validation.opened",
    payload: { id: "new-question", ticket: "SEED-1", session: "one", question: "A new decision?", checks: [] },
  });
  assert.equal((await run("merge.check", { pr: 7 })).code, "merge_refused");
});

// A synthetic V1 project: policy aliases, ordered labels, a kind-of-work profile and fallback.
const v1Toml = `
[project]
name = "Orchard"
slug = "orchard"
[github]
repository = "example/orchard"
[tracker]
program_root = "SEED-1"
[policy]
silent_after_minutes = 12
quiet_minutes = 40
max_workers = 3
[conductor]
default_profile = "general"
[conductor.profiles.general]
instructions = "Check the seeds."
agent = "codex"
model = "garden"
effort = "medium"
[conductor.profiles.api]
instructions = "Check irrigation."
agent = "claude"
model = "oak"
effort = "high"
[conductor.profiles.ui]
instructions = "Check the paths."
agent = "codex"
model = "sun"
effort = "high"
when = "Frontend work"
[[conductor.routing]]
labels = ["backend", "api"]
profile = "api"
`;
const importedValue = {
  routing: [
    { labels: ["backend", "api"], cli: "claude", model: "oak", effort: "high", instructions: "Check irrigation." },
    { when: "Frontend work", cli: "codex", model: "sun", effort: "high", instructions: "Check the paths." },
  ],
  defaultRoute: { cli: "codex", model: "garden", effort: "medium", instructions: "Check the seeds." },
  policy: { silenceMinutes: 12, quietMinutes: 40, maxWorkers: 3 },
};

test("rules.set imports V1 once into the same folded rules as chat, without storing the TOML", async (t) => {
  const { run, store } = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), "armada-rules-import-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "armada.toml");
  writeFileSync(file, v1Toml);
  const args = { expectedRevision: 0, reason: "Import the owner's V1 rules", importFile: file };
  const result = await run("rules.set", args, "import");
  assert.equal(result.ok, true);
  assert.deepEqual(fold(store.readSince(0)).projects.orchard?.rules, {
    revision: 1,
    value: importedValue,
  });
  const committed = store.sequence;
  rmSync(file); // Receipt replay must not read a changed or removed source file.
  assert.deepEqual(await run("rules.set", args, "import"), result);
  assert.equal(store.sequence, committed);
  assert.equal((await run("rules.set", { ...args, expectedRevision: 1 })).code, "rules_already_set");
  assert.equal(store.sequence, committed);
  assert.ok(!JSON.stringify(store.readSince(0)).includes("program_root"));
  // Setting the same intent from the chat produces the same public projection.
  const other = openCoordinatorStorage({ store, project: "chat", now: () => at });
  t.after(() => other.close(context));
  const tools = nativeTools(other, { now: () => at });
  assert.equal(
    (
      await tools["rules.set"].execute(
        { expectedRevision: 0, reason: "Owner's choice", rules: importedValue },
        { taskId: 8, callId: "chat" } as ToolExecutionApi,
        context,
      )
    ).isError,
    false,
  );
  assert.deepEqual(fold(store.readSince(0)).projects.chat?.rules, result.rules);
});

test("invalid imports and ambiguous patches refuse before writing; placement stays explicit", async (t) => {
  const { run, store } = await fixture(t);
  assert.equal((await run("fleet.status")).ok, true);
  const before = store.sequence;
  assert.equal((await run("rules.set", { expectedRevision: 0, reason: "Missing intent" })).code, "invalid_arguments");
  assert.equal(store.sequence, before);
  const directory = mkdtempSync(join(tmpdir(), "armada-rules-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "armada.toml");
  for (const body of [
    "[broken",
    v1Toml.replace('profile = "api"', 'profile = "missing"'),
    v1Toml.replace('agent = "claude"', 'agent = "cursor"'),
    v1Toml.replace("max_workers = 3", "max_workers = 0"),
    v1Toml.replace("quiet_minutes = 40", 'quiet_minutes = "later"'),
    v1Toml.replace("silent_after_minutes = 12", "silent_after_minutes = 12\nsilence_minutes = 5"),
  ]) {
    writeFileSync(file, body);
    assert.equal(
      (await run("rules.set", { expectedRevision: 0, reason: "Import", importFile: file })).code,
      "invalid_import",
    );
    assert.equal(store.sequence, before);
  }
  for (const importFile of [directory, join(directory, "missing.toml"), "armada.toml"]) {
    assert.equal(
      (await run("rules.set", { expectedRevision: 0, reason: "Import", importFile })).code,
      "invalid_import",
    );
    assert.equal(store.sequence, before);
  }
  writeFileSync(file, " ".repeat(262145));
  assert.equal(
    (await run("rules.set", { expectedRevision: 0, reason: "Too large", importFile: file })).code,
    "invalid_import",
  );
  assert.equal(store.sequence, before);
  assert.equal(
    (await run("rules.set", { expectedRevision: 0, reason: "Mixed", importFile: file, rules: {} })).code,
    "invalid_arguments",
  );
  assert.equal(
    (
      await run("rules.set", {
        expectedRevision: 0,
        reason: "VM workers",
        rules: {
          placement: { workers: "vm", coordinator: "local" },
          routing: [{ when: "Backend work", cli: "claude", model: "oak" }],
        },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await run("rules.set", { expectedRevision: 1, reason: "Import", importFile: file })).code,
    "rules_already_set",
  );
});

for (const plans of ["pre-approved", "unsupported"]) {
  test(`V1 import preserves and validates the plan policy: ${plans}`, async (t) => {
    const { run, store } = await fixture(t);
    const directory = mkdtempSync(join(tmpdir(), "armada-plan-import-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "armada.toml");
    writeFileSync(
      file,
      `[policy]\nplans = "${plans}"\napproval_label = "Review Required"\npre_approved_label = "May Proceed"\n`,
    );
    const result = await run("rules.set", { expectedRevision: 0, reason: "Import plan rules", importFile: file });
    if (plans === "unsupported") assert.equal(result.code, "invalid_import");
    else {
      assert.equal(result.ok, true);
      assert.deepEqual(fold(store.readSince(0)).projects.orchard?.rules?.value.policy, {
        plans: "pre-approved",
        approvalLabel: "Review Required",
        preApprovedLabel: "May Proceed",
        silenceMinutes: 15,
        quietMinutes: 45,
        maxWorkers: null,
      });
    }
  });
}

for (const labels of [
  'approval_label = "Review Required"\npre_approved_label = "review-required"',
  'approval_label = "plan approved"',
]) {
  test(`V1 import refuses colliding plan labels including defaults: ${labels}`, async (t) => {
    const { run, store } = await fixture(t);
    const directory = mkdtempSync(join(tmpdir(), "armada-label-import-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "armada.toml");
    writeFileSync(file, `[policy]\n${labels}\n`);
    const before = store.sequence;
    assert.equal(
      (await run("rules.set", { expectedRevision: 0, reason: "Import labels", importFile: file })).code,
      "invalid_import",
    );
    assert.equal(store.sequence, before);
  });
}

test("rules.set rejects negative budgets and invalid civil windows without recording a rules change", async (t) => {
  const { run, store } = await fixture(t);
  const valid = await run("rules.set", {
    expectedRevision: 0,
    rules: { policy: { budget: { coordinatorTokensPerDay: 100, zone: "UTC" } } },
    reason: "Owner's night ceiling",
  });
  assert.equal(valid.ok, true);
  for (const budget of [
    { coordinatorTokensPerDay: -1, zone: "UTC" },
    { coordinatorTokensPerDay: Number.MAX_SAFE_INTEGER + 1, zone: "UTC" },
    { workerLaunchesPerNight: -1, zone: "UTC" },
    { workerLaunchesPerNight: 1, nightStart: "25:00", zone: "UTC" },
    { coordinatorTokensPerDay: 100, zone: "Not/A_Zone" },
  ]) {
    const before = store.sequence;
    const result = await run("rules.set", {
      expectedRevision: 1,
      rules: { policy: { budget } },
      reason: "Invalid change",
    });
    assert.equal(result.ok, false);
    assert.equal(store.sequence, before);
  }
});

test("raising one budget preserves the other ceiling and the configured night window", async (t) => {
  const { run } = await fixture(t);
  assert.equal(
    (
      await run("rules.set", {
        expectedRevision: 0,
        rules: {
          policy: {
            budget: { coordinatorTokensPerDay: 100, workerLaunchesPerNight: 3, nightStart: "21:00", zone: "UTC" },
          },
        },
        reason: "Owner's ceilings",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await run("rules.set", {
        expectedRevision: 1,
        rules: { policy: { budget: { coordinatorTokensPerDay: 200, zone: "UTC" } } },
        reason: "Owner raises tokens",
      })
    ).ok,
    true,
  );
  const facts = await run("fleet.status");
  assert.deepEqual((facts.rules.value.policy as unknown as { budget: object }).budget, {
    coordinatorTokensPerDay: 200,
    workerLaunchesPerNight: 3,
    nightStart: "21:00",
    zone: "UTC",
  });
});

async function ticketFixture(t: TestContext, wrap: (tracker: TrackerProvider) => TrackerProvider = (t) => t) {
  const directory = mkdtempSync(join(tmpdir(), "armada-ticket-tools-"));
  const daemon = await bootDaemon({
    databasePath: join(directory, "events.sqlite"),
    configPath: join(directory, "config.json"),
    catalog: [{ id: "internal-tracker", manifest: pkg.armada, load: async () => ({ activate }) }],
    secrets: { get: async () => assert.fail("Internal tickets need no secrets") },
    log: {
      info() {},
      error(line) {
        assert.fail(line);
      },
    },
  });
  const { store } = daemon;
  const internal = daemon.registry.get("tracker", "internal");
  assert.ok(internal);
  const tracker = wrap(internal);
  const { workers, fake } = fakeWorkers(store, [{ id: "orchard", repository: "example/orchard" }]);
  store.append({
    project: "orchard",
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        reason: "Owner routing",
        rules: {
          revision: 1,
          value: {
            defaultRoute: { cli: "claude", model: "fixture" },
            placement: { workers: "local", coordinator: "local" },
          },
        },
      },
    },
  });
  let scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  const options = { now: () => at, tracker: "internal", trackerProvider: () => tracker, workers };
  let tools = nativeTools(scope, options);
  let call = 0;
  const run = async (name: CoordinatorToolName, args: object, callId = String(++call)) => {
    const result = await tools[name].execute(
      args,
      { taskId: 1, callId, details: async () => {} } as unknown as ToolExecutionApi,
      context,
    );
    const first = result.output?.[0];
    assert.ok(first?.type === "text");
    assert.deepEqual(JSON.parse(first.text), result.details);
    return result.details as unknown as TestFacts;
  };
  t.after(async () => {
    await workers.close();
    await scope.close(context);
    daemon.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    fake,
    tracker,
    run,
    close: () => scope.close(context),
    restart: async () => {
      await scope.close(context);
      scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
      tools = nativeTools(scope, options);
    },
  };
}

test("coordinator creates, edits and comments an internal ticket, then launches it on the fake runtime", async (t) => {
  const f = await ticketFixture(t);
  assert.equal(
    (await f.run("fleet.status", {})).unavailable.some((gap) => gap.capability === "tracker-write"),
    false,
  );
  const created = await f.run(
    "ticket.create",
    { title: "Plant an oak", description: "Beside the river", ready: true, labels: ["api"] },
    "create",
  );
  assert.equal(created.ok, true);
  assert.equal(created.id, "ORCHA-1");
  const parent = await f.run("ticket.create", { title: "Orchard", description: "The spec" });
  const blocker = await f.run("ticket.create", { title: "Prepare soil", description: "Before planting" });
  assert.equal((await f.run("ticket.update", { id: blocker.id, state: "completed" })).ok, true);
  assert.equal(
    (
      await f.run("ticket.update", {
        id: created.id,
        title: "Plant two oaks",
        description: "Along the river",
        addLabels: ["trees"],
        removeLabels: ["api"],
        parent: parent.id,
        blockers: [blocker.id],
      })
    ).ok,
    true,
  );
  const read = await f.run("ticket.read", { id: created.id });
  assert.equal(read.ticket.title, "Plant two oaks");
  assert.equal(read.ticket.description, "Along the river");
  assert.deepEqual(read.ticket.labels, ["ready-for-agent", "trees"]);
  assert.equal(read.ticket.parent?.id, parent.id);
  assert.deepEqual(read.ticket.blockers, [{ id: blocker.id, status: "completed" }]);
  assert.equal(
    (await f.run("ticket.comment", { id: created.id, body: "Owner confirmed the location" }, "comment")).ok,
    true,
  );
  assert.deepEqual(
    (await f.run("ticket.comment", { body: "Owner confirmed the location", id: created.id }, "comment")).ok,
    true,
  );
  assert.equal((await f.run("ticket.comment", { id: created.id, body: "Different" }, "comment")).code, "call_conflict");
  const launched = await f.run("worker.launch", { ticket: created.id, branch: "worker/plant-oaks" });
  assert.equal(launched.ok, true);
  assert.match(f.fake.delivered[0]?.message ?? "", /Plant two oaks/);
  assert.match(f.fake.delivered[0]?.message ?? "", /The spec/);
  assert.equal(
    (
      await f.run("ticket.update", {
        id: created.id,
        labels: ["parked"],
        addLabels: ["note"],
        state: "canceled",
        parent: null,
        blockers: [],
      })
    ).ok,
    true,
  );
  const edited = (await f.run("ticket.read", { id: created.id })).ticket;
  assert.equal(edited.status, "canceled");
  assert.equal(edited.parent, null);
  assert.deepEqual(edited.labels, ["parked", "note"]);
  assert.deepEqual(edited.blockers, []);
  assert.equal(edited.comments?.length, 1);
});

test("ticket call identities survive reopening and recover a committed create whose response was lost", async (t) => {
  let creates = 0;
  const f = await ticketFixture(t, (tracker) => ({
    ...tracker,
    create: async (request) => {
      creates++;
      assert.ok(tracker.create);
      const result = await tracker.create(request);
      if (creates === 1) throw new Error("Response lost after commit");
      return result;
    },
  }));
  const args = { title: "Plant", description: "One tree", ready: true };
  await f.run("ticket.create", args, "durable");
  await f.restart();
  const recovered = await f.run("ticket.create", args, "durable");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.id, "ORCHA-1");
  assert.equal(creates, 1);
  assert.equal((await f.run("ticket.create", { ...args, title: "Other" }, "durable")).code, "call_conflict");
  assert.equal((await f.run("ticket.update", { id: recovered.id, title: "Other" }, "durable")).code, "call_conflict");
  assert.equal(f.store.fold("orchard").projects.orchard?.tickets.length, 1);
  const other = openCoordinatorStorage({ store: f.store, project: "other", now: () => at });
  const result = await nativeTools(other, { now: () => at, trackerProvider: () => f.tracker })["ticket.update"].execute(
    { id: recovered.id, title: "Stolen" },
    { taskId: 1, callId: "other" } as ToolExecutionApi,
    context,
  );
  assert.equal((result.details as { code: string }).code, "no_ticket");
  await other.close(context);
  await f.close();
  assert.equal((await f.run("ticket.create", args, "closed")).code, "coordinator_inactive");
});

test("Linear ticket tools create once per call key and the next reader publishes ticket.seen", async (t) => {
  const { store, scope } = await fixture(t);
  let linear: TrackerProvider | undefined;
  const recording = linearRecorded({
    MutationRoot: [
      {
        issue: {
          id: "uuid-SEED-1",
          team: { id: "team", states: linearPage([{ id: "backlog", type: "backlog", position: 0 }]) },
        },
      },
    ],
    RecentTickets: [{ issues: linearPage([]) }],
    CreateTicket: [
      {
        issueCreate: {
          success: true,
          issue: { id: "uuid-SEED-3", identifier: "SEED-3", url: "https://linear.example/SEED-3" },
        },
      },
    ],
    Root: [{ issue: linearIssue("SEED-1") }],
    Children: [
      { issues: linearPage([{ ...linearIssue("SEED-3"), title: "Plant", description: "Tree" }]) },
      { issues: linearPage([]) },
    ],
    Comments: [
      {
        issues: {
          nodes: [
            { identifier: "SEED-1", comments: linearPage([]) },
            { identifier: "SEED-3", comments: linearPage([]) },
          ],
        },
      },
    ],
  });
  t.mock.method(globalThis, "fetch", recording.fetch);
  activateLinear({
    events: {
      read: async (project: string, after: number) =>
        store.readSince(after).filter((event) => event.project === project),
      append: async (event: Parameters<EventStore["append"]>[0]) => store.append(event),
    },
    log: { info() {}, error() {} },
    secrets: { get: async () => "synthetic-key" },
    config: { tracker: { linear: { projects: { orchard: { programRoot: "SEED-1" } } } } },
    register: {
      tracker: (_kind: string, tracker: TrackerProvider) => {
        linear = tracker;
      },
    },
  } as unknown as import("@armada/plugin-api").PluginContext);
  assert.ok(linear?.create);
  const tools = nativeTools(scope, { now: () => at, trackerProvider: () => linear });
  const create = () =>
    tools["ticket.create"].execute(
      { title: "Plant", description: "Tree" },
      { taskId: 1, callId: "linear-create" } as ToolExecutionApi,
      context,
    );
  const result = await create();
  assert.deepEqual(result.details, { ok: true, id: "SEED-3" });
  assert.deepEqual((await create()).details, result.details);
  assert.equal(recording.calls.filter((call) => call.operation === "CreateTicket").length, 1);
  await linear.read({ project: "orchard" });
  assert.ok(
    store
      .readSince(0)
      .some(
        (event) => event.kind === "ticket.seen" && event.payload.id === "SEED-3" && event.payload.title === "Plant",
      ),
  );
  assert.equal(
    store.fold("orchard").projects.orchard?.tickets.find((ticket) => ticket.id === "SEED-3")?.description,
    "Tree",
  );
});

test("ticket receipts replay successful creates and edits without overwriting later changes", async (t) => {
  const f = await ticketFixture(t);
  const args = { title: "Plant", description: "One tree" };
  const created = await f.run("ticket.create", args, "create");
  assert.equal((await f.run("ticket.update", { id: created.id, addLabels: ["ready-for-agent"] }, "ready")).ok, true);
  await f.run("ticket.update", { id: created.id, removeLabels: ["ready-for-agent"] }, "unready");
  await f.restart();
  assert.deepEqual(await f.run("ticket.create", { description: "One tree", title: "Plant" }, "create"), created);
  assert.equal((await f.run("ticket.update", { id: created.id, addLabels: ["ready-for-agent"] }, "ready")).ok, true);
  const ticket = (await f.run("ticket.read", { id: created.id })).ticket;
  assert.deepEqual(ticket.labels, []);
  assert.equal(f.store.fold("orchard").projects.orchard?.tickets.length, 1);
});

test("unconfirmed creates refuse replay while interrupted comments keep their provider id", async (t) => {
  let failedCreates = 0;
  let failCreate = false;
  const commentIds: (string | undefined)[] = [];
  const f = await ticketFixture(t, (tracker) => ({
    ...tracker,
    create: async (request) => {
      if (failCreate) {
        failedCreates++;
        throw new Error("Unavailable before confirmation");
      }
      assert.ok(tracker.create);
      return tracker.create(request);
    },
    write: async (request) => {
      commentIds.push(request.commentId);
      if (commentIds.length === 1) throw new Error("Unconfirmed comment request");
      await tracker.write(request);
    },
  }));
  const args = { title: "Plant", description: "One tree" };
  const created = await f.run("ticket.create", args, "created");
  const comment = { id: created.id, body: "Same comment after reconnect" };
  assert.equal((await f.run("ticket.comment", comment, "note")).code, "tracker_write_failed");
  await f.restart();
  assert.equal((await f.run("ticket.comment", comment, "note")).ok, true);
  assert.equal(commentIds.length, 2);
  assert.ok(commentIds[0]);
  assert.equal(commentIds[0], commentIds[1]);
  failCreate = true;
  assert.equal((await f.run("ticket.create", args, "unknown")).code, "tracker_write_failed");
  await f.restart();
  assert.equal((await f.run("ticket.create", args, "unknown")).code, "ticket_outcome_unknown");
  assert.equal(failedCreates, 1);
});

test("ticket mutation validates call identity and fences a provider that yields before writing", async (t) => {
  let entered!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = await ticketFixture(t, (tracker) => ({
    ...tracker,
    create: async (request) => {
      entered();
      await gate;
      assert.ok(tracker.create);
      return tracker.create(request);
    },
  }));
  const args = { title: "Plant", description: "One tree" };
  assert.equal((await f.run("ticket.create", args, "")).code, "missing_call_id");
  assert.equal((await f.run("ticket.create", { ...args, extra: true }, "invalid")).code, "invalid_arguments");
  const pending = f.run("ticket.create", args, "delayed");
  await ready;
  await f.close();
  resume();
  assert.equal((await pending).code, "coordinator_inactive");
  assert.equal(f.store.fold("orchard").projects.orchard?.tickets.length, 0);
});

test("ticket.comment reaches Linear with a stable UUID and deduplicates an unconfirmed response", async (t) => {
  const { store, scope } = await fixture(t);
  let linear: TrackerProvider | undefined;
  const comments: { id: string; body: string }[] = [];
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (request.query.includes("query WriteIssue"))
      return Response.json({
        data: {
          issue: {
            id: "linear-issue",
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            comments: { nodes: comments, pageInfo: { hasNextPage: false } },
          },
        },
      });
    assert.match(request.query, /mutation PostComment/);
    const input = request.variables.input;
    assert.match(input.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(input.issueId, "linear-issue");
    posts++;
    comments.push({ id: input.id, body: input.body });
    if (posts === 2) throw new Error("Response lost after Linear accepted the comment");
    return Response.json({ data: { commentCreate: { success: true } } });
  });
  activateLinear({
    events: {},
    config: { tracker: { linear: { projects: { orchard: { programRoot: "SPEC" } } } } },
    secrets: { get: async () => "fixture-key" },
    register: {
      tracker: (_kind: string, tracker: TrackerProvider) => {
        linear = tracker;
      },
    },
  } as unknown as import("@armada/plugin-api").PluginContext);
  let tools = nativeTools(scope, { now: () => at, trackerProvider: () => linear });
  const run = async (callId: string, body: string) => {
    const result = await tools["ticket.comment"].execute(
      { id: "SEED-1", body },
      { taskId: 1, callId } as ToolExecutionApi,
      context,
    );
    return result.details as { ok: boolean; code: string };
  };
  assert.equal((await run("first", "Owner context")).ok, true);
  assert.equal((await run("lost", "More context")).code, "tracker_write_failed");
  await scope.close(context);
  const reopened = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  t.after(() => reopened.close(context));
  tools = nativeTools(reopened, { now: () => at, trackerProvider: () => linear });
  assert.equal((await run("lost", "More context")).ok, true);
  assert.equal(posts, 2, "recovery reuses the remote comment id instead of creating a second comment");
  assert.equal(comments.length, 2);
});

test("a green tracker hand-back gap is one durable follow-up, answerable locally and closed by merge", async (t) => {
  const { store, run } = await fixture(t);
  const append = (kind: FleetEvent["kind"], payload: unknown) =>
    store.append({ project: "orchard", at, actor: "reader", kind, payload } as never);
  append("ticket.seen", { id: "SEED-2", title: "Water", status: "started", phase: "ready-to-merge" });
  append("pull-request.seen", { number: 8, ticket: "SEED-2", head, state: "open", ci: "success", conflicting: false });
  const ready = (await run("fleet.status")).sessions.find((s) => s.ticket === "SEED-2");
  assert.equal(ready?.runtime, "tracker");
  assert.equal(ready?.phase, "ready-to-merge");
  assert.equal(ready?.checks, "success");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const refusal = await run("merge.check", { pr: 8 });
    assert.equal(refusal.ok, false);
    const followUps = (await run("inbox.list")).items.filter((i) => i.kind === "follow-up");
    assert.equal(followUps.length, 1);
    const item = followUps[0]!;
    assert.equal(item.followUp?.attempts, attempt);
    assert.equal(item.followUp?.code, refusal.code);
    assert.match(item.followUp?.reason ?? "", /no .*ready-to-merge.*comment/);
    assert.match(item.followUp?.facts ?? "", /ready-to-merge.*green/);
    assert.equal(item.followUp?.tool, "merge.check");
    assert.deepEqual(item.followUp?.args, { pr: 8 });
  }
  const item = (await run("inbox.list")).items.find((i) => i.kind === "follow-up")!;
  assert.equal((await run("inbox.answer", { id: item.id, answer: "  " })).code, "empty_answer");
  assert.equal((await run("inbox.answer", { id: item.id, answer: "Tracked the hand-back gap" })).ok, true);
  assert.equal(
    (await run("inbox.list")).items.some((i) => i.id === item.id),
    false,
  );
  assert.equal(
    store.readSince(0, "orchard").some((e) => e.kind === "delivery.queued"),
    false,
  );
  await run("merge.check", { pr: 8 });
  assert.equal((await run("inbox.list")).items.filter((i) => i.kind === "follow-up").length, 1);
  append("merge.confirmed", { id: "merge-8", pr: 8, head, ticket: "SEED-2", session: "tracker:SEED-2" });
  assert.equal((await run("inbox.list")).items.filter((i) => i.kind === "follow-up").length, 0);
});

test("a disabled runtime refusal names its owner fix, masks inputs and clears only on relevant recovery", async (t) => {
  const f = await ticketFixture(t);
  const created = await f.run("ticket.create", { title: "Water the trees", description: "At dawn", ready: true });
  assert.equal(created.ok, true);
  assert.equal(
    (
      await f.run("rules.set", {
        expectedRevision: 1,
        reason: "Choose runtime",
        rules: { defaultRoute: { cli: "codex", model: "fixture" } },
      })
    ).ok,
    true,
  );
  const availability = (enabled: boolean) =>
    f.store.append({
      project: "orchard",
      at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "providers",
          providers: [{ id: "codex", enabled, loaded: false, capabilities: ["runtime.codex"] }],
        },
      },
    });
  availability(false);
  for (let i = 0; i < 2; i++) {
    const refusal = await f.run("worker.launch", { ticket: created.id, brief: "Bearer synthetic-private-value" });
    assert.equal(refusal.code, "plugin_disabled");
  }
  const blocked = (await f.run("inbox.list", {})).items.filter((i) => i.kind === "follow-up");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.followUp?.attempts, 2);
  assert.equal(blocked[0]?.followUp?.fix, "Enable codex in Settings › Providers");
  assert.equal(f.fake.delivered.length, 0);
  assert.doesNotMatch(JSON.stringify(blocked), /synthetic-private-value/);
  assert.equal(
    (await f.run("worker.message", { ticket: created.id, message: "Continue" })).code,
    "worker_outside_daemon",
  );
  assert.equal((await f.run("inbox.list", {})).items.filter((i) => i.kind === "follow-up").length, 2);
  availability(true);
  const remaining = (await f.run("inbox.list", {})).items.filter((i) => i.kind === "follow-up");
  assert.equal(remaining.length, 1, "enabling a plugin cannot clear a worker-outside-daemon cause");
  assert.equal(remaining[0]?.followUp?.fix, "answer in Linear or relaunch here");
  assert.equal(
    (
      await f.run("rules.set", {
        expectedRevision: 2,
        reason: "Use available runtime",
        rules: { defaultRoute: { cli: "claude", model: "fixture" } },
      })
    ).ok,
    true,
  );
  const launch = await f.run("worker.launch", { ticket: created.id, branch: "worker/water" });
  assert.equal(launch.ok, true, JSON.stringify(launch));
  assert.equal((await f.run("inbox.list", {})).items.filter((i) => i.kind === "follow-up").length, 0);
});

test("a tracker refresh or stale worker report cannot resolve a live generation's merge follow-up", async (t) => {
  const { store, run } = await fixture(t);
  store.append({
    project: "orchard",
    at,
    actor: "coordinator",
    kind: "inbox.answered",
    payload: { id: "back", answer: "Hand-back not confirmed" },
  });
  assert.equal((await run("fleet.status")).sessions[0]?.phase, "ready-to-merge");
  assert.equal((await run("merge.check", { pr: 7 })).ok, false);
  const count = async () => (await run("inbox.list")).items.filter((i) => i.kind === "follow-up").length;
  assert.equal(await count(), 1);
  store.append({
    project: "orchard",
    at,
    actor: "reader",
    kind: "ticket.seen",
    payload: { id: "SEED-1", title: "Renamed", status: "started" },
  });
  assert.equal((await run("fleet.status")).sessions[0]?.phase, "ready-to-merge");
  assert.equal(await count(), 1, "an observation that preserves the socket worker is not recovery");
  store.append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "session.reported",
    payload: { ticket: "SEED-1", session: "old", phase: "implementing", reason: "Stale" },
  });
  assert.equal(await count(), 1);
  store.append({
    project: "orchard",
    at,
    actor: "worker",
    kind: "session.reported",
    payload: { ticket: "SEED-1", session: "one", phase: "implementing", reason: "Fixing the gap" },
  });
  assert.equal(await count(), 0);
});

// A disabled Conductor must not hide other enabled runtime providers.
test("fleet.status gives actionable gaps from enabled runtimes and the selected tracker's write support", async (t) => {
  const { store, scope } = await fixture(t);
  const tools = nativeTools(scope, { now: () => at, trackerProvider: () => undefined });
  const read = async () =>
    (await tools["fleet.status"].execute({}, {} as ToolExecutionApi, context)).details as unknown as TestFacts;
  const providers = (enabled: boolean, loaded = enabled) =>
    store.append({
      project: "orchard",
      at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "providers",
          providers: [
            { id: "conductor", enabled: false, loaded: false, capabilities: ["runtime.conductor"] },
            { id: "codex", enabled, loaded, capabilities: ["runtime.codex"] },
          ],
        },
      },
    });
  providers(false);
  const missing = (await read()).unavailable;
  assert.deepEqual(
    missing.find((gap) => gap.capability === "launch"),
    {
      capability: "launch",
      reason: "no runtime provider enabled",
      fix: "Enable Conductor, Claude, Codex or OpenCode in Settings › Providers",
    },
  );
  assert.deepEqual(
    missing.find((gap) => gap.capability === "tracker-write"),
    {
      capability: "tracker-write",
      reason: "the project's tracker cannot create tickets",
      fix: "write it in Linear",
    },
  );
  for (const gap of missing) {
    assert.ok(gap.reason.trim(), gap.capability);
    assert.ok(gap.fix.trim(), gap.capability);
  }
  providers(true);
  assert.equal(
    (await read()).unavailable.some((gap) => gap.capability === "launch"),
    false,
  );
  const noHost = await tools["worker.launch"].execute(
    { ticket: "SEED-1" },
    { taskId: 1, callId: "no-host" } as ToolExecutionApi,
    context,
  );
  assert.match(JSON.stringify(noHost.details), /worker execution is not attached.*Restart Armada/);
  providers(true, false);
  assert.match((await read()).unavailable.find((gap) => gap.capability === "launch")?.fix ?? "", /restart|reopen/i);
});
