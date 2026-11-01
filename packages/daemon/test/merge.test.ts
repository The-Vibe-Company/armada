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
import { createLocalNode } from "../../plugins/node-local/src/index.ts";
import { nativeTools } from "../coordinator/native.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
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
async function fixture(t: TestContext, priorHandBack = false) {
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
  append("pull-request.seen", { number: 7, ticket: "SEED-1", head, state: "open", ci: "success", conflicting: false });
  const handBack = (body = `Agent status: ready-to-merge — PR #7, head ${head}`) => {
    append("inbox.answered", { id: "back", answer: "superseded" });
    append("inbox.opened", { id: "back", ticket: "SEED-1", kind: "hand-back", body });
  };
  handBack();
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
      assert.equal(request.head, head);
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
  const run = async (name: "merge.check" | "merge.run", pr = 7, callId = "merge") => {
    const result = await tools[name].execute({ pr }, { taskId: 1, callId } as ToolExecutionApi, context);
    return result.details as {
      ok: boolean;
      code?: string;
      reason?: string;
      next?: string;
      problems?: string[];
      cleanup?: { disposed?: boolean };
    };
  };
  t.after(async () => {
    await scope.close(context);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    scope,
    append,
    handBack,
    run,
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
  assert.match(failed.reason ?? "", /bun run verify.*failed first line/);
  assert.doesNotMatch(JSON.stringify(failed), /private subprocess body/);
  f.node.testMerge = async () => {
    f.setFacts({ base: "d".repeat(40) });
    return { ok: true };
  };
  assert.equal((await f.run("merge.run")).code, "head_moved");
  assert.equal(f.counts().mergeCalls, 0);
});

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
  const recovered = await f.run("merge.run", 7, "recover");
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

test("local node test merge runs ordered gates on pinned commits and removes dirty throwaway on failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-merge-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Merge test");
    git("config", "user.email", "merge@example.test");
    git("config", "commit.gpgsign", "false");
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
    const failure = await node.testMerge?.({ ...request, commands: ["echo dirty > generated; exit 1", "exit 0"] });
    assert.equal(failure?.ok, false);
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
