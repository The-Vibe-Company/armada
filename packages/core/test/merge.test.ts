import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { parseConfig } from "../src/config.ts";
import type { Comparison, MergePull } from "../src/github.ts";
import type { Fleet } from "../src/live.ts";
import {
  type LocalRepo,
  type MergeAttempt,
  type MergeContext,
  type MergeForge,
  mergePullRequest,
  type TestMergeResult,
  withLease,
} from "../src/merge.ts";
import { Refusal } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, LABELS, NOW, tempFleet } from "./support.ts";

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
  /** Called on every comparison (to change GitHub while the checklist runs). */
  onCompare: (() => Promise<void>) | null = null;
  async compare() {
    await this.onCompare?.();
    return structuredClone(this.comparison);
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

function setup(o: { live?: ReturnType<typeof tempFleet> | null; toml?: string; holder?: string; down?: boolean } = {}) {
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
    fleet: async () =>
      o.live
        ? { fleet: o.live.fleet, warning: null }
        : { fleet: null, warning: o.down ? "Armada unreachable (connection refused)" : "not signed in to Armada" },
    lockRequired: !!o.live || !!o.down,
    inFlight: async () => [
      { id: "DEMO-7", title: "Share a list", phase: "ready-to-merge", runtime: "Conductor" },
      { id: "DEMO-8", title: "Rename a list", phase: "implementing", runtime: "Claude Code" },
    ],
    holder: o.holder ?? "coordinator-a",
    installedSkill: async (name) => name === "armada-runtime-conductor",
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
      return `${err.message}\nNext: ${err.next}`;
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
    const live = tempFleet();
    const db = live.store;
    const s = setup({ live });
    await db.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-7",
      runtime: "Conductor",
      handle: "ws-1/s-1",
      branch: null,
      at: NOW,
    });
    await db.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-8",
      runtime: "Claude Code",
      handle: "ws-2",
      branch: null,
      at: NOW,
    });
    await db.addInboxItem({
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
    expect(await db.openInboxItems({ project: "widgets", recipient: "coordinator" })).toEqual([]);
    expect((await db.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    expect(db.events.filter((e) => e.ticket === "DEMO-7").map((e) => [e.kind, e.headSha])).toEqual([["merge", HEAD]]);
  });

  test("a GitHub 5xx is retried only after re-reading an unchanged open pull request", async () => {
    const s = setup();
    s.forge.answers = [{ ok: false, message: "HTTP 502: Bad Gateway", transient: true }];
    const out = await mergePullRequest(s.ctx, { pr: 9 });
    expect(out.merged).toBe(true);
    expect(s.forge.merges).toHaveLength(2);
    expect(s.sleeps).toEqual([2000]);
  });

  test.each(["ready-for-agent", "dispatchable"])(
    "merge removes the configured ready label %s only",
    async (readyLabel) => {
      const state = setup();
      state.ctx.config.tracker.readyLabel = readyLabel;
      const ready = { id: "configured-ready", name: readyLabel, group: null };
      const unrelated = { id: "category", name: "Feature", group: null };
      const otherReady = {
        id: "other-ready",
        name: readyLabel === "dispatchable" ? "ready-for-agent" : "dispatchable",
        group: null,
      };
      state.linear.get("DEMO-7").labels.push(ready, unrelated, otherReady);

      await mergePullRequest(state.ctx, { pr: 9, dryRun: true });
      expect(state.linear.get("DEMO-7").labels).toContainEqual(ready);
      expect(state.linear.writes).toEqual([]);

      await mergePullRequest(state.ctx, { pr: 9 });
      expect(state.linear.get("DEMO-7").labels).toEqual([unrelated, otherReady]);
    },
  );

  test("a 5xx after which the head moved stops without retrying or touching the ticket", async () => {
    const s = setup();
    s.forge.answers = [{ ok: false, message: "HTTP 503", transient: true }];
    s.forge.during = async () => {
      s.forge.pr.headSha = BASE;
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      `GitHub failed (HTTP 503) and the head of #9 moved to ${BASE}; not retrying\nNext: armada merge 9 --dry-run, once its worker hands back the new head`,
    );
    expect([s.forge.merges.length, s.linear.writes]).toEqual([1, []]);
  });

  test("success is only reported once GitHub shows the pull request as merged", async () => {
    const s = setup();
    // gh exits 0 but nothing merges (e.g. auto-merge was enabled instead).
    s.forge.answers = [{ ok: true, message: "will be automatically merged", transient: false, effect: false }];
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      "the merge of #9 was accepted but GitHub shows it as open, not merged (auto-merge or a merge queue?); the ticket was left as is\nNext: gh pr view 9 --repo acme/widgets",
    );
    expect(s.linear.writes).toEqual([]);
  });

  test("a pull request whose base moves while it is checked is not merged", async () => {
    const s = setup();
    s.forge.onCompare = async () => {
      s.forge.onCompare = async () => {
        s.forge.comparison = { baseSha: SQUASH, status: "AHEAD", behindBy: 0, aheadBy: 2 };
      };
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      `#9 changed while it was checked; nothing was merged:\n  - main moved to ${SQUASH} while #9 was checked\nNext: armada merge 9 again`,
    );
    expect([s.forge.merges, s.linear.writes]).toEqual([[], []]);
  });

  test("a merge lock lost during the checklist stops before merging", async () => {
    const live = tempFleet();
    const db = live.store;
    const s = setup({ live });
    s.forge.onCompare = async () => {
      for (const l of db.leases.values()) l.holder = "coordinator-b";
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      "the merge lock could not be renewed (it expired and another coordinator took it, or Armada did not answer); nothing was merged\nNext: armada merge 9 again",
    );
    expect(s.forge.merges).toEqual([]);
  });

  test("a pull request merged at another head is reported, and the ticket left open", async () => {
    const s = setup();
    s.forge.during = async () => {
      s.forge.pr.headSha = BASE;
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      `#9 was merged at ${BASE}, not at the handed-back ${HEAD}; check main now\nNext: gh pr view 9 --repo acme/widgets`,
    );
    expect(s.linear.writes).toEqual([]);
  });

  test("when GitHub cannot be read back after the merge, the output says it may have landed", async () => {
    const s = setup();
    s.forge.during = async () => {
      s.forge.readPull = async () => {
        throw new Error("GitHub API HTTP 502");
      };
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      "the merge of #9 was accepted but GitHub could not be read back (GitHub API HTTP 502); if it merged, close DEMO-7 by hand\nNext: gh pr view 9 --repo acme/widgets",
    );
    expect(s.linear.writes).toEqual([]);
  });

  test("signed in but Armada down refuses the merge; --no-lock merges and says so on the ticket", async () => {
    const s = setup({ down: true });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      "the merge lock needs Armada, which is unavailable (Armada unreachable (connection refused)); nothing was merged\nNext: armada merge 9 again once Armada answers, or armada merge 9 --no-lock if you are sure no other coordinator merges in widgets now",
    );
    expect([s.forge.merges, s.linear.writes]).toEqual([[], []]);

    const out = await mergePullRequest(s.ctx, { pr: 9, noLock: true });
    expect(out.merged).toBe(true);
    expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toEndWith(", merged without lock (--no-lock)");
    expect(out.warnings[0]).toBe(
      "merged without the merge lock (--no-lock): make sure no other coordinator merges in widgets now",
    );
  });

  test("not signed in to Armada, the merge runs unlocked with a warning", async () => {
    const s = setup();
    const out = await mergePullRequest(s.ctx, { pr: 9 });
    expect(out.merged).toBe(true);
    expect(out.warnings[0]).toBe(
      "not signed in to Armada; the merge lock was not taken, so make sure no other coordinator merges in widgets now",
    );
  });

  test("two coordinators merging at once merge one after the other", async () => {
    // Two terminals, one Armada: each takes the lock through the API.
    const one = tempFleet();
    const a = setup({ live: one, holder: "coordinator-a" });
    const b = setup({ live: tempFleet({ store: one.store, clock: one.clock }), holder: "coordinator-b" });
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
    const a = tempFleet();
    const b = tempFleet({ store: a.store, clock: a.clock });
    const key = { name: "merge", ttlMs: 60_000 };
    expect(await a.fleet.acquireLease({ ...key, holder: "a" })).toEqual({ acquired: true });
    a.clock.advance(30_000);
    expect(await b.fleet.acquireLease({ ...key, holder: "b" })).toMatchObject({
      acquired: false,
      held: { holder: "a", expiresAt: "2026-03-04T10:01:00.000Z" },
    });
    a.clock.advance(31_000);
    expect(await b.fleet.acquireLease({ ...key, holder: "b" })).toEqual({ acquired: true });
    expect(await a.fleet.renewLease({ ...key, holder: "a" })).toBe(false);
  });

  test("Armada refuses a lease longer than an hour", async () => {
    const { fleet } = tempFleet();
    const err = await fleet.acquireLease({ name: "merge", holder: "a", ttlMs: 2 * 3_600_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ArmadaApiError);
    expect([err.status, err.message]).toEqual([
      400,
      "Armada refused: fleet lease/acquire: ttlMs must be between 1 s and 60 min",
    ]);
  });

  test("a waiter gives up after the wait limit, naming the holder", async () => {
    const { fleet } = tempFleet();
    await fleet.acquireLease({ name: "merge", holder: "a", ttlMs: 60_000 });
    const o = { project: "widgets", name: "merge", holder: "b", ttlMs: 60_000 };
    const message = await refusal(
      withLease(fleet, { ...o, sleep: async () => {}, pollMs: 10, maxWaitMs: 30 }, async () => "ran"),
    );
    expect(message).toBe(
      "the merge lock of widgets is still held by a (until 2026-03-04T10:01:00.000Z)\nNext: the same armada merge again once that coordinator is done",
    );
  });

  test("an Armada that never answers refuses the lock instead of hanging", async () => {
    const hung = {
      acquireLease: () => new Promise(() => {}),
      releaseLease: () => new Promise(() => {}),
    } as unknown as Fleet;
    const o = { project: "widgets", name: "merge", holder: "a", ttlMs: 60_000, timeoutMs: 0 };
    let ran = false;
    const message = await refusal(
      withLease(hung, { ...o, sleep: async () => {} }, async () => {
        ran = true;
      }),
    );
    expect([message, ran]).toEqual([
      "Armada did not answer within 0 s to take the merge lock; nothing was merged\nNext: the same armada merge again, or with --no-lock if you are sure no other coordinator merges now",
      false,
    ]);
  });
});
