import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { Comparison, MergePull } from "../src/github.ts";
import {
  type LocalRepo,
  type MergeAttempt,
  type MergeContext,
  type MergeForge,
  mergePullRequest,
  type TestMergeResult,
  withLease,
} from "../src/merge.ts";
import {
  acquireLease,
  addInboxItem,
  type Db,
  getRuntimeHandle,
  openInboxItems,
  renewLease,
  saveRuntimeHandle,
} from "../src/turso.ts";
import { Refusal } from "../src/worker.ts";
import { closeTempTurso, DEMO_TOML, FakeLinear, LABELS, NOW, tempTurso } from "./support.ts";

afterEach(closeTempTurso);

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const SQUASH = "5555555555555555555555555555555555555555";
const GATES = '\n[gates]\nrequired_checks = ["test"]\n';

function pull(over: Partial<MergePull> = {}): MergePull {
  return {
    url: "https://github.com/acme/widgets/pull/9",
    number: 9,
    repo: "acme/widgets",
    title: "feat(lists): share a list by link",
    state: "open",
    draft: false,
    ci: "success",
    checks: [{ name: "test", state: "success" }],
    mergeable: "MERGEABLE",
    headRef: "feature/demo-7-do-the-thing",
    headSha: HEAD,
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    baseRef: "main",
    mergeCommit: null,
    reviewThreads: { total: 0, read: 0, unresolved: 0 },
    ...over,
  };
}

/** GitHub for `armada merge`: one pull request whose state the merge call changes. */
class FakeForge implements MergeForge {
  pr = pull();
  comparison: Comparison | null = { baseSha: BASE, status: "AHEAD", behindBy: 0, aheadBy: 2 };
  diffText = "";
  /** Answers of successive merge calls; `effect` false means GitHub accepted but did not merge. */
  answers: (MergeAttempt & { effect?: boolean })[] = [];
  merges: { number: number; sha: string }[] = [];
  reads = 0;
  /** Called inside merge(), before it answers (to hold a merge open). */
  during: (() => Promise<void>) | null = null;

  async readPull(number: number) {
    this.reads++;
    return number === this.pr.number ? structuredClone(this.pr) : null;
  }
  async compare() {
    return this.comparison;
  }
  async diff() {
    return this.diffText;
  }
  async merge(number: number, sha: string): Promise<MergeAttempt> {
    this.merges.push({ number, sha });
    await this.during?.();
    const a = this.answers.shift() ?? { ok: true, message: "merged", transient: false };
    if (a.effect ?? a.ok) Object.assign(this.pr, { state: "merged", mergeCommit: SQUASH });
    return { ok: a.ok, message: a.message, transient: a.transient };
  }
}

class FakeRepo implements LocalRepo {
  uses = new Map<string, string[]>();
  testResult: TestMergeResult = { ok: true };
  testMerges: { base: string; head: string; commands: string[] }[] = [];
  async grepWords() {
    return this.uses;
  }
  async testMerge(o: { base: string; head: string; commands: string[] }) {
    this.testMerges.push({ base: o.base, head: o.head, commands: o.commands });
    return this.testResult;
  }
}

const label = (id: string) => {
  const l = LABELS.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l;
};

function setup(o: { turso?: Db | null; toml?: string; holder?: string } = {}) {
  const config = parseConfig(`${DEMO_TOML}${o.toml ?? GATES}`);
  const linear = new FakeLinear();
  const forge = new FakeForge();
  const repo = new FakeRepo();
  const sleeps: number[] = [];
  const progress: string[] = [];
  linear.add("DEMO-7", {
    statusType: "started",
    stateId: "st-progress",
    labels: [label("phase-ready-to-merge"), label("rt-conductor")],
  });
  linear.post(
    "DEMO-7",
    "Agent status: planning — claimed by Conductor (ws-1/s-1)\n\nAgent claim — runtime: Conductor · session: ws-1/s-1 · branch: feature/demo-7-do-the-thing · started: 2026-03-04T08:00:00Z",
    "2026-03-04T08:00:00Z",
  );
  linear.post("DEMO-7", `Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green`, "2026-03-04T09:00:00Z");
  const ctx: MergeContext = {
    config,
    linear,
    forge,
    repo,
    turso: async () => (o.turso ? { db: o.turso, warning: null } : { db: null, warning: "Turso is not configured" }),
    inFlight: async () => [
      { id: "DEMO-7", title: "Share a list", phase: "ready-to-merge", runtime: "Conductor" },
      { id: "DEMO-8", title: "Rename a list", phase: "implementing", runtime: "Claude Code" },
    ],
    holder: o.holder ?? "coordinator-a",
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    progress: (line) => progress.push(line),
  };
  return { ctx, linear, forge, repo, sleeps, progress };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => {
      if (!(err instanceof Refusal)) throw err;
      return err.message;
    },
  );

describe("the checklist refuses, naming the rule", () => {
  type S = ReturnType<typeof setup>;
  const cases: [string, (s: S) => void, string][] = [
    [
      "no hand-back: the ticket is not ready-to-merge",
      (s) => {
        s.linear.get("DEMO-7").labels = [label("phase-shipping")];
      },
      "DEMO-7 has not been handed back: its agent phase is shipping, not ready-to-merge",
    ],
    [
      "no hand-back comment",
      (s) => {
        s.linear.get("DEMO-7").comments = s.linear
          .get("DEMO-7")
          .comments.filter((c) => !c.status?.summary.includes("head"));
      },
      'DEMO-7 has no "Agent status: ready-to-merge" comment carrying the head SHA',
    ],
    [
      "the hand-back names another pull request",
      (s) => {
        s.linear.post("DEMO-7", `Agent status: ready-to-merge — PR #8, head ${HEAD}, CI green`, "2026-03-04T09:30:00Z");
      },
      "the hand-back on DEMO-7 names PR #8, not #9",
    ],
    [
      "an abbreviated SHA",
      (s) => {
        s.linear.post("DEMO-7", "Agent status: ready-to-merge — PR #9, head 0123456, CI green", "2026-03-04T09:30:00Z");
      },
      "the handed-back SHA 0123456 is not a full 40-character SHA",
    ],
    [
      "the head moved after the hand-back",
      (s) => {
        s.forge.pr.headSha = BASE;
      },
      `the head of #9 is ${BASE}, not the handed-back ${HEAD}: it moved after the hand-back`,
    ],
    ["a closed pull request", (s) => Object.assign(s.forge.pr, { state: "closed" }), "#9 is closed, not open"],
    ["a draft", (s) => Object.assign(s.forge.pr, { draft: true }), "#9 is a draft"],
    [
      "a title outside Commitizen",
      (s) => Object.assign(s.forge.pr, { title: "Share lists" }),
      'the title "Share lists" is not in Commitizen format',
    ],
    [
      "a merge state other than CLEAN",
      (s) => Object.assign(s.forge.pr, { mergeStateStatus: "BLOCKED" }),
      "GitHub reports #9 as BLOCKED, not CLEAN: a branch protection rule blocks it",
    ],
    [
      "a required check that is not green on the head",
      (s) => Object.assign(s.forge.pr, { checks: [{ name: "test", state: "pending" }] }),
      'on head 0123456: required check "test" is pending',
    ],
    [
      "an unresolved review thread",
      (s) => Object.assign(s.forge.pr, { reviewThreads: { total: 3, read: 3, unresolved: 1 } }),
      "#9 has 1 unresolved review thread",
    ],
    [
      "a head that lacks commits of the base, with no local commands to test the merge",
      (s) => {
        s.forge.comparison = { baseSha: BASE, status: "DIVERGED", behindBy: 2, aheadBy: 1 };
      },
      "the head lacks 2 commits of main; ask the worker to rebase, or declare [gates] local_commands",
    ],
  ];
  for (const [name, arrange, problem] of cases)
    test(name, async () => {
      const s = setup();
      arrange(s);
      const message = await refusal(mergePullRequest(s.ctx, { pr: 9 }));
      expect(message).toContain("#9 (DEMO-7) cannot be merged:");
      expect(message).toContain(problem);
      expect(s.forge.merges).toEqual([]);
      expect(s.linear.writes).toEqual([]);
    });

  test("a head behind its base is test-merged with the local commands; a failure names the command", async () => {
    const s = setup({ toml: `${GATES}local_commands = ["bun install", "bun run verify"]\n` });
    s.forge.comparison = { baseSha: BASE, status: "DIVERGED", behindBy: 2, aheadBy: 1 };
    s.repo.testResult = { ok: false, step: "bun run verify", output: "1 fail" };
    const message = await refusal(mergePullRequest(s.ctx, { pr: 9 }));
    expect(message).toContain("the test merge into main failed at `bun run verify`:\n      1 fail");
    expect(s.repo.testMerges).toEqual([{ base: BASE, head: HEAD, commands: ["bun install", "bun run verify"] }]);

    s.repo.testResult = { ok: true };
    const out = await mergePullRequest(s.ctx, { pr: 9, dryRun: true });
    expect(out.lines).toContain("Head lacks 2 commit(s) of main; the test merge passed every local command.");
  });
});

describe("armada merge", () => {
  test("a dry run checks everything, reports hints and writes nothing", async () => {
    const s = setup();
    s.forge.diffText = [
      "diff --git a/src/lists.ts b/src/lists.ts",
      "--- a/src/lists.ts",
      "+++ b/src/lists.ts",
      "-export function shareList(id: string) {",
      "+export function shareListByLink(id: string) {",
      "-export const MAX_ITEMS = 10;",
      "+export const MAX_ITEMS = 20;",
    ].join("\n");
    s.repo.uses = new Map([
      ["shareList", ["src/lists.ts", "src/menu.ts"]],
      ["MAX_ITEMS", ["src/lists.ts", "src/menu.ts"]],
    ]);
    const out = await mergePullRequest(s.ctx, { pr: 9, dryRun: true });
    expect(out.merged).toBe(false);
    expect(out.hints).toEqual(["`shareList`, removed from src/lists.ts, still appears on main in src/menu.ts"]);
    expect(out.lines.at(-1)).toBe("Dry run: nothing was merged.");
    expect([s.forge.merges, s.linear.writes]).toEqual([[], []]);
  });

  test("merges pinned to the handed-back SHA, closes the ticket and lists who to tell", async () => {
    const { db } = await tempTurso();
    const s = setup({ turso: db });
    await saveRuntimeHandle(db, {
      project: "widgets",
      ticket: "DEMO-7",
      runtime: "Conductor",
      handle: "ws-1/s-1",
      branch: null,
      at: NOW,
    });
    await saveRuntimeHandle(db, {
      project: "widgets",
      ticket: "DEMO-8",
      runtime: "Claude Code",
      handle: "ws-2",
      branch: null,
      at: NOW,
    });
    await addInboxItem(db, {
      project: "widgets",
      ticket: "DEMO-7",
      kind: "hand-back",
      recipient: "coordinator",
      author: null,
      body: "hand-back",
      at: NOW,
    });

    const out = await mergePullRequest(s.ctx, { pr: 9 });

    expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
    const t = s.linear.get("DEMO-7");
    expect([t.statusType, t.labels]).toEqual(["completed", []]);
    expect(t.prs.map((p) => p.url)).toEqual(["https://github.com/acme/widgets/pull/9"]);
    expect(t.comments[0]?.status).toEqual({
      phase: "merged",
      summary: `PR #9 squash-merged into main as ${SQUASH}, head ${HEAD}`,
    });
    expect(out.workers).toEqual([
      { ticket: "DEMO-8", title: "Rename a list", phase: "implementing", runtime: "Claude Code", handle: "ws-2" },
    ]);
    expect(out.archive).toEqual({ runtime: "Conductor", handle: "ws-1/s-1", guide: "armada-runtime-conductor" });
    expect(out.warnings).toEqual([]);
    expect(await openInboxItems(db, { project: "widgets", recipient: "coordinator" })).toEqual([]);
    expect((await getRuntimeHandle(db, "widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    const events = await db.execute("SELECT kind, head_sha FROM events WHERE ticket = 'DEMO-7'");
    expect(events.rows.map((r) => [r.kind, r.head_sha])).toEqual([["merge", HEAD]]);
  });

  test("a GitHub 5xx is retried only after re-reading an unchanged open pull request", async () => {
    const s = setup();
    s.forge.answers = [{ ok: false, message: "HTTP 502: Bad Gateway", transient: true }];
    const out = await mergePullRequest(s.ctx, { pr: 9 });
    expect(out.merged).toBe(true);
    expect(s.forge.merges).toHaveLength(2);
    expect(s.sleeps).toEqual([2000]);
  });

  test("a 5xx after which the head moved stops without retrying or touching the ticket", async () => {
    const s = setup();
    s.forge.answers = [{ ok: false, message: "HTTP 503", transient: true }];
    s.forge.during = async () => {
      s.forge.pr.headSha = BASE;
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      `GitHub failed (HTTP 503) and the head of #9 moved to ${BASE}; not retrying`,
    );
    expect([s.forge.merges.length, s.linear.writes]).toEqual([1, []]);
  });

  test("success is only reported once GitHub shows the pull request as merged", async () => {
    const s = setup();
    // gh exits 0 but nothing merges (e.g. auto-merge was enabled instead).
    s.forge.answers = [{ ok: true, message: "will be automatically merged", transient: false, effect: false }];
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      "the merge of #9 was accepted but GitHub shows it as open, not merged (auto-merge or a merge queue?); the ticket was left as is",
    );
    expect(s.linear.writes).toEqual([]);
  });

  test("two coordinators merging at once merge one after the other", async () => {
    const { db } = await tempTurso();
    const a = setup({ turso: db, holder: "coordinator-a" });
    const b = setup({ turso: db, holder: "coordinator-b" });
    b.forge.pr = pull({ number: 10, url: "https://github.com/acme/widgets/pull/10" });
    b.linear.post("DEMO-7", `Agent status: ready-to-merge — PR #10, head ${HEAD}, CI green`, "2026-03-04T09:30:00Z");
    const timeline: string[] = [];
    // Whoever takes the lock first holds its merge open until the other has waited for the lock.
    let otherWaited = () => {};
    const waited = new Promise<void>((r) => {
      otherWaited = r;
    });
    for (const [name, s] of [
      ["a", a],
      ["b", b],
    ] as const) {
      s.forge.during = async () => {
        timeline.push(`${name} merging`);
        await waited;
        timeline.push(`${name} done`);
      };
      s.ctx.sleep = async () => {
        timeline.push(`${name} waits`);
        otherWaited();
        await new Promise((r) => setTimeout(r, 0));
      };
    }
    const results = await Promise.all([mergePullRequest(a.ctx, { pr: 9 }), mergePullRequest(b.ctx, { pr: 10 })]);
    expect(results.map((r) => r.merged)).toEqual([true, true]);
    const merging = timeline.filter((e) => !e.endsWith("waits"));
    const [first, second] = [merging[0]?.[0], merging[2]?.[0]];
    expect(merging).toEqual([`${first} merging`, `${first} done`, `${second} merging`, `${second} done`]);
    expect(first).not.toBe(second);
    expect(timeline).toContain(`${second} waits`);
  });
});

describe("merge lease", () => {
  test("an expired lease is taken over and its old holder can no longer renew it", async () => {
    const { db } = await tempTurso();
    const key = { project: "widgets", name: "merge", ttlMs: 60_000 };
    expect(await acquireLease(db, { ...key, holder: "a", at: NOW })).toEqual({ acquired: true });
    const later = new Date(NOW.getTime() + 30_000);
    expect(await acquireLease(db, { ...key, holder: "b", at: later })).toMatchObject({
      acquired: false,
      held: { holder: "a" },
    });
    const expired = new Date(NOW.getTime() + 61_000);
    expect(await acquireLease(db, { ...key, holder: "b", at: expired })).toEqual({ acquired: true });
    expect(await renewLease(db, { ...key, holder: "a", at: expired })).toBe(false);
  });

  test("a waiter gives up after the wait limit, naming the holder", async () => {
    const { db } = await tempTurso();
    await acquireLease(db, { project: "widgets", name: "merge", holder: "a", ttlMs: 60_000, at: NOW });
    const o = { project: "widgets", name: "merge", holder: "b", ttlMs: 60_000, now: () => NOW };
    const message = await refusal(
      withLease(db, { ...o, sleep: async () => {}, pollMs: 10, maxWaitMs: 30 }, async () => "ran"),
    );
    expect(message).toBe(
      "the merge lock of widgets is still held by a (until 2026-03-04T10:01:00.000Z); try again later",
    );
  });
});
