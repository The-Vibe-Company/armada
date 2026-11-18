import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dockerRepositoryCheckout } from "../src/docker-repository-checkout.ts";

test("Docker checkout leaves the requested branch reviewable against a diverged remote default", () => {
  const root = mkdtempSync(join(tmpdir(), "docker-checkout-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "checkout");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const run = (...cmd: string[]) => {
      const result = Bun.spawnSync({ cmd, env, stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const git = (...args: string[]) => run("git", "-C", source, ...args);
    run("git", "init", "--initial-branch=trunk", source);
    git("config", "uploadpack.allowFilter", "true");
    writeFileSync(join(source, "legacy.txt"), "legacy\n");
    git("add", "legacy.txt");
    git("commit", "-m", "common");
    const common = git("rev-parse", "HEAD");
    git("branch", "feature/review");
    git("rm", "legacy.txt");
    git("commit", "-m", "remove legacy on trunk");
    for (let n = 0; n < 4; n++) git("commit", "--allow-empty", "-m", `trunk ${n}`);
    const defaultTip = git("rev-parse", "HEAD");
    git("switch", "feature/review");
    git("rm", "legacy.txt");
    for (let n = 0; n < 3; n++) git("commit", "--allow-empty", "-m", `feature ${n}`);
    writeFileSync(join(source, "feature.txt"), "feature\n");
    git("add", "feature.txt");
    git("commit", "-m", "feature");
    const launchTip = git("rev-parse", "HEAD");
    git("switch", "trunk");

    run(
      "bash",
      "-c",
      dockerRepositoryCheckout([{ url: pathToFileURL(source).href, branch: "feature/review", dir: "checkout" }], root),
    );
    const checkout = (...args: string[]) => run("git", "-C", destination, ...args);
    expect(checkout("merge-base", "HEAD", "origin/trunk")).toBe(common);
    expect(checkout("rev-parse", "origin/trunk")).toBe(defaultTip);
    expect(checkout("rev-parse", "HEAD", "@{upstream}").split("\n")).toEqual([launchTip, launchTip]);
    expect(checkout("diff", "--name-status", "origin/trunk...HEAD")).toBe("A\tfeature.txt\nD\tlegacy.txt");
    expect(checkout("status", "--porcelain", "--branch")).toBe("## feature/review...origin/feature/review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
