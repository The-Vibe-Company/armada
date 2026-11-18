import { afterEach, expect } from "bun:test";
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
export const sh = (cwd: string, command: string) => {
  const result = Bun.spawnSync(["sh", "-c", command], { cwd, env });
  if (result.exitCode !== 0) throw Error(result.stderr.toString());
  return result.stdout.toString();
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
export function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "armada-push-ledger-"));
  roots.push(root);
  return root;
}
// A launch clone: wide tracking refspec and the ledger hooks installed.
export function launch() {
  const root = tempRoot();
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
  // A second clone of the same remote: someone else's pushes.
  const other = () => {
    sh(root, "git clone -q remote.git other 2>/dev/null");
    return join(root, "other");
  };
  return { root, work, push, read, prune, other };
}

/**
 * Someone else pushed `topic`, its PR merged and the branch was deleted. The
 * sandbox fetched it earlier and tries to recreate it at that head, but the
 * remote rejects the push. Returns the reader output once the attempt is older
 * than the in-flight window, and the merged head.
 */
export function rejectedRecreation() {
  const { root, work, read, other } = launch();
  const clone = other();
  const sha = sh(
    clone,
    "git commit -q --allow-empty -m topic && git push -q origin HEAD:refs/heads/topic && git rev-parse HEAD",
  ).trim();
  sh(work, "git fetch -q origin && git checkout -q -b topic origin/topic");
  sh(clone, "git push -q origin :topic");
  sh(root, "printf '#!/bin/sh\\nexit 1\\n' >remote.git/hooks/pre-receive && chmod +x remote.git/hooks/pre-receive");
  expect(() => sh(work, "git push -q origin topic:refs/heads/topic")).toThrow();
  const fresh = read();
  // Backdate the attempt past the in-flight window.
  sh(
    work,
    `ledger="$(git rev-parse --git-common-dir)/armada-pushes" && sed -i 's/^[0-9]*\\t!push/1\\t!push/' "$ledger"`,
  );
  return { fresh, stdout: read(), sha };
}

/**
 * The sandbox pushed `topic` at A, then fetched B from another clone and,
 * after `topic` was deleted remotely, recreated it at B. Returns the reader
 * output and both heads.
 */
export function recreatedAtFetchedCommit() {
  const { work, push, read, other } = launch();
  const first = push("topic");
  const clone = other();
  const second = sh(
    clone,
    "git fetch -q origin topic && git checkout -q -b topic FETCH_HEAD && git commit -q --allow-empty -m b && git push -q origin topic && git rev-parse HEAD",
  ).trim();
  sh(work, "git fetch -q origin && git checkout -q -B topic origin/topic");
  sh(clone, "git push -q origin :topic");
  expect(sh(work, "git push origin topic:refs/heads/topic 2>&1")).toContain("[new branch]");
  return { stdout: read(), first, second };
}

/**
 * The remote accepted a push of `topic` at B, but the tracking ref was locked,
 * so Git could not confirm it (and still exited 0). Returns the reader output
 * once the attempt is older than the in-flight window, the earlier confirmed
 * push A and B.
 */
export function lostConfirmation() {
  const { work, push, read } = launch();
  const first = push("topic");
  sh(work, "touch .git/refs/remotes/origin/topic.lock");
  const second = push("topic");
  sh(work, "rm .git/refs/remotes/origin/topic.lock");
  expect(sh(work, "git ls-remote origin refs/heads/topic")).toStartWith(second);
  sh(
    work,
    `ledger="$(git rev-parse --git-common-dir)/armada-pushes" && sed -i 's/^[0-9]*\\t!push/1\\t!push/' "$ledger"`,
  );
  return { stdout: read(), first, second };
}

/**
 * The sandbox pushed `topic` through `origin`, then pushed `escaped` to the
 * same remote by explicit URL with --no-verify: no hook ran and no tracking
 * ref moved, so the ledger never saw it. A later fetch brings `escaped` back as
 * someone else's branch would. Returns the reader output and `topic`'s head.
 */
export function unrecordedUrlPush() {
  const { root, work, push, read } = launch();
  const first = push("topic");
  sh(work, "git checkout -q -b escaped");
  // Spelled differently from origin's URL: Git 2.56 (unlike 2.39) treats a push to
  // the exact URL of a configured remote as a push to it, moving its tracking
  // refs, so the ledger would record it. A GitHub sandbox escapes the same way
  // with an https URL against an ssh origin.
  const second = push("escaped", "", `--no-verify file://${join(root, "remote.git")}`);
  expect(sh(work, "git ls-remote origin refs/heads/escaped")).toStartWith(second);
  sh(work, "git checkout -q main && git fetch -q origin");
  return { stdout: read(), first, second };
}
