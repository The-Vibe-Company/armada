import { expect, test } from "bun:test";
import { join } from "node:path";
import { pushLedgerInstall } from "@armada/core";
import { readPushEvidence } from "../src/sandbox-pull-requests.ts";
import {
  launch,
  lostConfirmation,
  recreatedAtFetchedCommit,
  rejectedRecreation,
  sh,
  tempRoot,
  unrecordedUrlPush,
} from "./push-ledger-git.ts";

test("push evidence survives a pruned tracking ref and reports pushes that escaped the ledger", () => {
  const { root, push, read, prune } = launch();
  const first = push("first");
  const second = push("second");
  // Someone else's branch arrives by fetch: not this sandbox's push.
  sh(root, "git -C remote.git branch other second");
  prune("first");
  expect(read()).toBe(`second\t${second}\nfirst\t${first}\n`);
  // A push that escaped the ledger makes coverage unprovable.
  push("third", "-c core.hooksPath=/nonexistent");
  expect(read().split("\n")).toContain("!untracked");
});

test.each(["reference-transaction", "pre-push"])(
  "a missing %s hook is reported, kept in the ledger and restored",
  (hook) => {
    const { work, push, read } = launch();
    const first = push("first");
    sh(work, `rm "$(git rev-parse --git-path hooks)/${hook}"`);
    expect(read()).toBe(`!unproven\n!untracked\nfirst\t${first}\n`);
    // The hook is back, but the interval it missed stays unproven.
    expect(read()).toBe(`!untracked\nfirst\t${first}\n`);
  },
);

test("a push the ledger cannot attribute leaves a gap even after its tracking ref is pruned", () => {
  for (const path of ["url", "remote", "no reflog, no verify", "narrow refspec"] as const) {
    const { work, push, read, prune } = launch();
    push("merged");
    if (path === "url") push("escaped", "", "../remote.git");
    if (path === "remote") push("escaped", `-c remote.mirror.url=../remote.git`, "mirror");
    // Without the pre-push attempt, an update with no reflog entry is indistinguishable from a fetch.
    if (path === "no reflog, no verify") push("escaped", "-c core.logAllRefUpdates=false", "--no-verify origin");
    if (path === "narrow refspec") {
      sh(work, "git config --local --replace-all remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'");
      push("escaped");
    }
    if (path === "no reflog, no verify") prune("escaped");
    expect([path, read().split("\n")[0]]).toEqual([path, "!untracked"]);
  }
});

test("a push while the hooks were displaced is reported before the reader restores them", () => {
  const { work, push, read, prune } = launch();
  const merged = push("merged");
  sh(work, "mkdir .husky && git config --local core.hooksPath .husky");
  const closed = push("closed");
  prune("closed");
  // The first read reports the loss and reinstalls the hooks in the new path.
  // A later read (say the first scan was abandoned) still reports it.
  expect(read()).toBe(`!unproven\n!untracked\n^\t${closed}\nmerged\t${merged}\n`);
  expect(read()).toBe(`!untracked\n^\t${closed}\nmerged\t${merged}\n`);
  // Fetches and maintenance after the reinstall add no false gap of their own.
  const fresh = launch();
  fresh.push("merged");
  sh(fresh.root, "git -C remote.git branch other merged");
  sh(
    fresh.work,
    "git push -q origin HEAD:refs/heads/main && git fetch -q origin && git pull -q --rebase origin main && git remote set-head origin -a >/dev/null && git gc -q",
  );
  expect(fresh.read().split("\n")).not.toContain("!untracked");
});

test("the repository's own hooks keep running, with their input and exit status, beside the ledger", () => {
  const root = tempRoot();
  sh(root, "git init -q --bare -b main remote.git && git clone -q remote.git work 2>/dev/null");
  const work = join(root, "work");
  // A configured hooks directory with executable hooks already present at launch.
  sh(
    work,
    `mkdir .githooks && git config --local core.hooksPath .githooks && for hook in pre-push reference-transaction pre-commit; do
       printf '#!/bin/sh\\necho "$0 $*" >>"$(git rev-parse --git-common-dir)/ran-$(basename "$0")"; cat >>"$(git rev-parse --git-common-dir)/ran-$(basename "$0")"\\nexit $(cat "$(git rev-parse --git-common-dir)/fail" 2>/dev/null || echo 0)\\n' >.githooks/$hook && chmod +x .githooks/$hook
     done && git add .githooks && git commit -q -m hooks && git config --local --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && ${pushLedgerInstall}`,
  );
  // The repository's own hooks are untouched: the work tree stays clean.
  expect(sh(work, "git status --porcelain")).toBe("");
  const sha = sh(
    work,
    "git commit -q --allow-empty -m topic && git push -q origin HEAD:refs/heads/topic && git rev-parse HEAD",
  ).trim();
  const ran = (hook: string) => sh(work, `cat .git/ran-${hook}`);
  expect(ran("pre-commit")).toContain(".githooks/pre-commit");
  expect(ran("pre-push")).toContain(`refs/heads/topic ${"0".repeat(40)}`);
  expect(ran("reference-transaction")).toContain(`committed\n${"0".repeat(40)} ${sha} refs/remotes/origin/topic`);
  // A normal push leaves clean evidence: the shape that reaches merge-stop admission.
  const read = () => sh(work, `set -- 0; ${readPushEvidence}`);
  expect(read()).toBe(`topic\t${sha}\n`);
  // A refusing hook still refuses the push, and the refused push is not recorded.
  // The refused commit stays local: uncovered work.
  const refused = sh(work, "git commit -q --allow-empty -m refused && echo 1 >.git/fail && git rev-parse HEAD").trim();
  expect(() => sh(work, "git push -q origin HEAD:refs/heads/refused")).toThrow();
  expect(() => sh(work, "git commit -q --allow-empty -m blocked")).toThrow();
  sh(work, "rm .git/fail");
  expect(read()).toBe(`^\t${refused}\ntopic\t${sha}\n`);
});

test("recreating a deleted branch at the SHA its tracking ref still holds is recorded", () => {
  const { root, work, read } = launch();
  sh(root, "git clone -q remote.git other 2>/dev/null");
  const other = join(root, "other");
  const sha = sh(
    other,
    "git commit -q --allow-empty -m topic && git push -q origin HEAD:refs/heads/topic && git rev-parse HEAD",
  ).trim();
  sh(work, "git fetch -q origin && git checkout -q -b topic origin/topic");
  sh(other, "git push -q origin :topic");
  // The tracking ref already holds the SHA, so the push writes no reflog entry.
  expect(sh(work, "git push origin topic:refs/heads/topic 2>&1")).toContain("[new branch]");
  expect(sh(work, "git reflog show --format=%gs refs/remotes/origin/topic")).not.toContain("update by push");
  expect(read()).toBe(`topic\t${sha}\n`);
});

test("a push the remote rejects is an unconfirmed attempt, never push evidence", () => {
  const { fresh, stdout, sha } = rejectedRecreation();
  // In flight until proven otherwise, then reported apart from confirmed pushes.
  expect(fresh).toBe(`!pending\n^\t${sha}\n?\ttopic\t${sha}\n`);
  expect(stdout).toBe(`^\t${sha}\n?\ttopic\t${sha}\n`);
});

test("confirmed pushes keep their chronological order across both evidence sources", () => {
  const { stdout, first, second } = recreatedAtFetchedCommit();
  // The remote ended at the second push: it comes first.
  expect(stdout).toBe(`topic\t${second}\ntopic\t${first}\n`);
});

test("a verified push is confirmed by its tracking update even without a reflog entry", () => {
  const { read, prune, push } = launch();
  const sha = push("topic", "-c core.logAllRefUpdates=false");
  prune("topic");
  expect(read()).toBe(`topic\t${sha}\n`);
});

test("an accepted push whose tracking update failed stays unresolved; a later confirmed push supersedes it", () => {
  const { stdout, first, second } = lostConfirmation();
  expect(stdout).toBe(`^\t${second}\ntopic\t${first}\n?\ttopic\t${second}\n`);
  // A rejected attempt followed by a confirmed push to the same branch.
  const { root, work, push, read } = launch();
  sh(
    root,
    "git clone -q remote.git other 2>/dev/null && git -C other commit -q --allow-empty -m x && git -C other push -q origin HEAD:refs/heads/topic",
  );
  const rejected = sh(work, "git commit -q --allow-empty -m a && git rev-parse HEAD").trim();
  expect(() => sh(work, "git push -q origin HEAD:refs/heads/topic")).toThrow();
  const accepted = push("topic", "", "-f origin");
  expect(read()).toBe(`topic\t${accepted}\n~\ttopic\t${rejected}\n`);
});

test("local work no confirmed push carries withholds coverage, even after a push that skipped every hook", () => {
  const { stdout, first, second } = unrecordedUrlPush();
  // Discovery cannot see the escaped push, but its commit is still on a local branch.
  expect(stdout).toBe(`^\t${second}\ntopic\t${first}\n`);
  expect(stdout).not.toContain("escaped");
  // Ordinary work is covered: a branch pushed through origin, and the launch
  // branch as fetched, even when it moved past the launch.
  const { root, work, push } = launch();
  sh(root, "git clone -q remote.git other 2>/dev/null");
  sh(join(root, "other"), "git commit -q --allow-empty -m base && git push -q origin HEAD:refs/heads/main");
  sh(work, "git pull -q origin main && git checkout -q -b topic");
  const topic = push("topic");
  sh(join(root, "other"), "git commit -q --allow-empty -m later && git push -q origin HEAD:refs/heads/main");
  sh(work, "git checkout -q main && git pull -q origin main");
  expect(sh(work, `set -- 0 x main; ${readPushEvidence}`)).toBe(`topic\t${topic}\n`);
  const read = () => sh(work, `set -- 0 x main; ${readPushEvidence}`);
  // So is a reviewer commit pulled into the pushed branch (fail-safe: the
  // stop waits, as for a PR whose head someone else moved).
  const reviewed = sh(
    root,
    "git -C other fetch -q origin topic && git -C other checkout -q FETCH_HEAD && git -C other commit -q --allow-empty -m review && git -C other push -q origin HEAD:refs/heads/topic && git -C other rev-parse HEAD",
  ).trim();
  sh(work, "git checkout -q topic && git pull -q origin topic && git checkout -q main");
  expect(read()).toBe(`^\t${reviewed}\ntopic\t${topic}\n`);
  // A detached commit pushed by URL past the hooks and then left behind, and
  // one in another worktree, are both still local work.
  sh(work, "git branch -q -f topic " + topic);
  const left = sh(work, "git checkout -q --detach && git commit -q --allow-empty -m left && git rev-parse HEAD").trim();
  sh(work, `git push -q --no-verify file://${join(root, "remote.git")} HEAD:refs/heads/left && git checkout -q main`);
  const away = sh(
    work,
    "git worktree add -q --detach ../wt && git -C ../wt commit -q --allow-empty -m away && git -C ../wt rev-parse HEAD",
  ).trim();
  expect(read()).toBe(`^\t${away}\n^\t${left}\ntopic\t${topic}\n`);
});
