import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushLedgerInstall } from "@armada/core";
import { readPushEvidence } from "../src/sandbox-pull-requests.ts";

// The ledger and its reader are shell run inside the sandbox; only real Git proves them.
test("push evidence survives a pruned tracking ref and proves coverage only through its hook", () => {
  const root = mkdtempSync(join(tmpdir(), "armada-push-ledger-"));
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
  try {
    sh(root, "git init -q --bare -b main remote.git && git clone -q remote.git work 2>/dev/null");
    const work = join(root, "work");
    sh(work, pushLedgerInstall);
    const first = sh(
      work,
      "git commit -q --allow-empty -m one && git push -q origin HEAD:refs/heads/first && git rev-parse HEAD",
    ).trim();
    const second = sh(
      work,
      "git commit -q --allow-empty -m two && git push -q origin HEAD:refs/heads/second && git rev-parse HEAD",
    ).trim();
    // Someone else's branch arrives by fetch: not this sandbox's push.
    sh(root, "git -C remote.git branch other second");
    // The first PR closed and its branch was deleted, then the sandbox pruned.
    sh(root, "git -C remote.git branch -D first");
    sh(work, "git fetch -q --prune origin");
    expect(sh(work, "git for-each-ref --format='%(refname)' refs/remotes/origin/first")).toBe("");
    expect(sh(work, `set -- 0; ${readPushEvidence}`)).toBe(`second\t${second}\nfirst\t${first}\n`);
    // A tool such as husky replaced the hooks: no proof now, and the hook comes back.
    sh(work, "rm .git/hooks/reference-transaction");
    expect(sh(work, `set -- 0; ${readPushEvidence}`)).toBe(`!unproven\nsecond\t${second}\nfirst\t${first}\n`);
    expect(sh(work, `set -- 0; ${readPushEvidence}`)).toBe(`second\t${second}\nfirst\t${first}\n`);
    // A push that escaped the ledger makes coverage unprovable.
    sh(work, "git -c core.hooksPath=/nonexistent push -q origin HEAD:refs/heads/third");
    expect(sh(work, `set -- 0; ${readPushEvidence}`).split("\n")).toContain("!untracked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
