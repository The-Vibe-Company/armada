import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ForgeInspection, ForgeProvider, NodeProvider, TrackerProvider } from "@armada/plugin-api";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { inspectGithub } from "../../plugins/github/src/inspect.ts";
import type { RawPull } from "../../plugins/github/src/normalize.ts";
import { trackerChanges } from "../../plugins/linear/src/changes.ts";
import { createLocalNode } from "../../plugins/node-local/src/index.ts";
import { nativeTools } from "../coordinator/native.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import { wakeups } from "../coordinator/wake.ts";
import type { EventInput } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { Merges } from "../src/merge/service.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { EventStore } from "../src/store.ts";

const at = "2030-01-01T00:00:00.000Z";
const head = "a".repeat(40);
const base = "b".repeat(40);
const pull = (): ForgeInspection => ({
  number: 7,
  head,
  base,
  baseRef: "main",
  state: "open",
  draft: false,
  title: "feat(garden): grow",
  url: "https://github.com/example/orchard/pull/7",
  mergeState: "CLEAN",
  mergeCommit: null,
  behindBy: 0,
  observedAt: at,
  checksComplete: true,
  checks: [{ name: "verify", state: "success" }],
  requiredChecks: ["verify"],
  reviewThreads: { complete: true, total: 1, read: 1, unresolved: 0 },
});
function register(registry: PluginRegistry, forge: ForgeProvider, tracker: TrackerProvider, node?: NodeProvider) {
  const activation = registry.activation({
    id: "merge-test",
    version: "1",
    pluginApi: "^0.2.0",
    enabledByDefault: true,
    description: "merge adapters",
    contributions: {
      forge: { github: { config: {}, secrets: [] } },
      tracker: { linear: { config: {}, secrets: [] } },
      ...(node ? { node: { local: { config: {}, secrets: [] } } } : {}),
    },
  });
  activation.register.forge("github", forge);
  activation.register.tracker("linear", tracker);
  if (node) activation.register.node("local", node);
  activation.commit();
}
async function fixture(t: TestContext, priorHandBack = false, trackerOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "armada-merge-tool-"));
  const store = new EventStore(join(directory, "events.sqlite"));
  const append = (kind: EventInput["kind"], payload: unknown, actor = "worker") =>
    store.append({
      project: "orchard",
      kind,
      payload,
      at,
      actor,
    } as EventInput);
  const trackerReading = {
    startedAt: at,
    tickets: [
      {
        uuid: "seed",
        id: "SEED-1",
        title: "Grow",
        status: "started" as const,
        phase: "ready-to-merge" as const,
        owner: "Mira",
        parent: null,
        url: "https://linear.example/issue/SEED-1",
        labels: [],
        attachments: [],
      },
    ],
    comments: [
      {
        id: "back",
        ticket: "SEED-1",
        author: "Mira",
        body: `Agent status: ready-to-merge — PR #7, head ${head}`,
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  if (trackerOnly) {
    for (const event of trackerChanges("orchard", [], trackerReading)) store.append(event);
  } else {
    append("ticket.seen", { id: "SEED-1", title: "Grow", status: "started" });
    if (priorHandBack)
      append("inbox.opened", {
        id: "old-back",
        ticket: "SEED-1",
        kind: "hand-back",
        body: `Agent status: ready-to-merge — PR #6, head ${"e".repeat(40)}`,
      });
    append("session.claimed", {
      ticket: "SEED-1",
      session: "one",
      generation: 1,
      owner: "Mira",
      runtime: "claude",
      handle: "one",
    });
    append("session.reported", { ticket: "SEED-1", session: "one", phase: "ready-to-merge", reason: "Green" });
  }
  append("pull-request.seen", { number: 7, ticket: "SEED-1", head, state: "open", ci: "success", conflicting: false });
  const handBack = (body = `Agent status: ready-to-merge — PR #7, head ${head}`) => {
    append("inbox.answered", { id: "back", answer: "superseded" });
    append("inbox.opened", { id: "back", ticket: "SEED-1", kind: "hand-back", body });
  };
  if (!trackerOnly) handBack();
  const scope = openCoordinatorStorage({ store, project: "orchard", now: () => at });
  let facts = pull();
  let mergeCalls = 0;
  let stopCalls = 0;
  const writes: Parameters<TrackerProvider["write"]>[0][] = [];
  const forge: ForgeProvider = {
    read: async () => {},
    inspect: async () => structuredClone(facts),
    merge: async (request) => {
      request.beforeWrite?.();
      mergeCalls++;
      assert.equal(request.head, facts.head);
      assert.equal(request.number, 7);
      facts = { ...facts, state: "merged", mergeCommit: "c".repeat(40) };
      return { merged: true, mergeCommit: facts.mergeCommit ?? undefined };
    },
  };
  const tracker: TrackerProvider = {
    read: async () => {},
    write: async (request) => {
      request.beforeWrite?.();
      assert.equal(
        store.readSince(0).filter((e) => e.kind === "merge.confirmed").length,
        1,
        "GitHub fact precedes tracker cleanup",
      );
      writes.push(request);
    },
  };
  const node = { testMerge: async () => ({ ok: true as const }) } as unknown as NodeProvider;
  const registry = new PluginRegistry();
  register(registry, forge, tracker, node);
  const options = {
    registry,
    projects: [{ id: "orchard", checkout: "/checkout", forge: "github", tracker: "linear" }],
    now: () => at,
    stop: async () => {
      stopCalls++;
      assert.equal(writes.length, 1);
      assert.equal(fold(store.readSince(0)).projects.orchard?.sessions[0]?.phase, "merged");
      return { ok: true, stopped: true, disposed: true };
    },
  };
  let service = new Merges(options);
  let tools = nativeTools(scope, { now: () => at, merges: service });
  const progress: { callId: string; step: string }[] = [];
  const run = async (name: "merge.check" | "merge.run", pr = 7, callId = "merge") => {
    const result = await tools[name].execute(
      { pr },
      {
        taskId: 1,
        callId,
        details: async (value: { step: string }) => {
          progress.push({ callId, step: value.step });
        },
      } as unknown as ToolExecutionApi,
      context,
    );
    return result.details as {
      ok: boolean;
      code?: string;
      reason?: string;
      next?: string;
      problems?: string[];
      step?: string;
      tests?: string[];
      tail?: string;
      fix?: string;
      cleanup?: { disposed?: boolean };
      waiting?: boolean;
      head?: string;
      merged?: boolean;
      followUp?: string;
    };
  };
  t.after(async () => {
    await scope.close(context);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    trackerReading,
    scope,
    append,
    handBack,
    run,
    progress,
    forge,
    tracker,
    node,
    registry,
    options,
    writes,
    setFacts: (value: Partial<ForgeInspection>) => {
      facts = { ...facts, ...value };
    },
    counts: () => ({ mergeCalls, stopCalls }),
    restart: () => {
      service = new Merges(options);
      tools = nativeTools(scope, { now: () => at, merges: service });
    },
  };
}

test("native merge tools check read-only, pin squash merge, confirm before Done/comment/stop, and replay once", async (t) => {
  const f = await fixture(t);
  const before = f.store.sequence;
  assert.equal((await f.run("merge.check")).ok, true);
  assert.equal(f.store.sequence, before);
  const result = await f.run("merge.run");
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.progress.map((p) => p.step),
    ["checking", "checking", "merging", "merged"],
  );
  assert.equal(result.cleanup?.disposed, true);
  assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 1 });
  assert.equal(f.writes[0]?.state, "completed");
  assert.match(f.writes[0]?.commentId ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(
    f.writes[0]?.comment,
    `Agent status: merged — PR #7 squash-merged into main as ${"c".repeat(40)}, head ${head}`,
  );
  f.restart();
  assert.deepEqual(await f.run("merge.run"), result);
  assert.equal((await f.run("merge.run", 8)).code, "call_conflict");
  assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 1 });
  assert.equal(fold(f.store.readSince(0)).projects.orchard?.inbox.length, 0);
  f.options.registry = new PluginRegistry();
  f.restart();
  assert.deepEqual(await f.run("merge.run"), result, "committed replay must not depend on available providers");
});

test("tracker-derived hand-backs pass native merge tools and close without daemon runtime cleanup", async (t) => {
  const f = await fixture(t, false, true);
  assert.equal(
    f.store.readSince(0).some((e) => e.kind === "session.claimed"),
    false,
  );
  assert.equal((await f.run("merge.check")).ok, true);
  assert.equal((await f.run("merge.run")).ok, true);
  assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 0 });
  assert.equal(f.writes[0]?.state, "completed");
  assert.deepEqual(fold(f.store.readSince(0)).projects.orchard?.inbox, []);
  assert.equal(
    f.store.readSince(0).filter((e) => e.kind === "inbox.answered" && e.payload.id === `linear:back:${at}`).length,
    1,
  );
  // The tracker can still return the old phase while its write is propagating.
  for (const event of trackerChanges("orchard", f.store.readSince(0), f.trackerReading)) f.store.append(event);
  assert.deepEqual(fold(f.store.readSince(0)).projects.orchard?.inbox, []);
  f.restart();
  assert.equal((await f.run("merge.run")).ok, true);
  assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 0 });
});

// Recorded GitHub wire answers go through the real inspection adapter before the native checklist.
function githubRecording() {
  const raw: RawPull & {
    baseRef: { name: string; target: { oid: string } };
    mergeCommit: null;
    reviewThreads: {
      totalCount: number;
      nodes: { isResolved: boolean }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } = {
    number: 7,
    title: "feat(garden): grow",
    url: "https://github.com/example/orchard/pull/7",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: "feature/seed-1",
    headRefOid: head,
    reviewDecision: "APPROVED",
    baseRef: { name: "main", target: { oid: base } },
    mergeCommit: null,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            checkSuites: { nodes: [], pageInfo: { hasNextPage: false } },
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "verify",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                    checkSuite: null,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  return { raw, behind: 0 };
}
type Recording = ReturnType<typeof githubRecording>;
const commitOf = (r: Recording) => {
  const commit = r.raw.commits.nodes[0]?.commit;
  assert.ok(commit?.statusCheckRollup);
  return commit;
};
const contextsOf = (r: Recording) => {
  const contexts = commitOf(r).statusCheckRollup?.contexts;
  assert.ok(contexts);
  return contexts;
};
const firstCheck = (r: Recording) => {
  const check = contextsOf(r).nodes[0];
  assert.ok(check?.__typename === "CheckRun");
  return check;
};
for (const [name, change, expected] of [
  [
    "moved head",
    (r) => {
      r.raw.headRefOid = "d".repeat(40);
      commitOf(r).oid = r.raw.headRefOid;
    },
    "different head",
  ],
  [
    "closed PR",
    (r) => {
      r.raw.state = "CLOSED";
    },
    "not open",
  ],
  [
    "draft",
    (r) => {
      r.raw.isDraft = true;
    },
    "is a draft",
  ],
  [
    "title",
    (r) => {
      r.raw.title = "Grow";
    },
    "Commitizen",
  ],
  [
    "mergeability",
    (r) => {
      r.raw.mergeStateStatus = "BLOCKED";
    },
    "not CLEAN",
  ],
  [
    "required check missing",
    (r) => {
      firstCheck(r).name = "other";
    },
    "has not reported",
  ],
  [
    "duplicate check red",
    (r) => {
      contextsOf(r).nodes.push({
        __typename: "CheckRun",
        name: "verify",
        status: "COMPLETED",
        conclusion: "FAILURE",
        checkSuite: null,
      });
    },
    "is failure",
  ],
  [
    "check pending",
    (r) => {
      firstCheck(r).status = "IN_PROGRESS";
      firstCheck(r).conclusion = null;
    },
    "is pending",
  ],
  [
    "no checks",
    (r) => {
      contextsOf(r).nodes = [];
    },
    "no CI check",
  ],
  [
    "truncated checks",
    (r) => {
      commitOf(r).checkSuites.pageInfo.hasNextPage = true;
    },
    "enumeration is incomplete",
  ],
  [
    "truncated threads",
    (r) => {
      r.raw.reviewThreads.totalCount = 2;
      r.raw.reviewThreads.pageInfo.hasNextPage = true;
    },
    "incomplete",
  ],
  [
    "unresolved thread",
    (r) => {
      r.raw.reviewThreads.nodes = [{ isResolved: false }];
    },
    "unresolved review thread",
  ],
  [
    "behind without local gates",
    (r) => {
      r.behind = 2;
    },
    "rules.set gates",
  ],
] as [string, (recording: Recording) => void, string][]) {
  test(`merge.check refuses recorded GitHub ${name} before any write`, async (t) => {
    const f = await fixture(t);
    const recording = githubRecording();
    change(recording);
    f.forge.inspect = async () =>
      inspectGithub({
        repository: "example/orchard",
        number: 7,
        token: "synthetic-key",
        signal: new AbortController().signal,
        now: () => new Date(at),
        fetch: async (url) => {
          if (String(url).endsWith("/graphql"))
            return Response.json({ data: { repository: { pullRequest: recording.raw } } });
          if (String(url).includes("/compare/"))
            return Response.json({ behind_by: recording.behind, base_commit: { sha: base } });
          return Response.json({ required_status_checks: { contexts: ["verify"] } });
        },
      });
    const result = await f.run("merge.run");
    assert.equal(result.ok, false);
    const codes: Record<string, string> = {
      "moved head": "head_moved",
      "duplicate check red": "checks_red",
      "check pending": "checks_pending",
      "required check missing": "checks_pending",
      "no checks": "checks_pending",
      "truncated checks": "checks_pending",
      "truncated threads": "review_threads_open",
      "unresolved thread": "review_threads_open",
    };
    if (codes[name]) assert.equal(result.code, codes[name]);
    assert.ok(result.reason, "a refusal explains its cause");
    assert.match(result.next ?? "", /merge\.|worker\.message|rules\.set/);
    assert.doesNotMatch(JSON.stringify(result), /armada |armada\.toml/);
    assert.ok(
      [result.reason, ...(result.problems ?? [])].some((p) => p?.includes(expected)),
      JSON.stringify(result),
    );
    assert.deepEqual(f.counts(), { mergeCalls: 0, stopCalls: 0 });
    assert.deepEqual(f.writes, []);
  });
}
test("merge.check refuses an unavailable base comparison", async (t) => {
  const f = await fixture(t);
  f.setFacts({ behindBy: null });
  assert.match(JSON.stringify(await f.run("merge.check")), /could not compare/);
});

test("merge.check refuses invalid hand-backs, unready phase, holds and owner validations", async (t) => {
  const f = await fixture(t);
  for (const body of [
    "Agent status: ready-to-merge — PR #8",
    "Agent status: ready-to-merge — PR #7, head aaa",
    `Agent status: ready-to-merge — PR #7, head ${"d".repeat(40)}`,
    `Agent status: ready-to-merge — note: PR #7, head ${head}`,
  ]) {
    f.handBack(body);
    assert.equal((await f.run("merge.check")).ok, false);
  }
  f.handBack();
  f.append("session.reported", { ticket: "SEED-1", session: "one", phase: "implementing", reason: "Working" });
  assert.equal((await f.run("merge.check")).ok, false);
  f.append("session.reported", { ticket: "SEED-1", session: "one", phase: "ready-to-merge", reason: "Green" });
  f.append("hold.opened", { id: "hold", reason: "Deploy failed" });
  const held = await f.run("merge.run");
  assert.equal(held.code, "hold_open");
  assert.match(held.reason ?? "", /hold.*Deploy failed/);
  assert.match(held.next ?? "", /hold.clear.*hold/);
  f.append("hold.cleared", { id: "hold", reason: "Healthy" });
  f.append("validation.opened", {
    id: "check",
    ticket: "SEED-1",
    session: "one",
    question: "Looks right?",
    checks: [],
  });
  assert.equal((await f.run("merge.check")).ok, false);
  f.append("validation.decided", { id: "check", decision: "approved", note: "Yes" }, "owner");
  assert.equal((await f.run("merge.check")).ok, true);
});

function gates(f: Awaited<ReturnType<typeof fixture>>) {
  f.append(
    "coordinator.checkpoint",
    {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: { revision: 1, value: { gates: { requiredChecks: ["verify"], localCommands: ["bun run verify"] } } },
        reason: "Local gates",
      },
    },
    "coordinator",
  );
}
test("behind head runs configured gates through the node and rechecks holds after tests yield", async (t) => {
  const f = await fixture(t);
  gates(f);
  f.setFacts({ behindBy: 2 });
  let tests = 0;
  f.node.testMerge = async (request) => {
    tests++;
    assert.deepEqual(request.commands, ["bun run verify"]);
    assert.equal(request.base, base);
    assert.equal(request.head, head);
    return { ok: true };
  };
  assert.equal((await f.run("merge.check")).ok, true);
  assert.equal(tests, 1);
  f.node.testMerge = async () => {
    f.append("hold.opened", { id: "hold", reason: "A new failure" });
    return { ok: true };
  };
  assert.equal((await f.run("merge.run")).ok, false);
  assert.equal(f.counts().mergeCalls, 0);
});

test("failed local gate and moving final base refuse the pinned merge", async (t) => {
  const f = await fixture(t);
  gates(f);
  f.setFacts({ behindBy: 1 });
  f.node.testMerge = async () => ({
    ok: false,
    step: "bun run verify",
    output: "failed first line\nprivate subprocess body",
  });
  const failed = await f.run("merge.run");
  assert.equal(failed.code, "local_gate_failed");
  assert.match(failed.reason ?? "", /bun run verify/);
  assert.equal(failed.tail, undefined);
  assert.deepEqual(failed.tests, []);
  assert.doesNotMatch(JSON.stringify(failed), /private subprocess body|failed first line/);
  assert.doesNotMatch(JSON.stringify(f.store.readSince(0)), /private subprocess body|failed first line/);
  assert.ok(
    f.store.readSince(0).some((e) => e.kind === "merge.refused" && e.payload.pr === 7),
    "a refusal before the merge still wakes the coordinator",
  );

  f.node.testMerge = async () => {
    f.setFacts({ base: "d".repeat(40) });
    return { ok: true };
  };
  assert.equal((await f.run("merge.run")).code, "head_moved");
  assert.equal(f.counts().mergeCalls, 0);
});

for (const baseCheck of ["failed", "passed", "unavailable", undefined] as const) {
  test(`local gate diagnostics distinguish base ${baseCheck} without persisting output`, async (t) => {
    const f = await fixture(t);
    gates(f);
    f.setFacts({ behindBy: 1 });
    f.node.testMerge = async () => ({
      ok: false,
      step: "bun run verify",
      output: [
        "\x1b[31mnot ok 12 - boot stays responsive\x1b[0m",
        "(fail) plugin loads [5.12ms]",
        "not ok 12 - boot stays responsive",
        "not ok 13 - masks token=synthetic-test-token",
        ...Array.from({ length: 35 }, (_, i) => `private diagnostic ${i}`),
        "authorization: Bearer synthetic-credential",
        "token=synthetic-tail-token",
        "armada_worker_synthetic_session",
        "final diagnostic",
      ].join("\n"),
      ...(baseCheck ? { baseCheck } : {}),
    });
    const result = await f.run("merge.check");
    assert.equal(result.code, baseCheck === "failed" ? "local_gate_environment" : "local_gate_failed");
    assert.equal(result.step, "bun run verify");
    assert.deepEqual(result.tests, ["boot stays responsive", "plugin loads", "masks token=[redacted]"]);
    assert.equal(result.tail, undefined);
    assert.match(result.reason ?? "", /boot stays responsive/);
    assert.doesNotMatch(JSON.stringify(result), /private diagnostic|final diagnostic|synthetic-|synthetic_session/);
    if (baseCheck === "failed") {
      assert.match(result.reason ?? "", /fails on main too/);
      assert.match(result.fix ?? "", /CI.*environment/);
      assert.doesNotMatch(result.next ?? "", /worker.message/);
    }
    const events = f.store.readSince(0);
    const followUp = events.findLast((e) => e.kind === "inbox.opened" && e.payload.kind === "follow-up");
    assert.ok(followUp?.kind === "inbox.opened");
    assert.match(followUp.payload.followUp?.facts ?? "", /bun run verify.*boot stays responsive.*plugin loads/);
    if (baseCheck === "failed") assert.match(followUp.payload.followUp?.fix ?? "", /CI.*environment/);
    assert.doesNotMatch(JSON.stringify(events), /private diagnostic|final diagnostic|synthetic-|synthetic_session/);
    assert.equal(f.counts().mergeCalls, 0);
  });
}

test("daemon lease refuses concurrent merges and releases after failure", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.forge.merge = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { merged: false };
  };
  const first = f.run("merge.run");
  // Wait on a real adapter boundary, never a wall clock.
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  f.restart(); // A second service object still shares the daemon's project lease.
  assert.equal((await f.run("merge.run", 7, "second")).code, "lease_held");
  release();
  assert.equal((await first).ok, false);
  assert.equal((await f.run("merge.check")).ok, true);
});

test("unknown merge write is not repeated across restart; exact merged head recovers cleanup", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  f.forge.merge = async (request) => {
    request.beforeWrite?.();
    writes++;
    throw new Error("Connection lost");
  };
  assert.equal((await f.run("merge.run")).code, "merge_unconfirmed");
  f.restart();
  assert.equal((await f.run("merge.run")).code, "merge_unconfirmed");
  assert.equal(writes, 1);
  f.setFacts({ state: "merged", mergeCommit: "c".repeat(40) });
  // The reader discovers the completed merge well after the original hand-back.
  f.append("pull-request.merged", {
    number: 7,
    ticket: "SEED-1",
    head,
    state: "merged",
    ci: "success",
    conflicting: false,
    repository: "example/orchard",
    title: "Grow",
    url: "https://github.com/example/orchard/pull/7",
    headRef: "feature/seed-1",
    draft: false,
    review: "none",
    checks: [],
    checksComplete: true,
    mergeCommit: "c".repeat(40),
    mergedAt: at,
  });
  assert.equal(
    fold(f.store.readSince(0)).projects.orchard?.inbox.some((item) => item.id === "back"),
    true,
  );
  const recovered = await f.run("merge.run", 7, "recover");
  assert.equal(
    fold(f.store.readSince(0)).projects.orchard?.inbox.some((item) => item.id === "back"),
    false,
  );
  assert.equal(recovered.ok, true);
  assert.deepEqual(await f.run("merge.run", 7, "recover"), recovered);
  assert.deepEqual(await f.run("merge.run", 7, "merge"), recovered, "original intent also has a terminal receipt");
  assert.notEqual(
    (await f.run("merge.check", 8, "later")).code,
    "merge_pending",
    "recovery must not leave a pending original key",
  );
  assert.equal(writes, 1);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "merge.confirmed").length, 1);
});

test("late merge recovery cannot clean up a replacement generation or its hand-back", async (t) => {
  const f = await fixture(t);
  f.forge.merge = async (request) => {
    request.beforeWrite?.();
    throw new Error("Connection lost");
  };
  assert.equal((await f.run("merge.run")).code, "merge_unconfirmed");
  f.store.append({
    project: "orchard",
    actor: "worker",
    at: "2030-01-02T00:00:00Z",
    kind: "session.claimed",
    payload: {
      ticket: "SEED-1",
      session: "replacement",
      generation: 2,
      owner: "Mira",
      runtime: "claude",
      handle: "replacement",
    },
  });
  f.append("inbox.opened", {
    id: "replacement-back",
    ticket: "SEED-1",
    kind: "hand-back",
    body: `Agent status: ready-to-merge — PR #8, head ${"d".repeat(40)}`,
  });
  f.append("pull-request.merged", {
    number: 7,
    ticket: "SEED-1",
    head,
    state: "merged",
    ci: "success",
    conflicting: false,
    repository: "example/orchard",
    title: "Grow",
    url: "https://github.com/example/orchard/pull/7",
    headRef: "feature/seed-1",
    draft: false,
    review: "none",
    checks: [],
    checksComplete: true,
    mergeCommit: "c".repeat(40),
    mergedAt: at,
  });
  assert.equal(fold(f.store.readSince(0)).projects.orchard?.sessions[0]?.phase, "planning");
  f.setFacts({ state: "merged", mergeCommit: "c".repeat(40) });
  f.restart();
  assert.equal((await f.run("merge.run", 7, "late-recover")).code, "worker_changed");
  assert.equal(f.writes.length, 0);
  assert.equal(f.counts().stopCalls, 0);
  assert.deepEqual(
    fold(f.store.readSince(0)).projects.orchard?.inbox.map((item) => item.id),
    ["back", "replacement-back"],
  );
});

test("tracker failure retains confirmed merge and resumes tracker/stop without merging twice", async (t) => {
  const f = await fixture(t);
  const write = f.tracker.write;
  f.tracker.write = async () => {
    throw new Error("Linear offline");
  };
  const failed = await f.run("merge.run");
  assert.equal(failed.code, "tracker_write_failed");
  assert.match(failed.reason ?? "", /Linear offline/);
  assert.match(failed.next ?? "", /merge.run/);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "merge.confirmed").length, 1);
  assert.equal(
    f.store.readSince(0).filter((e) => e.kind === "merge.refused").length,
    0,
    "cleanup failure must not report that an already confirmed merge was refused",
  );
  f.tracker.write = write;
  f.restart();
  assert.equal((await f.run("merge.run")).ok, true);
  assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 1 });
});

test("replacement generation and closed writer fence async evidence and cleanup", async (t) => {
  const f = await fixture(t);
  const inspect = f.forge.inspect;
  f.forge.inspect = async (request) => {
    f.append("session.claimed", {
      ticket: "SEED-1",
      session: "two",
      generation: 2,
      owner: "Mira",
      runtime: "claude",
      handle: "two",
    });
    return (await inspect?.(request)) as ForgeInspection;
  };
  assert.equal((await f.run("merge.run")).ok, false);
  assert.equal(f.counts().mergeCalls, 0);
  f.forge.inspect = async (request) => {
    await f.scope.close(context);
    return (await inspect?.(request)) as ForgeInspection;
  };
  assert.equal((await f.run("merge.run")).ok, false);
  assert.equal(f.counts().mergeCalls, 0);
});

test("local node test merge runs ordered gates on pinned commits and removes dirty throwaway on failure", {
  timeout: 10_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-merge-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Merge test");
    git("config", "user.email", "merge@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n");
    writeFileSync(join(directory, "main.txt"), "base\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("switch", "-c", "worker");
    writeFileSync(join(directory, "worker.txt"), "worker\n");
    git("add", ".");
    git("commit", "-m", "worker");
    const worker = git("rev-parse", "HEAD");
    git("switch", "main");
    writeFileSync(join(directory, "main.txt"), "main advanced\n");
    git("add", ".");
    git("commit", "-m", "main");
    const main = git("rev-parse", "HEAD");
    const node = createLocalNode();
    const request = {
      project: "orchard",
      repository: directory,
      number: 7,
      branch: "main",
      base: main,
      head: worker,
      commands: ["test -f worker.txt && test -f main.txt", "echo first > gate-order", "test $(cat gate-order) = first"],
    };
    assert.deepEqual(await node.testMerge?.(request), { ok: true });
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    assert.equal(git("rev-parse", "HEAD"), main);
    assert.equal(git("status", "--porcelain"), "");
    // The same private worktree is cleaned and checked out at base; the worker file disappears.
    const headOnly = await node.testMerge?.({
      ...request,
      commands: [
        "mkdir -p node_modules; echo ready > node_modules/setup; echo ready > setup-prerequisite",
        "test -f node_modules/setup && test -f setup-prerequisite || exit 2; if test -f worker.txt; then echo dirty > generated; echo 'not ok 1 - head regression' >&2; exit 1; fi; test ! -f generated",
      ],
    });
    assert.equal(headOnly?.ok, false);
    if (headOnly && !headOnly.ok) {
      assert.match(headOnly.output, /not ok 1 - head regression/);
      assert.equal(headOnly.baseCheck, "passed");
    }
    // A descendant inherits both pipes after the gate exits. Completion also proves
    // process-group cleanup closes them instead of waiting until the gate timeout.
    const command = `node -e "process.stdout.write('x'.repeat(70000)); process.stderr.write('not ok 2 - machine gate\\n'); require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'inherit' }).unref(); process.exitCode = 1"`;
    const failure = await node.testMerge?.({ ...request, commands: [command, "exit 0"] });
    assert.equal(failure?.ok, false);
    if (failure && !failure.ok) {
      assert.equal(failure.step, command);
      assert.equal(failure.baseCheck, "failed");
      assert.ok(Buffer.byteLength(failure.output) <= 64 * 1024);
      assert.ok(failure.output.length > 60 * 1024);
      assert.match(failure.output, /not ok 2 - machine gate/);
    }
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    assert.equal(readFileSync(join(directory, "main.txt"), "utf8"), "main advanced\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const boundary of ["final inspection", "provider credentials"] as const) {
  test(`changed local gates at ${boundary} refuse without a forge write`, async (t) => {
    const f = await fixture(t);
    gates(f);
    f.setFacts({ behindBy: 1 });
    const changeRules = () =>
      f.append(
        "coordinator.checkpoint",
        {
          checkpoint: {
            format: "armada.tools",
            version: 1,
            type: "rules",
            reason: "Add a required gate",
            rules: {
              revision: 2,
              value: { gates: { requiredChecks: ["verify"], localCommands: ["new-required-gate"] } },
            },
          },
        },
        "coordinator",
      );
    let externalWrites = 0;
    if (boundary === "final inspection") {
      const inspect = f.forge.inspect;
      assert.ok(inspect);
      let reads = 0;
      f.forge.inspect = async (request) => {
        const result = await inspect(request);
        if (++reads === 2) changeRules();
        return result;
      };
    } else {
      f.forge.merge = async (request) => {
        changeRules();
        request.beforeWrite?.();
        externalWrites++;
        return { merged: true };
      };
    }
    const result = await f.run("merge.run");
    assert.equal(result.code, "rules_changed");
    assert.match(result.reason ?? "", /rules changed|Local gates changed/);
    assert.match(result.next ?? "", /merge.check/);
    assert.equal(f.counts().mergeCalls, 0);
    assert.equal(externalWrites, 0);
  });
}

for (const change of [{ baseRef: "release" }, { behindBy: null }]) {
  test(`final target or unknown ancestry refuses: ${JSON.stringify(change)}`, async (t) => {
    const f = await fixture(t);
    const inspect = f.forge.inspect;
    assert.ok(inspect);
    let count = 0;
    f.forge.inspect = async (request) => {
      if (++count === 2) f.setFacts(change);
      return inspect(request);
    };
    assert.equal((await f.run("merge.run")).ok, false);
    assert.equal(f.counts().mergeCalls, 0);
  });
}
test("a lost worker's explicit release never confirms merge cleanup without native stop proof", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("merge.check")).ok, true);
  const stop = f.options.stop;
  f.options.stop = async () => ({ ok: true, stopped: false, disposed: false });
  const result = await f.run("merge.run");
  assert.equal(result.ok, false);
  assert.equal(result.code, "cleanup_pending");
  assert.equal(f.counts().mergeCalls, 1, "the merge succeeded before its cleanup refusal");
  assert(fold(f.store.readSince(0)).projects.orchard?.inbox.some((item) => item.kind === "hand-back"));
  f.options.stop = stop;
  assert.equal((await f.run("merge.run", 7, "cleanup-retry")).ok, true);
  assert.equal(f.counts().mergeCalls, 1);
});

test("merged generation cleanup preserves an older generation's hand-back", async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.run("merge.run")).ok, true);
  assert.deepEqual(
    fold(f.store.readSince(0)).projects.orchard?.inbox.map((i) => i.id),
    ["old-back"],
  );
});

for (const step of ["local gates", "worker cleanup"] as const) {
  test(`a canceled ${step} deadline returns and permits safe recovery`, async (t) => {
    const f = await fixture(t);
    const controllers = new WeakMap<AbortSignal, AbortController>();
    t.mock.method(AbortSignal, "timeout", () => {
      const controller = new AbortController();
      controllers.set(controller.signal, controller);
      return controller.signal;
    });
    let entered = false;
    const hangUntilDeadline = (signal?: AbortSignal) => {
      assert.ok(signal);
      const controller = controllers.get(signal);
      assert.ok(controller);
      entered = true;
      controller.abort();
      return new Promise<never>(() => {});
    };
    const originalStop = f.options.stop;
    if (step === "local gates") {
      gates(f);
      f.setFacts({ behindBy: 1 });
      f.node.testMerge = (request) => hangUntilDeadline(request.signal);
    } else {
      const stop: NonNullable<ConstructorParameters<typeof Merges>[0]["stop"]> = (_scope, _session, _key, signal) =>
        hangUntilDeadline(signal);
      Object.assign(f.options, { stop });
    }
    assert.equal((await f.run("merge.run")).ok, false);
    assert.equal(entered, true);
    if (step === "local gates") {
      assert.equal(f.counts().mergeCalls, 0);
      f.node.testMerge = async () => ({ ok: true });
      assert.equal((await f.run("merge.check")).ok, true, "deadline released the reversible gate operation");
    } else {
      Object.assign(f.options, { stop: originalStop });
      assert.equal((await f.run("merge.run")).ok, true);
      assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 1 });
    }
  });
}

for (const [otherPr, otherHead] of [
  [8, head],
  [7, "d".repeat(40)],
] as const) {
  test(`merge cleanup preserves another hand-back: PR${otherPr}, head${otherHead.slice(0, 7)}`, async (t) => {
    const f = await fixture(t);
    f.append("inbox.opened", {
      id: "another-back",
      ticket: "SEED-1",
      kind: "hand-back",
      body: `Agent status: ready-to-merge — PR #${otherPr}, head ${otherHead}`,
    });
    f.handBack();
    assert.equal((await f.run("merge.run")).ok, true);
    assert.deepEqual(
      fold(f.store.readSince(0)).projects.orchard?.inbox.map((i) => i.id),
      ["another-back"],
    );
  });
}

for (const name of ["merge.check", "merge.run"] as const) {
  test(`${name} retains a sanitized forge failure and never writes`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("merge.check")).ok, true);
    f.forge.inspect = async () => {
      throw new Error(
        "Forge timed out eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.signature Authorization: Bearer secret-test-token\nresponse body: private details",
      );
    };
    const result = await f.run(name);
    assert.equal(result.code, "forge_unreachable");
    assert.match(result.reason ?? "", /Forge timed out/);
    assert.doesNotMatch(JSON.stringify(result), /eyJ|secret-test-token|private details|response body/);
    assert.match(result.next ?? "", /merge\.(check|run)/);
    assert.deepEqual(f.counts(), { mergeCalls: 0, stopCalls: 0 });
  });
}

test("red check refusal names every failing check and the head with worker guidance", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("merge.check")).ok, true);
  f.setFacts({
    checks: [
      { name: "Lint, typecheck and test", state: "failure" },
      { name: "Build", state: "failure" },
    ],
  });
  const result = await f.run("merge.run");
  assert.equal(result.code, "checks_red");
  assert.equal(result.reason, "Red: Lint, typecheck and test, Build on aaaaaaa");
  assert.match(result.next ?? "", /worker.message.*fix and hand back/);
  assert.equal(f.counts().mergeCalls, 0);
});

for (const provider of ["forge", "tracker"] as const) {
  test(`missing ${provider} provider names the unavailable dependency`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("merge.check")).ok, true);
    const project = f.options.projects[0];
    assert.ok(project);
    project[provider] = "uninstalled";
    f.restart();
    const result = await f.run("merge.run");
    assert.equal(result.code, provider === "forge" ? "forge_unreachable" : "tracker_write_failed");
    assert.match(result.reason ?? "", /provider unavailable/);
    assert.match(result.next ?? "", /merge\.(check|run)/);
    assert.equal(f.counts().mergeCalls, 0);
  });
}

test("hold opened at the forge write guard retains its ids and clear guidance", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("merge.check")).ok, true);
  const merge = f.forge.merge;
  f.forge.merge = async (request) => {
    f.append("hold.opened", { id: "deploy-7", reason: "Health check failed" });
    return merge(request);
  };
  const result = await f.run("merge.run");
  assert.equal(result.code, "hold_open");
  assert.match(result.reason ?? "", /deploy-7.*Health check failed/);
  assert.match(result.next ?? "", /hold.clear deploy-7/);
  assert.equal(f.counts().mergeCalls, 0);
});

// The merged project registry must select the project's current providers, not the daemon's boot defaults.
test("merge uses project-scoped forge, tracker and local gates instead of boot providers", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("merge.check")).ok, true);
  gates(f);
  f.setFacts({ behindBy: 1 });
  const scoped = new PluginRegistry();
  register(scoped, { ...f.forge }, { ...f.tracker }, { ...f.node });
  f.registry.setProject("orchard", scoped);
  f.forge.inspect = async () => {
    throw new Error("Boot forge must not be used");
  };
  f.tracker.write = async () => {
    throw new Error("Boot tracker must not be used");
  };
  f.node.testMerge = async () => {
    throw new Error("Boot local gates must not be used");
  };
  assert.equal((await f.run("merge.run")).ok, true);
  assert.deepEqual(f.counts(), { mergeCalls: 1, stopCalls: 1 });
  assert.equal(f.writes.length, 1);
});

const updatedHead = "d".repeat(40);

function branchUpdate(f: Awaited<ReturnType<typeof fixture>>) {
  let calls = 0;
  f.setFacts({ behindBy: 1, mergeState: "BEHIND" });
  f.forge.updateBranch = async (request) => {
    request.beforeWrite?.();
    calls++;
    assert.equal(request.expectedHead, head);
    f.setFacts({
      head: updatedHead,
      headParents: [head, base],
      behindBy: 0,
      mergeState: "BLOCKED",
      checks: [{ name: "verify", state: "pending" }],
    });
    return { updated: true };
  };
  return () => calls;
}
const followUps = (f: Awaited<ReturnType<typeof fixture>>) =>
  fold(f.store.readSince(0)).projects.orchard?.inbox.filter((i) => i.kind === "follow-up") ?? [];

test("behind-base hand-back updates once, waits durably, then merges on new-head green without another hand-back", async (t) => {
  const f = await fixture(t, false, true);
  const updates = branchUpdate(f);
  const check = await f.run("merge.check");
  assert.equal(check.ok, false);
  assert.match(check.next ?? "", /merge.run/);
  assert.equal(updates(), 0, "read-only check cannot authorize an unupdated behind head");
  const waiting = await f.run("merge.run");
  assert.equal(waiting.ok, true);
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.head, updatedHead);
  assert.equal(waiting.next, "merge.run again when the checks are green");
  assert.equal(updates(), 1);
  assert.equal(f.counts().mergeCalls, 0);
  assert.equal(followUps(f).length, 1);
  assert.equal(followUps(f)[0]?.followUp?.head, updatedHead);
  f.append("pull-request.seen", {
    number: 7,
    ticket: "SEED-1",
    head: updatedHead,
    state: "open",
    ci: "pending",
    conflicting: false,
  });
  assert.equal(followUps(f).length, 1, "observing the update must not close its wait");
  f.restart();
  assert.equal((await f.run("merge.run", 7, "wait-again")).waiting, true);
  assert.equal(updates(), 1);
  assert.equal(followUps(f).length, 1);
  f.setFacts({ mergeState: "CLEAN", checks: [{ name: "verify", state: "success" }] });
  const beforeGreen = { events: f.store.readSince(0), tables: fold(f.store.readSince(0)).projects.orchard };
  f.append("pull-request.checks-green", {
    number: 7,
    ticket: "SEED-1",
    head: updatedHead,
    state: "open",
    ci: "success",
    conflicting: false,
  });
  const afterGreen = { events: f.store.readSince(0), tables: fold(f.store.readSince(0)).projects.orchard };
  assert.ok(
    wakeups(beforeGreen, afterGreen).some(
      (c) => c.facts.pr === 7 && c.facts.head === updatedHead && c.facts.state === "success",
    ),
  );
  assert.equal((await f.run("merge.run", 7, "green")).merged, true);
  assert.equal(updates(), 1);
  assert.equal(f.counts().mergeCalls, 1);
  assert.deepEqual(fold(f.store.readSince(0)).projects.orchard?.inbox, []);
  assert.match(f.writes[0]?.comment ?? "", new RegExp(`head ${updatedHead}`));
});

test("updated-head red checks turn the same wait into named worker repair", async (t) => {
  const f = await fixture(t);
  const updates = branchUpdate(f);
  assert.equal((await f.run("merge.run")).waiting, true);
  const id = followUps(f)[0]?.id;
  f.setFacts({ checks: [{ name: "Lint, typecheck and test", state: "failure" }] });
  f.append("pull-request.checks-red", {
    number: 7,
    ticket: "SEED-1",
    head: updatedHead,
    state: "open",
    ci: "failure",
    conflicting: false,
  });
  const result = await f.run("merge.run", 7, "red");
  assert.equal(result.code, "checks_red");
  assert.match(result.reason ?? "", /Lint, typecheck and test/);
  assert.match(result.next ?? "", /worker.message/);
  assert.equal(followUps(f).length, 1);
  assert.equal(followUps(f)[0]?.id, id);
  assert.match(followUps(f)[0]?.followUp?.reason ?? "", /Lint, typecheck and test/);
  assert.match(followUps(f)[0]?.followUp?.next ?? "", /worker.message/);
  assert.equal(updates(), 1);
  assert.equal(f.counts().mergeCalls, 0);
  const repaired = "e".repeat(40);
  f.setFacts({ head: repaired, mergeState: "CLEAN", checks: [{ name: "verify", state: "success" }] });
  f.append("pull-request.seen", {
    number: 7,
    ticket: "SEED-1",
    head: repaired,
    state: "open",
    ci: "success",
    conflicting: false,
  });
  f.handBack(`Agent status: ready-to-merge — PR #7, head ${repaired}`);
  assert.equal((await f.run("merge.run", 7, "repaired")).merged, true);
  assert.equal(updates(), 1);
  assert.deepEqual(fold(f.store.readSince(0)).projects.orchard?.inbox, []);
});

for (const parents of [undefined, [head], [head, "e".repeat(40)], ["e".repeat(40), base], [base, head]]) {
  test(`branch update refuses unproven base-only parents: ${JSON.stringify(parents)}`, async (t) => {
    const f = await fixture(t);
    branchUpdate(f);
    const update = f.forge.updateBranch;
    assert.ok(update);
    f.forge.updateBranch = async (request) => {
      const result = await update(request);
      f.setFacts({ headParents: parents });
      return result;
    };
    assert.equal((await f.run("merge.run")).code, "head_moved");
    assert.equal(f.counts().mergeCalls, 0);
  });
}

test("an interrupted accepted branch update is inspected after restart and never written twice", async (t) => {
  const f = await fixture(t);
  const updates = branchUpdate(f);
  const update = f.forge.updateBranch;
  assert.ok(update);
  f.forge.updateBranch = async (request) => {
    await update(request);
    throw new Error("connection lost after acceptance");
  };
  await f.run("merge.run");
  f.restart();
  assert.equal((await f.run("merge.run", 7, "recover-update")).waiting, true);
  assert.equal(updates(), 1);
  f.setFacts({ head: "e".repeat(40), checks: [{ name: "verify", state: "success" }], mergeState: "CLEAN" });
  f.append("pull-request.seen", {
    number: 7,
    ticket: "SEED-1",
    head: "e".repeat(40),
    state: "open",
    ci: "success",
    conflicting: false,
  });
  assert.equal((await f.run("merge.run", 7, "worker-push")).code, "head_moved");
  assert.equal(f.counts().mergeCalls, 0);
});

test("an asynchronous accepted update waits once and recovers directly to green with original hand-back cleanup", async (t) => {
  const f = await fixture(t);
  let updates = 0;
  f.setFacts({ behindBy: 1 });
  f.forge.updateBranch = async (request) => {
    request.beforeWrite?.();
    updates++;
    return { updated: true };
  };
  assert.equal((await f.run("merge.run")).waiting, true);
  f.restart();
  assert.equal((await f.run("merge.run", 7, "still-updating")).waiting, true);
  assert.equal(updates, 1);
  f.setFacts({ head: updatedHead, headParents: [head, base], behindBy: 0 });
  assert.equal((await f.run("merge.run", 7, "already-green")).merged, true);
  assert.equal(updates, 1);
  assert.deepEqual(fold(f.store.readSince(0)).projects.orchard?.inbox, []);
  assert.equal((await f.run("merge.run")).merged, true, "original update call replays the finished merge");
});

for (const state of ["closed", "merged"] as const) {
  test(`terminal ${state} during update produces an actionable result and ends the wait`, async (t) => {
    const f = await fixture(t);
    branchUpdate(f);
    assert.equal((await f.run("merge.run")).waiting, true);
    f.setFacts({ state });
    f.append(state === "merged" ? "pull-request.merged" : "pull-request.closed", {
      number: 7,
      ticket: "SEED-1",
      head: updatedHead,
      state,
      ci: "pending",
      conflicting: false,
    });
    const result = await f.run("merge.run", 7, "terminal");
    assert.equal(result.waiting, undefined);
    assert.match(result.reason ?? "", new RegExp(state));
    assert.match(result.next ?? "", /fleet.status/);
    assert.equal(followUps(f).length, 0);
    assert.equal(f.counts().mergeCalls, 0);
  });
}

test("a replacement generation with a fresh same-head hand-back supersedes the predecessor's update wait", async (t) => {
  const f = await fixture(t);
  const updates = branchUpdate(f);
  assert.equal((await f.run("merge.run")).waiting, true);
  f.append("session.claimed", {
    ticket: "SEED-1",
    session: "two",
    generation: 2,
    owner: "Mira",
    runtime: "claude",
    handle: "two",
  });
  f.append("session.reported", {
    ticket: "SEED-1",
    session: "two",
    phase: "ready-to-merge",
    reason: "Verified replacement",
  });
  f.handBack(`Agent status: ready-to-merge — PR #7, head ${updatedHead}`);
  f.append("pull-request.seen", {
    number: 7,
    ticket: "SEED-1",
    head: updatedHead,
    state: "open",
    ci: "success",
    conflicting: false,
  });
  f.setFacts({ checks: [{ name: "verify", state: "success" }], mergeState: "CLEAN" });
  const result = await f.run("merge.run", 7, "replacement");
  assert.equal(result.merged, true, JSON.stringify(result));
  assert.equal(updates(), 1);
  assert.deepEqual(fold(f.store.readSince(0)).projects.orchard?.inbox, []);
});

test("branch update checks holds again immediately before its forge write", async (t) => {
  const f = await fixture(t);
  const updates = branchUpdate(f);
  const update = f.forge.updateBranch;
  assert.ok(update);
  f.forge.updateBranch = async (request) => {
    f.append("hold.opened", { id: "pause-update", reason: "Deployment failed" });
    return update(request);
  };
  const result = await f.run("merge.run");
  assert.equal(result.code, "hold_open");
  assert.match(result.reason ?? "", /pause-update/);
  assert.equal(updates(), 0);
  assert.equal(f.counts().mergeCalls, 0);
});

test("two PR update waits on one ticket retain separate identities and close independently", async (t) => {
  const f = await fixture(t);
  branchUpdate(f);
  assert.equal((await f.run("merge.run")).waiting, true);
  const inspect = f.forge.inspect;
  assert.ok(inspect);
  let second = { ...pull(), number: 8, behindBy: 1 };
  f.forge.inspect = async (request) => (request.number === 8 ? structuredClone(second) : inspect(request));
  f.forge.updateBranch = async (request) => {
    request.beforeWrite?.();
    assert.equal(request.number, 8);
    second = {
      ...second,
      head: "e".repeat(40),
      headParents: [head, base],
      behindBy: 0,
      checks: [{ name: "verify", state: "pending" }],
    };
    return { updated: true };
  };
  f.append("pull-request.seen", {
    number: 8,
    ticket: "SEED-1",
    head,
    state: "open",
    ci: "success",
    conflicting: false,
  });
  f.handBack(`Agent status: ready-to-merge — PR #8, head ${head}`);
  assert.equal((await f.run("merge.run", 8, "second-pr")).waiting, true);
  assert.deepEqual(
    followUps(f)
      .map((i) => i.followUp?.pr)
      .sort(),
    [7, 8],
  );
  f.append("pull-request.closed", {
    number: 7,
    ticket: "SEED-1",
    head: updatedHead,
    state: "closed",
    ci: "pending",
    conflicting: false,
  });
  assert.deepEqual(
    followUps(f).map((i) => i.followUp?.pr),
    [8],
  );
});

test("a replacement waits for its predecessor's delayed update instead of repeating the same-head write", async (t) => {
  const f = await fixture(t);
  let updates = 0;
  f.setFacts({ behindBy: 1 });
  f.forge.updateBranch = async (request) => {
    request.beforeWrite?.();
    updates++;
    return { updated: true };
  };
  assert.equal((await f.run("merge.run")).waiting, true);
  f.append("session.claimed", {
    ticket: "SEED-1",
    session: "two",
    generation: 2,
    owner: "Mira",
    runtime: "claude",
    handle: "two",
  });
  f.append("session.reported", {
    ticket: "SEED-1",
    session: "two",
    phase: "ready-to-merge",
    reason: "Replacement ready",
  });
  f.handBack();
  f.restart();
  assert.equal((await f.run("merge.run", 7, "replacement-waits")).waiting, true);
  assert.equal(updates, 1);
  f.setFacts({ head: updatedHead, headParents: [head, base], behindBy: 0 });
  f.append("pull-request.seen", {
    number: 7,
    ticket: "SEED-1",
    head: updatedHead,
    state: "open",
    ci: "success",
    conflicting: false,
  });
  f.handBack(`Agent status: ready-to-merge — PR #7, head ${updatedHead}`);
  assert.equal((await f.run("merge.run", 7, "replacement-after-update")).merged, true);
  assert.equal(updates, 1);
});

for (const settled of [false, true]) {
  test(`a changed target ${settled ? "after a verified update can start a new update" : "during delayed acceptance never repeats the pending write"}`, async (t) => {
    const f = await fixture(t);
    let updates = 0;
    f.setFacts({ behindBy: 1 });
    f.forge.updateBranch = async (request) => {
      request.beforeWrite?.();
      updates++;
      if (settled)
        f.setFacts({
          head: updatedHead,
          headParents: [head, base],
          behindBy: 0,
          checks: [{ name: "verify", state: "pending" }],
        });
      return { updated: true };
    };
    assert.equal((await f.run("merge.run")).waiting, true);
    const current = settled ? updatedHead : head;
    f.setFacts({
      baseRef: "release",
      base: "e".repeat(40),
      behindBy: 1,
      mergeState: "BEHIND",
      checks: [{ name: "verify", state: "success" }],
    });
    f.append("pull-request.seen", {
      number: 7,
      ticket: "SEED-1",
      head: current,
      state: "open",
      ci: "success",
      conflicting: false,
    });
    f.handBack(`Agent status: ready-to-merge — PR #7, head ${current}`);
    const result = await f.run("merge.run", 7, "changed-target");
    assert.equal(result.code, "head_moved");
    assert.equal(updates, 1);
    if (!settled) {
      assert.match(result.next ?? "", /move the branch head/);
      assert.equal((await f.run("merge.run", 7, "still-unconfirmed")).code, "head_moved");
      assert.equal(updates, 1);
    } else {
      f.forge.updateBranch = async (request) => {
        request.beforeWrite?.();
        updates++;
        assert.equal(request.expectedHead, current);
        f.setFacts({
          head: "f".repeat(40),
          headParents: [current, "e".repeat(40)],
          behindBy: 0,
          checks: [{ name: "verify", state: "pending" }],
        });
        return { updated: true };
      };
      assert.equal((await f.run("merge.run", 7, "new-target")).waiting, true);
      assert.equal(updates, 2);
    }
    assert.equal(f.counts().mergeCalls, 0);
  });
}

/** THE-2225: a confirmed merge whose worker is no longer attached finishes its bookkeeping and never locks the queue. */
function secondHandBack(f: Awaited<ReturnType<typeof fixture>>, other: ForgeInspection) {
  f.append("ticket.seen", { id: "SEED-2", title: "Prune", status: "started" });
  f.append("session.claimed", {
    ticket: "SEED-2",
    session: "two",
    generation: 1,
    owner: "Mira",
    runtime: "claude",
    handle: "two",
  });
  f.append("session.reported", { ticket: "SEED-2", session: "two", phase: "ready-to-merge", reason: "Green" });
  f.append("pull-request.seen", {
    number: other.number,
    ticket: "SEED-2",
    head: other.head,
    state: "open",
    ci: "success",
    conflicting: false,
  });
  f.append("inbox.opened", {
    id: "back-two",
    ticket: "SEED-2",
    kind: "hand-back",
    body: `Agent status: ready-to-merge — PR #${other.number}, head ${other.head}`,
  });
  const facts = new Map<number, ForgeInspection>([[other.number, other]]);
  const inspect = f.forge.inspect;
  const merge = f.forge.merge;
  f.forge.inspect = async (request) =>
    structuredClone(facts.get(request.number) ?? ((await inspect?.(request)) as ForgeInspection));
  f.forge.merge = async (request) => {
    const current = facts.get(request.number);
    if (!current) return merge(request);
    request.beforeWrite?.();
    assert.equal(request.head, current.head);
    facts.set(request.number, { ...current, state: "merged", mergeCommit: "f".repeat(40) });
    return { merged: true, mergeCommit: "f".repeat(40) };
  };
  f.tracker.write = async (request) => {
    request.beforeWrite?.();
    f.writes.push(request);
  };
}
type Stop = NonNullable<ConstructorParameters<typeof Merges>[0]["stop"]>;
const useStop = (f: Awaited<ReturnType<typeof fixture>>, stop: Stop) => Object.assign(f.options, { stop });
const notAttached = () =>
  Object.assign(new Error("This worker is not attached here; inspect its session and relaunch it here if needed"), {
    code: "worker_outside_daemon",
  });
const inboxIds = (f: Awaited<ReturnType<typeof fixture>>) =>
  fold(f.store.readSince(0))
    .projects.orchard?.inbox.filter((i) => i.kind === "hand-back")
    .map((i) => i.id)
    .sort();

test("a confirmed merge with its worker gone never locks the queue and finishes without a stop claim", async (t) => {
  const f = await fixture(t);
  const other: ForgeInspection = {
    ...pull(),
    number: 8,
    head: "d".repeat(40),
    url: "https://github.com/example/orchard/pull/8",
  };
  secondHandBack(f, other);
  const stops: string[] = [];
  useStop(f, async (_scope, session) => {
    stops.push(session.session);
    if (session.session === "one") throw new Error("Supervisor crashed");
    return { ok: true, stopped: true, disposed: true };
  });
  // An unconfirmed forge write is the one thing that locks the queue.
  const merge = f.forge.merge;
  let writesOf7 = 0;
  f.forge.merge = async (request) => {
    request.beforeWrite?.();
    writesOf7++;
    throw new Error("Connection lost");
  };
  assert.equal((await f.run("merge.run")).code, "merge_unconfirmed");
  assert.equal((await f.run("merge.check", 8, "check-8")).code, "merge_pending");
  // GitHub confirms the pinned head, the tracker is written, then the worker's stop fails for another reason.
  f.forge.merge = async (request) => {
    if (request.number === 7) writesOf7++;
    return merge(request);
  };
  f.setFacts({ state: "merged", mergeCommit: "c".repeat(40) });
  const refusals = () => f.store.readSince(0).filter((e) => e.kind === "merge.refused").length;
  const refusedBefore = refusals();
  const failed = await f.run("merge.run", 7, "recover");
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? "", /Supervisor crashed/);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "merge.confirmed").length, 1);
  assert.equal(f.writes.filter((w) => w.ticket === "SEED-1").length, 1);
  assert.equal(refusals(), refusedBefore, "a cleanup failure is not a refusal of the confirmed merge");
  assert.deepEqual(inboxIds(f), ["back", "back-two"], "an uncleaned hand-back stays until its cleanup");
  // Its cleanup is a follow-up, not a lock: the next pull request checks and merges.
  const check = await f.run("merge.check", 8, "check-8-again");
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.followUp, "merge.run for PR #7 to finish its confirmed merge's cleanup");
  const merged = await f.run("merge.run", 8, "merge-8");
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.merged, true);
  assert.deepEqual(stops, ["one", "two"]);
  assert.equal(f.writes.filter((w) => w.ticket === "SEED-2").length, 1);
  assert.deepEqual(inboxIds(f), ["back"]);
  // After a restart the merged generation is not attached: its bookkeeping finishes with no stop claim.
  f.restart();
  useStop(f, async (_scope, session) => {
    stops.push(session.session);
    throw notAttached();
  });
  const finished = await f.run("merge.run", 7, "finish");
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(finished.merged, true);
  assert.deepEqual(finished.cleanup, {
    ok: true,
    stopped: false,
    disposed: false,
    detached: true,
    next: "the worker was not attached here; its worktree, branch and pull request are kept",
  });
  assert.equal(finished.followUp, undefined);
  assert.deepEqual(stops, ["one", "two", "one"]);
  assert.deepEqual(inboxIds(f), []);
  assert.equal(writesOf7, 1, "the forge merge of #7 is never repeated");
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "merge.confirmed").length, 2);
  assert.equal(f.writes.filter((w) => w.ticket === "SEED-1").length, 1, "the tracker write is never repeated");
  assert.equal(
    fold(f.store.readSince(0)).projects.orchard?.sessions.find((s) => s.ticket === "SEED-1")?.phase,
    "merged",
  );
  assert.deepEqual(await f.run("merge.run", 7, "finish"), finished);
  assert.deepEqual(await f.run("merge.run", 7, "merge"), finished, "the original intent has its receipt too");
  assert.equal(
    (await f.run("merge.run", 7, "recover")).ok,
    false,
    "a key without a journal entry rechecks and writes nothing",
  );
  assert.equal(writesOf7, 1);
  assert.notEqual((await f.run("merge.check", 9, "check-9")).code, "merge_pending");
  assert.equal((await f.run("merge.check", 9, "check-9")).followUp, undefined);
});

test("detached cleanup still refuses a replacement generation and a lost worker's release", async (t) => {
  const f = await fixture(t);
  useStop(f, async () => {
    throw new Error("Supervisor crashed");
  });
  assert.equal((await f.run("merge.run")).ok, false);
  assert.equal(f.counts().mergeCalls, 1);
  // A lost worker released without a stop proof keeps the cleanup pending, as before.
  useStop(f, async () => ({ ok: true, stopped: false, released: true }));
  const released = await f.run("merge.run", 7, "released");
  assert.equal(released.code, "cleanup_pending");
  assert.deepEqual(inboxIds(f), ["back"]);
  // A replacement claims the ticket while the stop is refused as detached: the old generation's
  // bookkeeping is never finished over it, even though its guard passed on entry.
  let claimed = 0;
  useStop(f, async () => {
    claimed++;
    f.store.append({
      project: "orchard",
      actor: "worker",
      at: "2030-01-02T00:00:00Z",
      kind: "session.claimed",
      payload: {
        ticket: "SEED-1",
        session: "replacement",
        generation: 2,
        owner: "Mira",
        runtime: "claude",
        handle: "r",
      },
    });
    throw notAttached();
  });
  f.restart();
  assert.equal((await f.run("merge.run", 7, "detached")).code, "worker_changed");
  assert.equal(claimed, 1, "the stop was attempted; the replacement arrived during it");
  assert.deepEqual(inboxIds(f), ["back"]);
  assert.equal(f.counts().mergeCalls, 1);
  // Once the replacement owns the ticket, no later call touches the old generation's bookkeeping either.
  useStop(f, async () => {
    throw notAttached();
  });
  assert.equal((await f.run("merge.run", 7, "detached-again")).code, "worker_changed");
  assert.deepEqual(inboxIds(f), ["back"]);
});
