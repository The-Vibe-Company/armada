import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecRequest, ExecResult } from "../src/provider.ts";
import { preserveWork } from "../src/work-preservation.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
  return output;
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "armada-work-test-"));
  homes.push(home);
  const repo = join(home, "project");
  await mkdir(repo);
  await run(["git", "init", "-q"], repo);
  await run(["git", "config", "user.name", "Recovery Test"], repo);
  await run(["git", "config", "user.email", "recovery@example.invalid"], repo);
  await writeFile(join(repo, "tracked"), "base\n");
  await run(["git", "add", "tracked"], repo);
  await run(["git", "commit", "-qm", "base"], repo);
  await run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  const provider = {
    async exec(request: ExecRequest): Promise<ExecResult> {
      const process = Bun.spawn(["bash", "-c", request.command], {
        env: { ...processEnv(), HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(process.stdout).text();
      const stderr = await new Response(process.stderr).text();
      return { detached: false, exitCode: await process.exited, stdout, stderr, timedOut: false, truncated: false };
    },
  };
  return { home, repo, provider };
}
function processEnv() {
  return process.env;
}

test("a clean repository whose HEAD is on a remote ref needs no recovery artifact", async () => {
  const { provider } = await fixture();
  expect(await preserveWork(provider, "sandbox")).toEqual({ status: "clean" });
});

test("local capture recovers commits and staged, unstaged and untracked work without GitHub authorization", async () => {
  const { home, repo, provider } = await fixture();
  // A remote which cannot authenticate must not affect local-only preservation.
  await run(["git", "remote", "add", "origin", "https://example.invalid/expired-authorization/repo.git"], repo);
  await writeFile(join(repo, "tracked"), "committed\n");
  await run(["git", "commit", "-qam", "unpushed"], repo);
  const head = (await run(["git", "rev-parse", "HEAD"], repo)).trim();
  await writeFile(join(repo, "tracked"), "staged\n");
  await run(["git", "add", "tracked"], repo);
  await writeFile(join(repo, "tracked"), "unstaged\n");
  await writeFile(join(repo, "new-file"), "untracked\n");
  const result = await preserveWork(provider, "sandbox");
  expect(result.status).toBe("preserved");
  if (result.status !== "preserved") throw new Error("Expected archive");
  const recovery = join(home, "recovered");
  await mkdir(recovery);
  const archive = join(home, "archive.tar");
  await writeFile(archive, Buffer.from(result.archive, "base64"));
  await run(["tar", "xf", archive], recovery);
  const bundle = join(recovery, "repo-0", "commits.bundle");
  const restored = join(home, "restored");
  await run(["git", "clone", "-q", bundle, restored], home);
  expect((await run(["git", "rev-parse", "HEAD"], restored)).trim()).toBe(head);
  await run(["git", "apply", "--index", join(recovery, "repo-0", "index.patch")], restored);
  await run(["git", "apply", join(recovery, "repo-0", "worktree.patch")], restored);
  expect(await readFile(join(restored, "tracked"), "utf8")).toBe("unstaged\n");
  expect(await run(["git", "show", ":tracked"], restored)).toBe("staged\n");
  expect(await readFile(join(recovery, "repo-0", "untracked", "new-file"), "utf8")).toBe("untracked\n");
  expect((await run(["git", "rev-parse", "HEAD"], repo)).trim()).toBe(head);
});

test("oversized work returns a closed failure instead of a partial success", async () => {
  const { repo, provider } = await fixture();
  await writeFile(join(repo, "large"), Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(await preserveWork(provider, "sandbox")).toEqual({ status: "failed", reason: "size_limit" });
});

test("an unresponsive provider is bounded and late output cannot become success", async () => {
  const original = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  globalThis.setTimeout = ((callback: () => void) => {
    expire = callback;
    return original(() => {}, 100_000);
  }) as typeof setTimeout;
  try {
    const result = preserveWork({ exec: () => new Promise(() => {}) }, "sandbox");
    expire?.();
    expect(await result).toEqual({ status: "failed", reason: "timeout" });
  } finally {
    globalThis.setTimeout = original;
  }
});

test("an accessible remote is not modified while unpushed commits are captured", async () => {
  const { home, repo, provider } = await fixture();
  const remote = join(home, "remote.git");
  await run(["git", "init", "--bare", "-q", remote], home);
  await run(["git", "remote", "add", "origin", remote], repo);
  await run(["git", "push", "-q", "origin", "HEAD:main"], repo);
  const remoteHead = await run(["git", "rev-parse", "refs/heads/main"], remote);
  await writeFile(join(repo, "tracked"), "new commit\n");
  await run(["git", "commit", "-qam", "unpushed"], repo);
  expect((await preserveWork(provider, "sandbox")).status).toBe("preserved");
  expect(await run(["git", "rev-parse", "refs/heads/main"], remote)).toBe(remoteHead);
  expect(await run(["git", "for-each-ref", "--format=%(refname)"], remote)).toBe("refs/heads/main\n");
});

test("a staged file before the first commit can be restored", async () => {
  const { home, repo, provider } = await fixture();
  await rm(join(repo, ".git"), { recursive: true });
  await run(["git", "init", "-q"], repo);
  await run(["git", "add", "tracked"], repo);
  const result = await preserveWork(provider, "sandbox");
  expect(result.status).toBe("preserved");
  if (result.status !== "preserved") throw new Error("Expected archive");
  const recovery = join(home, "unborn");
  await mkdir(recovery);
  const archive = join(home, "unborn.tar");
  await writeFile(archive, Buffer.from(result.archive, "base64"));
  await run(["tar", "xf", archive], recovery);
  const restored = join(home, "restored");
  await mkdir(restored);
  await run(["git", "init", "-q"], restored);
  await run(["git", "apply", "--index", join(recovery, "repo-0", "index.patch")], restored);
  expect(await readFile(join(restored, "tracked"), "utf8")).toBe("base\n");
});
