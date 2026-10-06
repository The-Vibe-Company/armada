import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { parseConfig } from "../src/config.ts";
import type { CommitShape, Comparison, MergePull } from "../src/github.ts";
import { LinearError } from "../src/linear.ts";
import { createLinearWriter } from "../src/linear-write.ts";
import type { Fleet } from "../src/live.ts";
import {
  askOwnerToMerge,
  finishMerge,
  type LocalRepo,
  MERGE_LEASE_TTL_MS,
  type MergeAttempt,
  type MergeContext,
  type MergeForge,
  mergePullRequest,
  prepareQueueEntry,
  type TestMergeResult,
  withLease,
} from "../src/merge.ts";
import { requestDecision } from "../src/requests.ts";
import { Refusal } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, LABELS, NOW, tempFleet } from "./support.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const SQUASH = "5555555555555555555555555555555555555555";
const GATES = '\n[gates]\nrequired_checks = ["test"]\n';
/** The head after GitHub's "update branch": HEAD with BASE merged in. */
const UPDATED = "abababababababababababababababababababab";
const TREE = "7777777777777777777777777777777777777777";

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
    updatedAt: "2026-03-04T09:00:00Z",
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
  comments: { number: number; body: string }[] = [];
  async comment(number: number, body: string) {
    this.comments.push({ number, body });
  }
  /** Called inside merge(), before it answers (to hold a merge open). */
  during: (() => Promise<void>) | null = null;

  async readPull(number: number) {
    this.reads++;
    return number === this.pr.number ? structuredClone(this.pr) : null;
  }
  /** Called on every comparison (to change GitHub while the checklist runs). */
  onCompare: (() => Promise<void>) | null = null;
  async compare(_base: string, head: string) {
    await this.onCompare?.();
    if (this.onBase.has(head)) return { baseSha: BASE, status: "BEHIND" as const, behindBy: 0, aheadBy: 0 };
    return structuredClone(this.comparison);
  }
  async diff() {
    return this.diffText;
  }
  /** The preview deployment of a head; none by default. */
  preview?: (sha: string) => Promise<string | null>;
  /** Commits GitHub knows, by SHA. */
  commits = new Map<string, CommitShape>();
  /** Commits on the base branch: compared with it, they are BEHIND. */
  onBase = new Set([BASE]);
  updates: { number: number; sha: string }[] = [];
  /** Answers of successive update-branch calls; by default GitHub accepts and makes UPDATED. */
  updateAnswers: (MergeAttempt & { effect?: boolean })[] = [];
  async commit(sha: string) {
    return structuredClone(this.commits.get(sha) ?? null);
  }
  async updateBranch(number: number, sha: string): Promise<MergeAttempt> {
    this.updates.push({ number, sha });
    const a: MergeAttempt & { effect?: boolean } = this.updateAnswers.shift() ?? {
      ok: true,
      message: "Updating pull request branch.",
      transient: false,
    };
    if (a.effect ?? a.ok) {
      this.commits.set(UPDATED, { sha: UPDATED, tree: TREE, parents: [sha, BASE] });
      Object.assign(this.pr, {
        headSha: UPDATED,
        mergeStateStatus: "BLOCKED",
        checks: [{ name: "test", state: "pending" }],
      });
      this.comparison = { baseSha: BASE, status: "AHEAD", behindBy: 0, aheadBy: 3 };
    }
    return a;
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
  /** Trees of clean merges, by `ours:theirs`; a pair not listed conflicts. */
  trees = new Map([[`${HEAD}:${BASE}`, TREE]]);
  async mergeTree(o: { ours: string; theirs: string }) {
    return this.trees.get(`${o.ours}:${o.theirs}`) ?? null;
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
    afterRead: async () => ({
      inFlight: [
        { id: "DEMO-7", title: "Share a list", phase: "ready-to-merge", runtime: "Conductor" },
        { id: "DEMO-8", title: "Rename a list", phase: "implementing", runtime: "Claude Code" },
      ],
      unblocked: null,
    }),
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
      "the head lacks 2 commits of main; ask the worker to bring main in, or declare [gates] local_commands",
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
    s.ctx.afterRead = async () => {
      throw new Error("a dry run must not read after closing");
    };
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
    expect(out.unblocked).toBeNull();
  });

  test("a failed post-close read warns without turning a confirmed merge into a failure", async () => {
    const s = setup();
    s.ctx.afterRead = async (ticket) => {
      expect(ticket).toBe("DEMO-7");
      expect(s.linear.get(ticket as string).statusType).toBe("completed");
      throw new Error("Linear unavailable");
    };
    const out = await mergePullRequest(s.ctx, { pr: 9 });
    expect(out.merged).toBe(true);
    expect(out.unblocked).toBeNull();
    expect(out.workersListed).toBe(false);
    expect(out.warnings).toContain(
      "could not list the workers in flight and unblocked tickets (Linear unavailable); run armada status",
    );
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
      summary: `PR #9 squash-merged into main as ${SQUASH}, head ${HEAD}; merged on its own (no merge rule)`,
    });
    expect(out.workers).toEqual([
      { ticket: "DEMO-8", title: "Rename a list", phase: "implementing", runtime: "Claude Code", handle: "ws-2" },
    ]);
    expect(out.archive).toMatchObject({
      runtime: "Conductor",
      handle: "ws-1/s-1",
      guide: "armada-runtime-conductor",
      source: "armada",
      claim: { ticket: "DEMO-7", handle: "ws-1/s-1", releasedAt: NOW.toISOString() },
      open: [{ ticket: "DEMO-8", handle: "ws-2", releasedAt: null }],
    });
    expect(out.warnings).toEqual([]);
    expect(await db.openInboxItems({ project: "widgets", recipient: "coordinator" })).toEqual([]);
    expect((await db.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    expect(db.events.filter((e) => e.ticket === "DEMO-7").map((e) => [e.kind, e.headSha])).toEqual([["merge", HEAD]]);
  });

  test.each([1, 3])(
    "post-merge clean-up failing %i times retries, then resolves or prints recovery",
    async (failures) => {
      let attempts = 0;
      const live = tempFleet({
        fail: (op) => (op === "merge" && ++attempts <= failures ? new Error("connection reset") : null),
      });
      const s = setup({ live });
      await live.store.putHandBack({ project: "widgets", ticket: "DEMO-7", author: null, body: "PR #9", at: NOW });

      const out = await mergePullRequest(s.ctx, { pr: 9 });

      expect(out.merged).toBe(true);
      expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
      expect(s.linear.get("DEMO-7").statusType).toBe("completed");
      expect(attempts).toBe(failures === 1 ? 2 : 3);
      expect(s.sleeps).toEqual(failures === 1 ? [2000] : [2000, 4000]);
      expect((await live.store.getInboxItem("widgets", 1))?.resolvedAt).toBe(failures === 1 ? NOW.toISOString() : null);
      if (failures === 1) expect(out.lines).toContain("Hand-back resolved in the coordinator's inbox.");
      else expect(out.lines).toContain('Next: armada answer 1 "resolved: PR merged"');
    },
  );

  test("an inbox write failing after the merge event landed retries without recording a second merge", async () => {
    const live = tempFleet();
    const s = setup({ live });
    await live.store.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-7",
      runtime: "Conductor",
      handle: "ws-1/s-1",
      branch: null,
      at: NOW,
    });
    await live.store.putHandBack({ project: "widgets", ticket: "DEMO-7", author: null, body: "PR #9", at: NOW });
    const resolve = live.store.resolveInboxItems;
    let failed = false;
    live.store.resolveInboxItems = async (q) => {
      if (q.kind === "hand-back" && !failed) {
        failed = true;
        throw new Error("temporary write failure");
      }
      return resolve(q);
    };
    expect((await mergePullRequest(s.ctx, { pr: 9 })).merged).toBe(true);
    expect((await live.store.getInboxItem("widgets", 1))?.resolvedAt).toBe(NOW.toISOString());
    expect(live.store.events.filter((e) => e.kind === "merge")).toHaveLength(1);
    expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    expect(s.sleeps).toEqual([2000]);
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
    expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toEndWith(
      ", merged without lock (--no-lock); merged on its own (no merge rule)",
    );
    expect(out.warnings[0]).toBe(
      "merged without the merge lock (--no-lock), merge holds were not checked: make sure no other coordinator merges in widgets now",
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

/** A clock for --wait: every sleep moves it and then runs `tick` (GitHub changing meanwhile). */
function clocked(s: ReturnType<typeof setup>, tick: (slept: number) => Promise<void> | void = () => {}) {
  let t = NOW.getTime();
  let slept = 0;
  s.ctx.now = () => new Date(t);
  s.ctx.sleep = async (ms) => {
    t += ms;
    s.sleeps.push(ms);
    await tick(++slept);
  };
}

const green = (s: ReturnType<typeof setup>) =>
  Object.assign(s.forge.pr, { mergeStateStatus: "CLEAN", checks: [{ name: "test", state: "success" }] });

describe("the owner's merge approval (THE-885)", () => {
  const RULE = '\n[policy]\nmerge_approval = "merge on your own, except front-end changes"\n';
  const approve = (live: ReturnType<typeof tempFleet>, id: number, action: "approve" | "changes" = "approve") =>
    requestDecision(live.store, {
      project: "widgets",
      id,
      action,
      note: action === "changes" ? "The toggle is unreadable" : null,
      author: "Ada",
      now: NOW,
    });

  test("with a rule, the coordinator says why it merges on its own, and the ticket records it", async () => {
    const live = tempFleet();
    const s = setup({ live, toml: `${GATES}${RULE}` });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      `#9 (DEMO-7) cannot be merged: the merge rule asks you to judge #9: look at its files and what users will see, and record why\nNext: armada merge 9 --reason "<why it may merge on its own>", or armada merge 9 --ask-owner --reason "<why the owner must see it>"`,
    );
    expect(s.forge.merges).toEqual([]);
    const out = await mergePullRequest(s.ctx, { pr: 9, reason: "CLI only" });
    expect(out.lines).toContain(
      'Merge rule (armada.toml [policy] merge_approval): "merge on your own, except front-end changes"',
    );
    expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toEndWith(
      "; merged on its own (rule: merge on your own, except front-end changes): CLI only",
    );
    expect(live.store.events.at(-1)?.message).toEndWith(
      "; merged on its own (rule: merge on your own, except front-end changes): CLI only",
    );
  });

  test("--ask-owner holds the pull request for the owner; merge waits for their approval of that exact head", async () => {
    const live = tempFleet();
    const s = setup({ live, toml: `${GATES}${RULE}` });
    s.ctx.appUrl = "https://armada.example.test";
    s.forge.pr = pull({
      files: [{ path: "web/Toggle.tsx", additions: 12, deletions: 3 }],
      additions: 12,
      deletions: 3,
    });
    s.forge.preview = async (sha) => `https://preview-${sha.slice(0, 7)}.example.app`;
    const asked = await askOwnerToMerge(s.ctx, { pr: 9, reason: "touches components/Toggle" });
    expect(asked.merged).toBe(false);
    expect(asked.lines).toContain("Approval link, posted on DEMO-7: https://armada.example.test/approve/1");
    expect(s.forge.merges).toEqual([]);
    expect(live.store.validations).toMatchObject([
      {
        id: 1,
        ticket: "DEMO-7",
        kind: "merge",
        reason: "touches components/Toggle",
        pr: {
          number: 9,
          headSha: HEAD,
          files: [{ path: "web/Toggle.tsx", additions: 12, deletions: 3 }],
          ci: "success",
          preview: "https://preview-0123456.example.app",
        },
        decision: null,
      },
    ]);
    expect(s.linear.writes).toEqual([
      `comment DEMO-7 Owner approval asked for the merge of PR #9 at ${HEAD}: touches components/Toggle`,
    ]);
    expect(s.linear.get("DEMO-7").comments[0]?.excerpt).toContain("https://armada.example.test/approve/1");

    // Before the owner decides, and after they ask for changes, nothing merges, even with a reason.
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, reason: "CLI only" }))).toStartWith(
      "#9 (DEMO-7) cannot be merged: the owner has not decided on the merge of #9 yet (asked 2026-03-04T10:00:00.000Z): https://armada.example.test/approve/1",
    );
    await approve(live, 1, "changes");
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toStartWith(
      "#9 (DEMO-7) cannot be merged: the owner requested changes on #9: The toggle is unreadable",
    );

    // Asked again and approved: the merge records who approved, and when.
    await askOwnerToMerge(s.ctx, { pr: 9, reason: "touches components/Toggle" });
    await approve(live, 2);
    await mergePullRequest(s.ctx, { pr: 9 });
    expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
    expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toEndWith("; approved by Ada at 2026-03-04 10:00 UTC");
    // The owner's decisions reached the coordinator's inbox; the merge resolved those still open.
    expect(live.store.items.filter((i) => i.kind === "decision").map((i) => i.resolution)).toEqual([
      "merged",
      "merged",
    ]);
  });

  test("unreadable approvals refuse a merge the rule covers; an approval asked holds a pull request no ticket owns too", async () => {
    const down = setup({
      live: tempFleet({ fail: (op) => (op === "validations" ? new Error("connection reset") : null) }),
      toml: `${GATES}${RULE}`,
    });
    expect(await refusal(mergePullRequest(down.ctx, { pr: 9, reason: "CLI only" }))).toBe(
      "#9 (DEMO-7) cannot be merged: the owner's approvals of #9 could not be read (Armada (armada.example.test) unreachable: connection reset (POST fleet/validations))\nNext: armada merge 9 again once Armada answers",
    );
    expect(down.forge.merges).toEqual([]);

    const live = tempFleet();
    const s = setup({ live });
    await askOwnerToMerge(s.ctx, { pr: 9, reason: "a release that changes the landing" });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: "config only" }))).toStartWith(
      "#9 cannot be merged: the owner has not decided on the merge of #9 yet",
    );
    expect(s.forge.comments).toEqual([]);
    s.forge.pr.headRef = "release-please--branches--main";
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true }))).toStartWith(
      "#9 cannot be merged: the owner has not decided on the merge of #9 yet",
    );
  });

  test("a new head needs a new approval", async () => {
    const live = tempFleet();
    const s = setup({ live });
    await askOwnerToMerge(s.ctx, { pr: 9, reason: "touches the settings page" });
    await approve(live, 1);
    // The worker pushes again and hands back the new head.
    s.forge.pr.headSha = BASE;
    s.linear.post("DEMO-7", `Agent status: ready-to-merge — PR #9, head ${BASE}, CI green`, "2026-03-04T09:30:00Z");
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toBe(
      `#9 (DEMO-7) cannot be merged: the owner approved #9 at ${HEAD}, but its head is now ${BASE}: a new head needs a new approval\nNext: armada merge 9 --ask-owner --reason "<why the owner must see it>"`,
    );
    expect(s.forge.merges).toEqual([]);
  });
});

describe("armada merge --wait", () => {
  const WAIT = { timeoutMs: 30 * 60_000 };
  const behind = (s: ReturnType<typeof setup>) => {
    s.forge.pr.mergeStateStatus = "BEHIND";
    s.forge.comparison = { baseSha: BASE, status: "DIVERGED", behindBy: 2, aheadBy: 2 };
  };

  test("updates a head behind main, waits for its checks without the lock, then merges the new head as the hand-back", async () => {
    const live = tempFleet();
    const s = setup({ live });
    behind(s);
    // While A waits for its checks, another coordinator merges #10: the lock is free.
    const b = setup({ live: tempFleet({ store: live.store, clock: live.clock }), holder: "coordinator-b" });
    b.forge.pr = pull({ number: 10, url: "https://github.com/acme/widgets/pull/10" });
    b.linear.post("DEMO-7", `Agent status: ready-to-merge — PR #10, head ${HEAD}, CI green`, "2026-03-04T09:30:00Z");
    let other: Awaited<ReturnType<typeof mergePullRequest>> | null = null;
    clocked(s, async (slept) => {
      if (slept === 1) other = await mergePullRequest(b.ctx, { pr: 10 });
      if (slept === 2) green(s);
    });

    const out = await mergePullRequest(s.ctx, { pr: 9, wait: WAIT });

    expect(other).toMatchObject({ merged: true });
    expect(s.forge.updates).toEqual([{ number: 9, sha: HEAD }]);
    expect(s.forge.merges).toEqual([{ number: 9, sha: UPDATED }]);
    expect(s.progress).toContain("Updated the branch of #9 with main (a merge commit on 0123456).");
    expect(s.progress).toContain(
      'Waiting: on head abababa: required check "test" is pending; GitHub reports #9 as BLOCKED, not CLEAN: a branch protection rule blocks it (a required review or check)…',
    );
    expect(out.lines[0]).toBe(
      `Checklist passed for #9 (DEMO-7): handed back at ${HEAD}, now ${UPDATED} with only main merged in (1 merge commit), CLEAN, checks green, no open review thread.`,
    );
    expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toBe(
      `PR #9 squash-merged into main as ${SQUASH}, head ${UPDATED}, the handed-back ${HEAD} updated with main; merged on its own (no merge rule)`,
    );
    expect(live.store.leases.size).toBe(0);
  });

  const stops: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    [
      "a red check after the update",
      (s) => {
        clocked(s, () => {
          Object.assign(s.forge.pr, { mergeStateStatus: "BLOCKED", checks: [{ name: "test", state: "failure" }] });
        });
      },
      `  - on head abababa: required check "test" is failure\n  - GitHub reports #9 as BLOCKED, not CLEAN: a branch protection rule blocks it (a required review or check)\nThis run updated the branch of #9 with main (head now ${UPDATED}): whoever pushes to it next pulls first.`,
    ],
    [
      "a conflict",
      (s) => {
        Object.assign(s.forge.pr, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" });
      },
      "GitHub reports #9 as DIRTY, not CLEAN: it conflicts with its base; ask the worker to bring the base branch in and resolve the conflicts",
    ],
    [
      "GitHub refusing the update (a protected branch)",
      (s) => {
        s.forge.updateAnswers = [{ ok: false, message: "Resource not accessible (HTTP 403)", transient: false }];
      },
      "GitHub refused to update the branch of #9 with main: Resource not accessible (HTTP 403). A branch protection rule or ruleset can forbid it",
    ],
    [
      "an update GitHub accepted that never shows",
      (s) => {
        s.forge.updateAnswers = [
          { ok: true, message: "Updating pull request branch.", transient: false, effect: false },
        ];
      },
      `GitHub accepted to update the branch of #9 with main, but its head is still ${HEAD} after 3 min`,
    ],
    [
      "the timeout",
      (s) => clocked(s),
      `#9 (DEMO-7) is still not ready after 30 min: on head abababa: required check "test" is pending`,
    ],
  ];
  test("a required check not reported yet keeps GitHub BLOCKED with nothing running: that is waited for", async () => {
    const s = setup();
    Object.assign(s.forge.pr, { mergeStateStatus: "BLOCKED", checks: [] });
    clocked(s, () => {
      green(s);
    });
    expect((await mergePullRequest(s.ctx, { pr: 9, wait: WAIT })).merged).toBe(true);
    expect(s.progress[0]).toStartWith(
      'Waiting: on head 0123456: required check "test" has not reported on the head yet',
    );
  });

  test("a head behind a base that does not require it up to date is test-merged, not updated", async () => {
    const s = setup({ toml: `${GATES}local_commands = ["bun run verify"]\n` });
    s.forge.comparison = { baseSha: BASE, status: "DIVERGED", behindBy: 2, aheadBy: 2 };
    clocked(s);
    expect((await mergePullRequest(s.ctx, { pr: 9, wait: WAIT })).merged).toBe(true);
    expect([s.forge.updates, s.repo.testMerges.length]).toEqual([[], 1]);
  });

  test("signed in with Armada down, it refuses before updating the branch or waiting", async () => {
    const s = setup({ down: true });
    behind(s);
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, wait: WAIT }))).toStartWith(
      "the merge lock needs Armada, which is unavailable",
    );
    expect([s.forge.updates, s.sleeps]).toEqual([[], []]);
  });

  test("with --no-ticket, a head this run updated waits for its checks instead of passing with none", async () => {
    const s = setup();
    Object.assign(s.forge.pr, { headRef: "armada/init-0.2.2", title: "chore(armada): set up Armada 0.2.2" });
    behind(s);
    s.forge.pr.checks = [];
    clocked(s, (slept) => {
      // The update's CI has not started yet on the first read; then it runs and passes.
      if (slept === 1) Object.assign(s.forge.pr, { checks: [], mergeStateStatus: "BLOCKED" });
      if (slept === 2) green(s);
    });
    const out = await mergePullRequest(s.ctx, { pr: 9, noTicket: true, wait: WAIT });
    expect(s.forge.merges).toEqual([{ number: 9, sha: UPDATED }]);
    expect(out.lines.join("\n")).not.toContain("ran on head");
  });

  for (const [name, arrange, message] of stops)
    test(`stops on ${name}, naming it, and merges nothing`, async () => {
      const s = setup();
      behind(s);
      clocked(s);
      arrange(s);
      expect(await refusal(mergePullRequest(s.ctx, { pr: 9, wait: WAIT }))).toContain(message);
      expect([s.forge.merges, s.linear.writes]).toEqual([[], []]);
    });
});

describe("a head that moved after the hand-back", () => {
  type S = ReturnType<typeof setup>;
  /** The head is a merge commit with parents `parents` and tree `tree`. */
  const moved = (s: S, parents: string[], tree = TREE) => {
    s.forge.commits.set(UPDATED, { sha: UPDATED, tree, parents });
    s.forge.pr.headSha = UPDATED;
  };

  test("counts as the hand-back when it only merges main in, as GitHub's update branch does", async () => {
    const s = setup();
    moved(s, [HEAD, BASE]);
    const out = await mergePullRequest(s.ctx, { pr: 9 });
    expect(s.forge.merges).toEqual([{ number: 9, sha: UPDATED }]);
    expect(out.merged).toBe(true);
  });

  const refused: [string, (s: S) => void, string][] = [
    [
      "a merge that changes more than main",
      (s) => moved(s, [HEAD, BASE], SQUASH),
      "the merge commit abababa changes more than a clean merge of main",
    ],
    [
      "a merge of a commit not on main",
      (s) => moved(s, [HEAD, SQUASH]),
      "the merge commit abababa brings in 5555555, which is not on main",
    ],
    [
      "a clean merge of main on top of a new commit",
      (s) => {
        moved(s, [SQUASH, BASE]);
        s.repo.trees.set(`${SQUASH}:${BASE}`, TREE);
      },
      "5555555 is not a merge commit of main",
    ],
    ["a plain commit", (s) => moved(s, [HEAD]), "abababa is not a merge commit of main"],
    [
      "no git to check the merge",
      (s) => {
        moved(s, [HEAD, BASE]);
        s.ctx.repo = null;
      },
      "git is not available to check what the merge commit abababa changes",
    ],
  ];
  for (const [name, arrange, why] of refused)
    test(`is refused for ${name}`, async () => {
      const s = setup();
      arrange(s);
      const message = await refusal(mergePullRequest(s.ctx, { pr: 9 }));
      expect(message).toContain(
        `the head of #9 is ${UPDATED}, not the handed-back ${HEAD}: it moved after the hand-back and ${why}`,
      );
      expect(s.forge.merges).toEqual([]);
    });
});

describe("armada merge --no-ticket", () => {
  const init = (s: ReturnType<typeof setup>, over: Partial<MergePull> = {}) =>
    Object.assign(s.forge.pr, {
      title: "chore(armada): set up Armada 0.2.2",
      headRef: "armada/init-0.2.2",
      ...over,
    });

  test("merges a pull request no ticket owns with every other check, and writes nothing to Linear", async () => {
    const s = setup();
    init(s);
    const out = await mergePullRequest(s.ctx, { pr: 9, noTicket: true });
    expect([out.merged, out.ticket, out.archive]).toEqual([true, null, null]);
    expect(out.lines[0]).toBe(`Checklist passed for #9: head ${HEAD}, CLEAN, checks green, no open review thread.`);
    expect(out.workers.map((w) => w.ticket)).toEqual(["DEMO-7", "DEMO-8"]);
    expect([s.forge.merges, s.linear.writes]).toEqual([[{ number: 9, sha: HEAD }], []]);

    init(s, { state: "open", checks: [{ name: "test", state: "failure" }] });
    const red = await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true }));
    expect(red).toContain(`#9 cannot be merged:\n  - on head 0123456: required check "test" is failure`);
    expect(red).toContain("Next: armada ci why 9");
  });

  test("merges a release pull request on which no CI ran, with a note, once GitHub had time to start one", async () => {
    const s = setup();
    init(s, {
      title: "chore(main): release 0.2.3",
      headRef: "release-please--branches--main--components--widgets",
      checks: [{ name: "Vercel", state: "success" }],
      mergeStateStatus: "UNSTABLE",
      updatedAt: "2026-03-04T09:59:30Z",
    });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true }))).toContain(
      "on head 0123456: no check has reported yet, and it was updated less than 1 min ago",
    );
    s.forge.pr.updatedAt = "2026-03-04T09:58:00Z";
    const out = await mergePullRequest(s.ctx, { pr: 9, noTicket: true });
    expect(out.merged).toBe(true);
    expect(out.lines.slice(1, 3)).toEqual([
      "none of \"test\" ran on head 0123456; with --no-ticket it passes on GitHub's own state and the checks that ran, as for a release pull request opened with the workflow's token.",
      "GitHub reports #9 as UNSTABLE with no check failing.",
    ]);
    expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
  });

  test.each([undefined, "", " \n\t "])(
    "refuses a ticket-named branch without a nonblank reason (%j)",
    async (reason) => {
      const s = setup();
      expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason }))).toBe(
        'the branch of #9 (feature/demo-7-do-the-thing) names DEMO-7: merge it on its worker\'s hand-back, or use --no-ticket --reason "<why the ticket stays open>"\nNext: armada merge 9, or armada merge 9 --no-ticket --reason "<why the ticket stays open>"',
      );
    },
  );

  test("a reason permits a pinned, locked merge while leaving the ticket and worker untouched", async () => {
    const live = tempFleet();
    const s = setup({ live });
    const ticket = s.linear.get("DEMO-7");
    ticket.labels = [label("phase-implementing"), label("rt-conductor")];
    ticket.comments = [];
    const before = structuredClone(ticket);
    // The no-ticket override must not even read the ticket to decide its merge.
    s.linear.readTicket = async () => {
      throw new Error("no ticket read allowed");
    };
    await live.store.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-7",
      runtime: "Conductor",
      handle: "ws-1/s-1",
      branch: s.forge.pr.headRef ?? null,
      at: NOW,
    });
    const handle = await live.fleet.runtimeHandle("DEMO-7");
    s.forge.comment = async (number, body) => {
      expect(live.store.leases.size).toBe(1);
      expect(s.forge.merges).toEqual([]);
      s.forge.comments.push({ number, body });
    };
    const out = await mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: " config only; \n ticket continues " });
    expect(out.merged).toBe(true);
    expect(out.ticket).toBeNull();
    expect(out.archive).toBeNull();
    expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
    expect(s.forge.comments).toEqual([
      {
        number: 9,
        body: `Armada merge --no-ticket at ${HEAD}: config only; ticket continues. DEMO-7 stays open; its ticket and worker are left unchanged.`,
      },
    ]);
    expect(s.linear.writes).toEqual([]);
    expect(ticket).toEqual(before);
    expect(await live.fleet.runtimeHandle("DEMO-7")).toEqual(handle);
    expect(live.store.events.filter((e) => e.kind === "merge")).toEqual([]);
    expect(live.store.leases.size).toBe(0);
  });

  test("dry-run with a reason checks the override without posting or merging", async () => {
    const s = setup();
    const out = await mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: "config only", dryRun: true });
    expect(out.merged).toBe(false);
    expect(s.forge.comments).toEqual([]);
    expect(s.forge.merges).toEqual([]);
    expect(s.linear.writes).toEqual([]);
  });

  test("a failed reason comment refuses the merge and releases the lock", async () => {
    const live = tempFleet();
    const s = setup({ live });
    s.forge.comment = async () => {
      throw new Error("GitHub unavailable");
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: "config only" }))).toContain(
      "could not record the --no-ticket reason on #9 (GitHub unavailable); nothing was merged",
    );
    expect(s.forge.merges).toEqual([]);
    expect(s.linear.writes).toEqual([]);
    expect(live.store.leases.size).toBe(0);
  });

  test.each([
    { over: { checks: [{ name: "test", state: "failure" as const }] }, problem: 'required check "test" is failure' },
    { over: { checks: [] }, problem: 'required check "test" has not reported on the head yet' },
    { over: { reviewThreads: { total: 1, read: 1, unresolved: 1 } }, problem: "1 unresolved review thread" },
  ])("a reason preserves the CI and review gates (%j)", async ({ over, problem }) => {
    const s = setup();
    Object.assign(s.forge.pr, over);
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: "config only" }))).toContain(problem);
    expect(s.forge.merges).toEqual([]);
    expect(s.forge.comments).toEqual([]);
    expect(s.linear.writes).toEqual([]);
  });

  test("a reason cannot bypass an unavailable required lock", async () => {
    const s = setup({ down: true });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: "config only" }))).toContain(
      "the merge lock needs Armada",
    );
    expect(s.forge.comments).toEqual([]);
    expect(s.forge.merges).toEqual([]);
  });

  test("a reason does not permit a head to move while checked", async () => {
    const s = setup();
    s.forge.onCompare = async () => {
      s.forge.pr.headSha = BASE;
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, reason: "config only" }))).toContain("moved");
    expect(s.forge.merges).toEqual([]);
    expect(s.forge.comments).toEqual([]);
  });
});

test("GitHub's HAS_HOOKS (mergeable, with pre-receive hooks) merges like CLEAN", async () => {
  const s = setup();
  s.forge.pr.mergeStateStatus = "HAS_HOOKS";
  expect((await mergePullRequest(s.ctx, { pr: 9 })).merged).toBe(true);
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

describe("shared merge holds", () => {
  test.each(["success", "comment-fails", "retry"])(
    "an unticketed fix requires a durable override audit (%s)",
    async (mode) => {
      const live = tempFleet();
      const first = await live.fleet.openHold({ kind: "manual", reason: "api deploy is broken" });
      const second = await live.fleet.openHold({ kind: "main-red", ref: BASE, reason: "main tests failed" });
      const s = setup({ live });
      Object.assign(s.forge.pr, { title: "fix(release): repair the deployment", headRef: "fix/deployment" });
      if (mode === "retry") s.forge.answers.push({ ok: false, message: "503", transient: true, effect: false });
      if (mode === "comment-fails") {
        s.forge.comment = async () => {
          throw new Error("GitHub unavailable");
        };
        expect(
          await refusal(mergePullRequest(s.ctx, { pr: 9, noTicket: true, throughHold: "repairs the failure" })),
        ).toContain("could not record the --no-ticket reason on #9 (GitHub unavailable); nothing was merged");
        expect(s.forge.merges).toEqual([]);
      } else {
        expect(
          (await mergePullRequest(s.ctx, { pr: 9, noTicket: true, throughHold: "repairs the failure" })).merged,
        ).toBe(true);
        expect(s.forge.comments).toHaveLength(1);
        const comment = s.forge.comments[0]?.body;
        expect(comment).toContain(`merged through holds #${first.id}, #${second.id}: repairs the failure`);
        expect(comment?.match(/repairs the failure/g)).toEqual(["repairs the failure"]);
      }
      expect(s.linear.writes).toEqual([]);
      expect((await live.fleet.holds()).map((h) => h.id)).toEqual([first.id, second.id]);
    },
  );

  test("both coordinators refuse until every hold is cleared; a fix records every override", async () => {
    const live = tempFleet();
    const first = await live.fleet.openHold({ kind: "manual", reason: "api deploy is broken" });
    const second = await live.fleet.openHold({ kind: "main-red", ref: BASE, reason: "main tests failed" });
    for (const holder of ["coordinator-a", "coordinator-b"]) {
      const s = setup({ live: tempFleet({ store: live.store, clock: live.clock }), holder });
      const message = await refusal(mergePullRequest(s.ctx, { pr: 9 }));
      expect(message).toContain(`hold #${first.id}`);
      expect(message).toContain("api deploy is broken");
      expect(message).toContain(`hold #${second.id}`);
      expect(message).toContain("--through-hold");
      expect(message).toContain(`Next: armada hold clear ${first.id} --reason`);
      expect(s.forge.merges).toEqual([]);
      expect(s.forge.reads).toBe(0);
    }
    const fix = setup({ live });
    expect((await mergePullRequest(fix.ctx, { pr: 9, throughHold: "repairs the failure" })).merged).toBe(true);
    const comment = fix.linear.get("DEMO-7").comments[0]?.status?.summary;
    expect(comment).toContain(`merged through holds #${first.id}, #${second.id}: repairs the failure`);
    expect(comment?.match(/repairs the failure/g)).toEqual(["repairs the failure"]);
    await live.fleet.clearHold({ id: first.id, reason: "deploy verified" });
    await live.fleet.clearHold({ id: second.id, reason: "main green" });
    expect(await live.fleet.holds()).toEqual([]);
  });

  test("a hold opened while waiting stops the next poll; unavailable holds fail closed", async () => {
    const live = tempFleet();
    const s = setup({ live });
    s.forge.pr.checks = [{ name: "test", state: "pending" }];
    s.forge.pr.ci = "pending";
    s.ctx.sleep = async () => {
      await live.fleet.openHold({ kind: "manual", reason: "stop during wait" });
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, wait: { timeoutMs: 60_000 } }))).toContain(
      "stop during wait",
    );
    expect(s.forge.merges).toEqual([]);
    const down = setup({ live: tempFleet({ fail: (op) => (op === "holds" ? new Error("connection reset") : null) }) });
    expect(await refusal(mergePullRequest(down.ctx, { pr: 9 }))).toContain("unavailable");
    expect(down.forge.merges).toEqual([]);
  });
});

test("a pause opened during checks, preflight or retry stops merging or joins the audit", async () => {
  for (const stage of ["checklist", "preflight", "retry"]) {
    for (const throughHold of [undefined, "repairs the failure"]) {
      const live = tempFleet();
      const s = setup({ live });
      let holdId = 0;
      const open = async () => {
        holdId = (await live.fleet.openHold({ kind: "manual", reason: `pause during ${stage}` })).id;
      };
      if (stage === "checklist") {
        s.forge.onCompare = async () => {
          s.forge.onCompare = null;
          await open();
        };
      } else {
        let attempts = 0;
        s.ctx.forge.beforeMerge = async () => {
          if (++attempts === (stage === "retry" ? 2 : 1)) await open();
        };
        if (stage === "retry") s.forge.answers.push({ ok: false, message: "503", transient: true, effect: false });
      }
      if (throughHold) {
        expect((await mergePullRequest(s.ctx, { pr: 9, throughHold })).merged).toBe(true);
        expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toContain(
          `merged through hold #${holdId}: ${throughHold}`,
        );
      } else {
        expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toContain(`pause during ${stage}`);
        expect(s.forge.pr.state).toBe("open");
        expect(s.forge.merges).toHaveLength(stage === "retry" ? 1 : 0);
      }
    }
  }
});

test("slow preflight guards must retain lease ownership before the initial merge or a retry", async () => {
  for (const expireOnAttempt of [1, 2]) {
    const live = tempFleet();
    const s = setup({ live });
    let attempts = 0;
    s.ctx.forge.beforeMerge = async () => {
      if (++attempts === expireOnAttempt) {
        live.clock.advance(MERGE_LEASE_TTL_MS + 1);
        expect(await live.fleet.acquireLease({ name: "merge", holder: "another-coordinator", ttlMs: 60_000 })).toEqual({
          acquired: true,
        });
      }
    };
    if (expireOnAttempt === 2) s.forge.answers.push({ ok: false, message: "503", transient: true, effect: false });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toContain("merge lock could not be renewed");
    expect(s.forge.pr.state).toBe("open");
    expect(s.forge.merges).toHaveLength(expireOnAttempt - 1);
    expect(s.linear.writes).toEqual([]);
  }
});

test("main red is an informative merge note and health read failures do not block", async () => {
  const s = setup();
  s.ctx.forge.mainHealth = async () => ({
    branch: "main",
    head: BASE,
    state: "red",
    redSince: { sha: BASE, pr: 17, at: NOW.toISOString(), failing: ["test"] },
    fixRunning: null,
    redBeyondWindow: false,
  });
  const out = await mergePullRequest(s.ctx, { pr: 9, dryRun: true });
  expect(out.lines).toContain("main red since #17 (test failing on fedcba9)");
  expect(s.forge.merges).toEqual([]);
  s.ctx.forge.mainHealth = async () => {
    throw new Error("synthetic outage");
  };
  const unavailable = await mergePullRequest(s.ctx, { pr: 9, dryRun: true });
  expect(unavailable.lines).toContain("default-branch CI could not be read; check it on GitHub");
});

describe("Linear outage merge recovery", () => {
  const down = () => new LinearError("Linear API HTTP 503", true, true);
  const handBack = (live: ReturnType<typeof tempFleet>, body = `PR #9, head ${HEAD}, CI green`) =>
    live.store.putHandBack({ project: "widgets", ticket: "DEMO-7", author: null, body, at: NOW });

  test.each(["final", "partial", "close"])(
    "checks an exact Armada hand-back during Linear outage (%s)",
    async (mode) => {
      const live = tempFleet();
      const s = setup({ live });
      await handBack(live, `PR #9, head ${HEAD}, CI green${mode === "final" ? "" : "; more PRs: the dashboard part"}`);
      const read = s.linear.readTicket.bind(s.linear);
      await live.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-7",
        runtime: "Conductor",
        handle: "ws-1/s-1",
        branch: null,
        at: NOW,
      });
      let linearReads = 0;
      s.linear.readTicket = createLinearWriter({
        apiKey: "synthetic-key",
        labels: s.ctx.config.tracker.labels,
        fetch: async () => {
          linearReads++;
          return new Response("Service unavailable", { status: 503 });
        },
        sleep: async () => {},
        random: () => 0.5,
      }).readTicket;
      const out = await mergePullRequest(s.ctx, { pr: 9, close: mode === "close" });
      expect(linearReads).toBe(9);
      expect(out.merged).toBe(true);
      expect(out.linearPending).toBe(true);
      expect(out.lines).toContain("Linear did not answer; the hand-back was checked on Armada");
      expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
      expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(
        mode === "partial" ? null : NOW.toISOString(),
      );
      const items = await live.fleet.ticketItems("DEMO-7");
      expect((await live.store.getInboxItem("widgets", 1))?.resolvedAt).toBe(NOW.toISOString());
      expect(items.find((i) => i.kind === "linear-pending")?.body).toContain("Finish Linear for #9");
      expect(s.linear.writes).toEqual([]);
      s.linear.readTicket = read;
      expect((await finishMerge(s.ctx, { pr: 9 })).linearPending).toBe(false);
      expect(s.linear.get("DEMO-7").statusType).toBe(mode === "partial" ? "started" : "completed");
      const writes = [...s.linear.writes];
      await finishMerge(s.ctx, { pr: 9 });
      expect(s.linear.writes).toEqual(writes);
    },
  );

  test("queue intent uses the same exact Armada hand-back during a Linear outage", async () => {
    const live = tempFleet();
    const s = setup({ live });
    await handBack(live);
    s.linear.readTicket = async () => {
      throw down();
    };
    s.forge.pr.checks = [{ name: "test", state: "pending" }];
    const entry = await prepareQueueEntry(s.ctx, { pr: 9 });
    expect(entry).toMatchObject({ pr: 9, ticket: "DEMO-7", headSha: HEAD });
    expect(s.forge.merges).toEqual([]);
    expect(s.linear.writes).toEqual([]);
  });

  test.each([
    `PR #8, head ${HEAD}`,
    `PR #9, head ${BASE}`,
    "PR #9, head 0123456",
    "PR #9 has no SHA",
    `PR #9, head ${HEAD}ffff`,
  ])("refuses an unmatched fallback: %s", async (body) => {
    const live = tempFleet();
    const s = setup({ live });
    await handBack(live, body);
    s.linear.readTicket = async () => {
      throw down();
    };
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toContain("nothing was merged");
    expect(s.forge.merges).toEqual([]);
  });

  test("an authentication failure never uses the fallback", async () => {
    const live = tempFleet();
    const s = setup({ live });
    await handBack(live);
    s.linear.readTicket = async () => {
      throw new LinearError("Linear rejected the API key (HTTP 401)", true);
    };
    await expect(mergePullRequest(s.ctx, { pr: 9 })).rejects.toThrow("HTTP 401");
    expect(s.forge.merges).toEqual([]);
  });

  test.each([false, true])(
    "post-merge Linear failure preserves intent; finish twice writes once (partial:%s)",
    async (keepOpen) => {
      const live = tempFleet();
      const s = setup({ live });
      await handBack(live);
      await live.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-7",
        runtime: "Conductor",
        handle: "ws-1/s-1",
        branch: null,
        at: NOW,
      });
      let sessionEnded = false;
      s.ctx.afterRecord = async () => {
        sessionEnded = true;
      };
      const update = s.linear.updateTicket.bind(s.linear);
      s.linear.updateTicket = async () => {
        expect(sessionEnded).toBe(!keepOpen);
        expect(live.store.events.some((e) => e.kind === (keepOpen ? "report" : "merge"))).toBe(true);
        expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(
          keepOpen ? null : NOW.toISOString(),
        );
        throw down();
      };
      const out = await mergePullRequest(s.ctx, { pr: 9, keepOpen });
      expect(out.merged).toBe(true);
      expect(out.linearPending).toBe(true);
      expect((await live.fleet.ticketItems("DEMO-7")).filter((i) => i.kind === "linear-pending")).toHaveLength(1);
      s.linear.updateTicket = update;
      expect((await finishMerge(s.ctx, { pr: 9 })).linearPending).toBe(false);
      const writes = [...s.linear.writes];
      await finishMerge(s.ctx, { pr: 9 });
      expect(s.linear.writes).toEqual(writes);
      expect(
        s.linear.bodies.filter((b) => b.startsWith(`Agent status: ${keepOpen ? "implementing" : "merged"} — PR #9`)),
      ).toHaveLength(1);
      expect(await live.fleet.ticketItems("DEMO-7")).toEqual([]);
      expect(s.forge.merges).toHaveLength(1);
      expect(s.linear.get("DEMO-7").statusType).toBe(keepOpen ? "started" : "completed");
      if (keepOpen) {
        s.linear.get("DEMO-7").statusType = "completed";
        s.linear.get("DEMO-7").stateId = "st-done";
        await finishMerge(s.ctx, { pr: 9 });
        expect(s.linear.writes).toEqual(writes);
        expect(s.linear.get("DEMO-7").statusType).toBe("completed");
      }
    },
  );

  test("finish rejects an open PR without a lease, and finishes a manually merged PR", async () => {
    const s = setup();
    await expect(finishMerge(s.ctx, { pr: 9 })).rejects.toThrow("not merged");
    expect(s.linear.writes).toEqual([]);
    Object.assign(s.forge.pr, { state: "merged", mergeCommit: SQUASH });
    const out = await finishMerge(s.ctx, { pr: 9 });
    expect(out.merged).toBe(true);
    expect(s.linear.get("DEMO-7").statusType).toBe("completed");
    expect(s.forge.merges).toEqual([]);
  });
});

test("Linear fallback preserves CI and owner approval gates, and ignores resolved hand-backs", async () => {
  for (const gate of ["ci", "owner", "resolved", "missing"] as const) {
    const live = tempFleet();
    const s = setup({ live });
    if (gate !== "missing")
      await live.store.putHandBack({
        project: "widgets",
        ticket: "DEMO-7",
        author: null,
        body: `PR #9, head ${HEAD}`,
        at: NOW,
      });
    s.linear.readTicket = async () => {
      throw new LinearError("Linear API HTTP 503", true, true);
    };
    if (gate === "ci") s.forge.pr.checks = [{ name: "test", state: "failure" }];
    if (gate === "owner")
      await live.fleet.validate({
        ticket: "DEMO-7",
        kind: "merge",
        what: "Check this PR",
        reason: "owner must check",
        choices: null,
        pr: {
          number: 9,
          url: s.forge.pr.url,
          title: s.forge.pr.title,
          headSha: HEAD,
          files: null,
          additions: 1,
          deletions: 0,
          ci: "success",
          preview: null,
        },
        attachments: [],
      });
    if (gate === "resolved") await live.fleet.resolve({ id: 1, resolution: "obsolete" });
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9 }))).toContain(
      gate === "ci" ? "test" : gate === "owner" ? "owner has not decided" : "nothing was merged",
    );
    expect(s.forge.merges).toEqual([]);
    expect(live.store.events.filter((e) => e.kind === "merge")).toEqual([]);
  }
});

test("a confirmed merge reports both pending systems when Armada and Linear are down", async () => {
  const live = tempFleet({
    fail: (op) => (op === "merge" || op === "chore" ? new Error("service unavailable") : null),
  });
  const s = setup({ live });
  s.linear.updateTicket = async () => {
    throw new LinearError("Linear API HTTP 503", true, true);
  };
  const out = await mergePullRequest(s.ctx, { pr: 9 });
  expect(out).toMatchObject({ merged: true, linearPending: true, armadaPending: true });
  expect(out.lines.some((line) => line.startsWith("Next: armada answer"))).toBe(true);
  expect(out.lines).toContain("Next: armada merge --finish 9");
});

test("finish repairs partial Linear writes and leaves chores open until all steps complete", async () => {
  const live = tempFleet();
  const s = setup({ live });
  const comment = s.linear.comment.bind(s.linear);
  s.linear.comment = async () => {
    throw new Error("Linear unavailable");
  };
  await mergePullRequest(s.ctx, { pr: 9 });
  expect(s.linear.get("DEMO-7").statusType).toBe("completed");
  expect(s.linear.get("DEMO-7").prs).toHaveLength(1);
  expect((await finishMerge(s.ctx, { pr: 9 })).linearPending).toBe(true);
  expect((await live.fleet.ticketItems("DEMO-7")).filter((i) => i.kind === "linear-pending")).toHaveLength(1);
  s.linear.comment = comment;
  expect((await finishMerge(s.ctx, { pr: 9 })).linearPending).toBe(false);
  expect(s.linear.writes.filter((w) => w.startsWith("update"))).toHaveLength(1);
  expect(s.linear.writes.filter((w) => w.startsWith("link"))).toHaveLength(1);
  expect(s.linear.bodies).toHaveLength(1);
});

test("queue intent accepts readiness waits but refuses broken rules and records the hand-back", async () => {
  const live = tempFleet();
  const s = setup({ live });
  s.forge.pr.mergeStateStatus = "BEHIND";
  s.forge.pr.checks = [{ name: "test", state: "pending" }];
  s.forge.comparison!.behindBy = 3;
  const queued = await prepareQueueEntry(s.ctx, { pr: 9, reason: "Reviewed", keepOpen: true, throughHold: "Fix main" });
  expect(queued).toEqual({
    pr: 9,
    ticket: "DEMO-7",
    noTicket: false,
    headSha: HEAD,
    reason: "Reviewed",
    keepOpen: true,
    throughHold: "Fix main",
    queuedBy: "coordinator-a",
  });
  expect(s.forge.merges).toEqual([]);
  expect(s.forge.updates).toEqual([]);
  expect(s.repo.testMerges).toEqual([]);
  const comparison = s.forge.comparison;
  s.forge.comparison = null;
  expect(await refusal(prepareQueueEntry(s.ctx, { pr: 9 }))).toContain("GitHub could not compare");
  s.forge.comparison = comparison;
  s.forge.pr.checks = [{ name: "test", state: "failure" }];
  expect(await refusal(prepareQueueEntry(s.ctx, { pr: 9 }))).toContain("test");
  s.forge.pr.checks = [{ name: "test", state: "pending" }];
  s.linear.get("DEMO-7").comments = [];
  expect(await refusal(prepareQueueEntry(s.ctx, { pr: 9 }))).toContain('no "Agent status: ready-to-merge" comment');
});

test("queuing preserves the merge judgement and pending owner decision without accepting requested changes", async () => {
  const live = tempFleet();
  const s = setup({ live, toml: `${GATES}\n[policy]\nmerge_approval = "Owner sees changes"\n` });
  expect(await refusal(prepareQueueEntry(s.ctx, { pr: 9 }))).toContain("requires --reason");
  await askOwnerToMerge(s.ctx, { pr: 9, reason: "Owner checks this" });
  expect(await prepareQueueEntry(s.ctx, { pr: 9, reason: "Reviewed" })).toMatchObject({ reason: "Reviewed" });
  await requestDecision(live.store, {
    project: "widgets",
    id: 1,
    action: "changes",
    note: "Fix it",
    author: "Owner",
    now: NOW,
  });
  expect(await refusal(prepareQueueEntry(s.ctx, { pr: 9, reason: "Reviewed" }))).toContain("owner requested changes");
});

describe("a ticket in several pull requests", () => {
  test.each(["hand-back", "refreshed-hand-back", "keep-open", "close"])(
    "%s retains the worker only for a partial merge",
    async (mode) => {
      const live = tempFleet();
      const s = setup({ live });
      if (mode === "hand-back" || mode === "close")
        s.linear.post(
          "DEMO-7",
          `Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green; shipped with ship-pr-dev; more PRs: the dashboard part`,
          "2026-03-04T09:30:00Z",
        );
      await live.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-7",
        runtime: "Conductor",
        handle: "ws-1/s-1",
        branch: "feature/demo-7-do-the-thing",
        at: NOW,
      });
      await live.store.putHandBack({ project: "widgets", ticket: "DEMO-7", author: null, body: "PR #9", at: NOW });
      await live.store.addInboxItem({
        project: "widgets",
        ticket: "DEMO-7",
        kind: "question",
        recipient: "coordinator",
        author: null,
        body: "A remaining question",
        at: NOW,
      });
      if (mode === "refreshed-hand-back")
        s.forge.onCompare = async () => {
          s.forge.onCompare = null;
          s.linear.post(
            "DEMO-7",
            `Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green; more PRs: the dashboard part`,
            "2026-03-04T09:45:00Z",
          );
        };
      if (mode === "keep-open") s.forge.pr.headRef = "feature/demo-7";
      await live.store.recordEvent({
        project: "widgets",
        ticket: "DEMO-7",
        kind: "report",
        phase: mode === "keep-open" ? "implementing" : "ready-to-merge",
        message: "PR #9 ready",
        prUrl: s.forge.pr.url,
        headSha: HEAD,
        at: NOW,
      });
      const closed = mode === "close";
      // Linear's GitHub automation can complete the issue after the first repair.
      s.ctx.sleep = async (ms) => {
        s.sleeps.push(ms);
        s.linear.get("DEMO-7").statusType = "completed";
        s.linear.get("DEMO-7").stateId = "st-done";
      };
      const readFor: (string | null)[] = [];
      const afterRead = s.ctx.afterRead;
      s.ctx.afterRead = async (ticket) => {
        readFor.push(ticket);
        return afterRead(ticket);
      };
      const out = await mergePullRequest(s.ctx, { pr: 9, keepOpen: mode === "keep-open", close: closed });
      expect(s.forge.merges).toEqual([{ number: 9, sha: HEAD }]);
      expect(s.linear.get("DEMO-7").statusType).toBe(closed ? "completed" : "started");
      expect(s.linear.get("DEMO-7").labels.map((l) => l.name)).toEqual(closed ? [] : ["Conductor", "implementing"]);
      expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(
        closed ? NOW.toISOString() : null,
      );
      const items = await live.store.openInboxItems({ project: "widgets", recipient: "coordinator" });
      expect(items.map((i) => i.kind)).toEqual(closed ? [] : ["question"]);
      expect(live.store.events.map((e) => [e.kind, e.phase])).toEqual([
        ["report", mode === "keep-open" ? "implementing" : "ready-to-merge"],
        [closed ? "merge" : "report", closed ? "merged" : "implementing"],
      ]);
      expect(readFor).toEqual([closed ? "DEMO-7" : null]);
      if (!closed) {
        expect(out.archive).toBeNull();
        expect(out.keepOpen).toBe(true);
        expect(out.continuation?.message).toContain(
          `git fetch origin && git switch -c ${mode === "keep-open" ? "feature/demo-7-2" : "feature/demo-7-do-the-thing-2"} origin/main`,
        );
        expect(out.continuation?.claim?.releasedAt).toBeNull();
        expect(s.linear.get("DEMO-7").comments[0]?.status?.summary).toContain("next:");
        // A fresh hand-back without more PRs completes the same ticket.
        s.linear.get("DEMO-7").labels = [label("rt-conductor"), label("phase-ready-to-merge")];
        s.linear.post(
          "DEMO-7",
          `Agent status: ready-to-merge — PR #10, head ${HEAD}, CI green`,
          "2026-03-04T10:30:00Z",
        );
        s.forge.pr = pull({ number: 10, url: "https://github.com/acme/widgets/pull/10" });
        await live.store.putHandBack({ project: "widgets", ticket: "DEMO-7", author: null, body: "PR #10", at: NOW });
        const final = await mergePullRequest(s.ctx, { pr: 10 });
        expect(final.keepOpen).toBeFalsy();
        expect(s.linear.get("DEMO-7").statusType).toBe("completed");
        expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
        expect(live.store.events.map((e) => e.kind)).toEqual(["report", "report", "merge"]);
      }
    },
  );
  test.each([
    { keepOpen: true, close: true },
    { keepOpen: true, noTicket: true },
    { close: true, noTicket: true },
  ])("refuses conflicting intent %j before writing", async (intent) => {
    const s = setup();
    expect(await refusal(mergePullRequest(s.ctx, { pr: 9, ...intent }))).toContain("cannot go together");
    expect(s.forge.merges).toEqual([]);
    expect(s.linear.writes).toEqual([]);
  });
});

test("a hold override survives Linear failure and unreadable audit until finish can post it once", async () => {
  let unreadable = false;
  const live = tempFleet({
    fail: (op) => (unreadable && op === "inbox/ticket" ? new Error("Armada unavailable") : null),
  });
  const s = setup({ live });
  const hold = await live.fleet.openHold({ kind: "manual", reason: "Deploy failure" });
  const update = s.linear.updateTicket.bind(s.linear);
  s.linear.updateTicket = async () => {
    throw new LinearError("HTTP 503", true, true);
  };
  expect(await mergePullRequest(s.ctx, { pr: 9, throughHold: "Fix deploy" })).toMatchObject({
    merged: true,
    linearPending: true,
  });
  const pending = (await live.fleet.ticketItems("DEMO-7")).find((i) => i.kind === "linear-pending");
  expect(pending?.body).toContain(`Merge audit: merged through hold #${hold.id}: Fix deploy`);
  s.linear.updateTicket = update;
  unreadable = true;
  expect(await finishMerge(s.ctx, { pr: 9 })).toMatchObject({ linearPending: true, armadaPending: true });
  expect(s.linear.writes).toEqual([]);
  unreadable = false;
  expect((await live.fleet.ticketItems("DEMO-7")).find((i) => i.kind === "linear-pending")?.body).toBe(pending?.body);
  const fleet = s.ctx.fleet;
  s.ctx.fleet = async () => ({ fleet: null, warning: "Armada unavailable" });
  expect(await finishMerge(s.ctx, { pr: 9 })).toMatchObject({ linearPending: true, armadaPending: true });
  expect(s.linear.writes).toEqual([]);
  s.ctx.fleet = async () => {
    throw new Error("Armada unavailable");
  };
  expect(await finishMerge(s.ctx, { pr: 9 })).toMatchObject({ linearPending: true, armadaPending: true });
  expect(s.linear.writes).toEqual([]);
  s.ctx.fleet = fleet;
  expect((await finishMerge(s.ctx, { pr: 9 })).linearPending).toBe(false);
  expect(s.linear.bodies).toHaveLength(1);
  expect(s.linear.bodies[0]).toContain(`merged through hold #${hold.id}: Fix deploy`);
  expect((await finishMerge(s.ctx, { pr: 9 })).linearPending).toBe(false);
  expect(s.linear.bodies).toHaveLength(1);
  expect(await live.fleet.holds()).toHaveLength(1);
});

test("after merge selects declared deploy targets by base branch, including no-ticket merges", async () => {
  const text = `${GATES}\n[[deploy.target]]\nname = "api"\ngithub_environment = "production"\n[[deploy.target]]\nname = "docs"\nbranch = "docs"\nlive_sha_command = "version"\n`;
  for (const input of [{}, { noTicket: true, reason: "deploy test" }, { keepOpen: true }]) {
    const s = setup({ toml: text });
    const outcome = await mergePullRequest(s.ctx, { pr: 9, ...input });
    expect(outcome.deploy).toEqual({ targets: ["api"] });
    expect(outcome.pr.mergeCommit).toBe(SQUASH);
  }
  expect((await mergePullRequest(setup().ctx, { pr: 9 })).deploy).toBeNull();
  expect((await mergePullRequest(setup({ toml: text }).ctx, { pr: 9, dryRun: true })).deploy).toBeUndefined();
});
