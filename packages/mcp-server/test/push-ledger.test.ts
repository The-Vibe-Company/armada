import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushLedgerInstall } from "@armada/core";
import { readPushEvidence } from "../src/sandbox-pull-requests.ts";

// The ledger and its reader are shell run inside the sandbox; only real Git proves them.
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "a",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "a",
  GIT_COMMITTER_EMAIL: "a@example.com",
};
const sh = (cwd: string, command: string) => {
  const result = Bun.spawnSync(["sh", "-c", command], { cwd, env });
  if (result.exitCode !== 0) throw Error(result.stderr.toString());
  return result.stdout.toString();
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// A launch clone: wide tracking refspec and the ledger hooks installed.
function launch() {
  const root = mkdtempSync(join(tmpdir(), "armada-push-ledger-"));
  roots.push(root);
  sh(root, "git init -q --bare -b main remote.git && git clone -q remote.git work 2>/dev/null");
  const work = join(root, "work");
  sh(
    work,
    `git config --local --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && ${pushLedgerInstall}`,
  );
  const push = (branch: string, options = "", remote = "origin") =>
    sh(
      work,
      `git commit -q --allow-empty -m ${branch} && git ${options} push -q ${remote} HEAD:refs/heads/${branch} && git rev-parse HEAD`,
    ).trim();
  const read = () => sh(work, `set -- 0; ${readPushEvidence}`);
  // The branch's PR closed and the branch was deleted, then the sandbox pruned.
  const prune = (branch: string) => {
    sh(root, `git -C remote.git branch -D ${branch}`);
    sh(work, "git fetch -q --prune origin");
    expect(sh(work, `git for-each-ref --format='%(refname)' refs/remotes/origin/${branch}`)).toBe("");
  };
  return { root, work, push, read, prune };
}

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
    sh(work, `rm .git/hooks/${hook}`);
    expect(read()).toBe(`!unproven\n!untracked\nfirst\t${first}\n`);
    // The hook is back, but the interval it missed stays unproven.
    expect(read()).toBe(`!untracked\nfirst\t${first}\n`);
  },
);

test("a push the ledger cannot attribute leaves a gap even after its tracking ref is pruned", () => {
  for (const path of ["url", "remote", "no reflog", "narrow refspec"] as const) {
    const { work, push, read, prune } = launch();
    push("merged");
    if (path === "url") push("escaped", "", "../remote.git");
    if (path === "remote") push("escaped", `-c remote.mirror.url=../remote.git`, "mirror");
    if (path === "no reflog") push("escaped", "-c core.logAllRefUpdates=false");
    if (path === "narrow refspec") {
      sh(work, "git config --local --replace-all remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'");
      push("escaped");
    }
    if (path === "no reflog") prune("escaped");
    expect([path, read().split("\n")[0]]).toEqual([path, "!untracked"]);
  }
});

test("a push while the hooks were displaced is reported before the reader restores them", () => {
  const { work, push, read, prune } = launch();
  const merged = push("merged");
  sh(work, "mkdir .husky && git config --local core.hooksPath .husky");
  push("closed");
  prune("closed");
  // The first read reports the loss and reinstalls the hooks in the new path.
  // A later read (say the first scan was abandoned) still reports it.
  expect(read()).toBe(`!unproven\n!untracked\nmerged\t${merged}\n`);
  expect(read()).toBe(`!untracked\nmerged\t${merged}\n`);
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
