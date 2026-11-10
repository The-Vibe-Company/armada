import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecRequest, type ExecResult, ProviderError } from "../src/provider.ts";
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
  // Exercise the real collector on Linux with neither Python nor OpenSSL in PATH.
  const bin = join(home, ".collector-bin");
  await mkdir(bin);
  for (const tool of ["git", "bun"]) {
    const executable = Bun.which(tool);
    if (!executable) throw new Error(`Missing test prerequisite: ${tool}`);
    await symlink(executable, join(bin, tool));
  }
  expect(Bun.which("python3", { PATH: bin })).toBeNull();
  const provider = {
    async exec(request: ExecRequest): Promise<ExecResult> {
      const process = Bun.spawn(["/bin/bash", "-c", request.command], {
        env: { ...processEnv(), HOME: home, PATH: bin },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(process.stdout).text();
      const stderr = await new Response(process.stderr).text();
      return {
        detached: false,
        exitCode: await process.exited,
        stdout: stdout.slice(0, 65536),
        stderr,
        timedOut: false,
        truncated: stdout.length > 65536,
      };
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
  // Published history larger than the cap must not enter the recovery bundle.
  await writeFile(join(repo, "published-history"), randomBytes(3 * 1024 * 1024));
  await run(["git", "add", "."], repo);
  await run(["git", "commit", "-qm", "large published base"], repo);
  await run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  const base = (await run(["git", "rev-parse", "HEAD"], repo)).trim();
  const restored = join(home, "restored");
  await run(["git", "clone", "-q", repo, restored], home);
  const hidden = join(home, ".tools");
  await mkdir(hidden);
  await run(["git", "clone", "-q", repo, join(hidden, "plugin")], home);
  await run(["git", "update-ref", "-d", "refs/remotes/origin/main"], join(hidden, "plugin"));
  // A remote which cannot authenticate must not affect local-only preservation.
  await run(["git", "remote", "add", "origin", "https://example.invalid/expired-authorization/repo.git"], repo);
  await writeFile(join(repo, "tracked"), "committed\n");
  await run(["git", "commit", "-qam", "unpushed"], repo);
  const head = (await run(["git", "rev-parse", "HEAD"], repo)).trim();
  await writeFile(join(repo, "tracked"), "staged\n");
  await run(["git", "add", "tracked"], repo);
  await writeFile(join(repo, "tracked"), "unstaged\n");
  await writeFile(join(repo, "new-file"), "untracked\n");
  const longName = "long-" + "x".repeat(120);
  await writeFile(join(repo, longName), "long path\n");
  await symlink(longName, join(repo, "link"));
  const rawTarget = Buffer.from([0xff]);
  await symlink(rawTarget, join(repo, "raw-link"));
  const result = await preserveWork(provider, "sandbox");
  expect(result.status).toBe("preserved");
  if (result.status !== "preserved") throw new Error("Expected archive");
  const recovery = join(home, "recovered");
  await mkdir(recovery);
  const archive = join(home, "archive.tar");
  await writeFile(archive, Buffer.from(result.archive, "base64"));
  await run(["tar", "xf", archive], recovery);
  const bundle = join(recovery, "repo-0", "commits.bundle");
  await run(["git", "checkout", "-q", "--detach", base], restored);
  await run(["git", "fetch", "-q", bundle, "HEAD"], restored);
  await run(["git", "checkout", "-q", "--detach", "FETCH_HEAD"], restored);
  expect((await run(["git", "rev-parse", "HEAD"], restored)).trim()).toBe(head);
  await run(["git", "apply", "--index", join(recovery, "repo-0", "index.patch")], restored);
  await run(["git", "apply", join(recovery, "repo-0", "worktree.patch")], restored);
  expect(await readFile(join(restored, "tracked"), "utf8")).toBe("unstaged\n");
  expect(await run(["git", "show", ":tracked"], restored)).toBe("staged\n");
  expect(await readFile(join(recovery, "repo-0", "untracked", "new-file"), "utf8")).toBe("untracked\n");
  expect(await readFile(join(recovery, "repo-0", "untracked", longName), "utf8")).toBe("long path\n");
  expect(await readlink(join(recovery, "repo-0", "untracked", "link"))).toBe(longName);
  expect(await readlink(join(recovery, "repo-0", "untracked", "raw-link"), { encoding: "buffer" })).toEqual(rawTarget);
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

test("archives larger than the runtime stdout cap are recovered through bounded chunks", async () => {
  const { repo, provider } = await fixture();
  const original = Buffer.alloc(256 * 1024, 97);
  await writeFile(join(repo, "larger-than-stdout"), original);
  const responses: string[] = [];
  const inspected = {
    async exec(request: ExecRequest) {
      const result = await provider.exec(request);
      if (!result.detached) responses.push(result.stdout);
      return result;
    },
  };
  const result = await preserveWork(inspected, "sandbox");
  expect(result.status).toBe("preserved");
  if (result.status !== "preserved") throw new Error("Expected archive");
  expect(Buffer.from(result.archive, "base64").includes(original)).toBe(true);
  const refusedChunks = await preserveWork(
    {
      exec: async (request) => {
        if (request.command.includes("fs.readSync(fd,data,"))
          throw new ProviderError({
            provider: "boat",
            code: "unavailable",
            status: 504,
            retryable: true,
            message: "private transport response",
            providerCode: "private code",
            details: { secret: "private body" },
          });
        return provider.exec(request);
      },
    },
    "sandbox",
  );
  expect(refusedChunks).toEqual({
    status: "failed",
    reason: "exec_failed",
    diagnostic: {
      stage: "chunk_exec",
      errorClass: "provider_unavailable",
      providerStatus: 504,
    },
  });
  // Provider-retained stdout contains ciphertext, not plaintext archive chunks.
  for (const output of responses.filter((value) => /^[A-Za-z0-9+/=]+\s*$/.test(value)))
    expect(Buffer.from(output.trim(), "base64").includes(original.subarray(0, 64))).toBe(false);
});

test("a concurrent write during bundling fails closed rather than authenticating mixed work", async () => {
  const { home, repo } = await fixture();
  await writeFile(join(repo, "tracked"), "local commit\n");
  await run(["git", "commit", "-qam", "unpushed"], repo);
  await writeFile(join(repo, "tracked"), "pending\n");
  const bin = join(home, "bin");
  await mkdir(bin);
  const realGit = (await run(["which", "git"], home)).trim();
  const wrapper = join(bin, "git");
  await writeFile(
    wrapper,
    `#!/bin/sh\ncase " $* " in *" bundle create "*) printf 'changed during capture\\n' > "$ARMADA_TEST_REPO/tracked";; esac\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );
  const raced = {
    async exec(request: ExecRequest): Promise<ExecResult> {
      const child = Bun.spawn(["bash", "-c", request.command], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ARMADA_TEST_REPO: repo },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        detached: false,
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
        timedOut: false,
        truncated: false,
      };
    },
  };
  expect(await preserveWork(raced, "sandbox")).toEqual({ status: "failed", reason: "collector_failed" });
  expect(await readFile(join(repo, "tracked"), "utf8")).toBe("changed during capture\n");
});

test("an unresolved conflict index fails closed because patches cannot restore its stages", async () => {
  const { repo, provider } = await fixture();
  await run(["git", "checkout", "-qb", "side"], repo);
  await writeFile(join(repo, "tracked"), "side\n");
  await run(["git", "commit", "-qam", "side"], repo);
  await run(["git", "checkout", "-q", "-"], repo);
  await writeFile(join(repo, "tracked"), "main\n");
  await run(["git", "commit", "-qam", "main"], repo);
  const merge = Bun.spawn(["git", "merge", "side"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  expect(await merge.exited).toBe(1);
  expect(await preserveWork(provider, "sandbox")).toEqual({ status: "failed", reason: "collector_failed" });
});

test("collector failures are closed and provider output never becomes a reason", async () => {
  const providerError = new ProviderError({
    provider: "boat",
    code: "unavailable",
    status: 502,
    retryable: true,
    message: "PRIVATE_MESSAGE",
    providerCode: "PRIVATE_CODE",
    details: { secret: "PRIVATE_BODY" },
  });
  for (const [error, errorClass, providerStatus] of [
    [new Error("PRIVATE_MESSAGE"), "unexpected", null],
    [providerError, "provider_unavailable", 502],
    [
      Object.assign(new ProviderError({ provider: "boat", code: "unknown", retryable: false, message: "PRIVATE" }), {
        code: "PRIVATE_CODE",
        status: 9000,
      }),
      "provider_unknown",
      null,
    ],
    [Object.assign(new Error("PRIVATE_MESSAGE"), { name: "TimeoutError" }), "timeout", null],
  ] as const) {
    expect(
      await preserveWork(
        {
          exec: async () => {
            throw error;
          },
        },
        "sandbox",
      ),
    ).toEqual({
      status: "failed",
      reason: "exec_failed",
      diagnostic: { stage: "collect_exec", errorClass, providerStatus },
    });
  }
  for (const [output, expected] of [
    [{ exitCode: 127 }, "collector_exit"],
    [{ exitCode: 137 }, "collector_signal"],
    [{ truncated: true }, "output_truncated"],
    [{ stdout: "private invalid output" }, "output_invalid"],
    [{ stdout: '{"status":"failed","reason":"private data"}' }, "output_invalid"],
    ...(["missing_git", "missing_bun", "missing_openssl", "size_limit", "timeout"] as const).map(
      (reason) => [{ stdout: JSON.stringify({ status: "failed", reason }) }, reason] as const,
    ),
  ] as const) {
    expect(
      await preserveWork(
        {
          async exec() {
            return Object.assign(
              {
                detached: false as const,
                exitCode: 0,
                stdout: "",
                stderr: "private error",
                timedOut: false,
                truncated: false,
              },
              output,
            );
          },
        },
        "sandbox",
      ),
    ).toEqual({ status: "failed", reason: expected });
  }
});
