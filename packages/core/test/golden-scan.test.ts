import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecRequest, ExecResult, Provider } from "../src/server.ts";
import { scanGoldenSandbox } from "../src/server.ts";

function provider(result: Partial<ExecResult>, calls: ExecRequest[]): Provider {
  return {
    exec: async (request: ExecRequest) => {
      calls.push(request);
      return { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...result };
    },
  } as unknown as Provider;
}

async function capturedScript(): Promise<string> {
  const calls: ExecRequest[] = [];
  await scanGoldenSandbox(provider({ exitCode: 0 }, calls), "bx_1");
  const command = calls[0]?.command;
  if (!command) throw new Error("the scan did not run a command");
  return command;
}

test("execs one bounded, foreground command in the sandbox", async () => {
  const calls: ExecRequest[] = [];
  await scanGoldenSandbox(provider({ exitCode: 0 }, calls), "bx_1");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.sandboxId).toBe("bx_1");
  expect(calls[0]?.command).toContain("gh[oprsu]_");
  expect(calls[0]?.command).toContain("cat-file --batch-all-objects");
  expect(calls[0]?.timeoutSeconds).toBeGreaterThan(0);
});

test("a leaked token fails closed without the match ever appearing in the error", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ exitCode: 97 }, calls), "bx_1")).rejects.toThrow("token-shaped material");
});

test("any other failure (the scan itself could not run) also stops the build, distinctly from a hit", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ exitCode: 95 }, calls), "bx_1")).rejects.toThrow("could not run");
});

test("a timeout and a background command both stop the build", async () => {
  const calls: ExecRequest[] = [];
  await expect(scanGoldenSandbox(provider({ timedOut: true }, calls), "bx_1")).rejects.toThrow("timed out");
  await expect(
    scanGoldenSandbox({ exec: async () => ({ detached: true, processId: 1 }) } as unknown as Provider, "bx_1"),
  ).rejects.toThrow("background");
});

/** Runs the exact generated script against isolated scratch roots instead of the real filesystem. */
function runAgainst(script: string, roots: { home: string; root: string; tmp: string }): { status: number } {
  const isolated = script.replace("roots='/home/user /root /tmp'", `roots='${roots.home} ${roots.root} ${roots.tmp}'`);
  expect(isolated).not.toBe(script);
  const result = spawnSync("bash", ["-c", isolated], { encoding: "utf8" });
  return { status: result.status ?? -1 };
}

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "armada-scan-"));
  const roots = { home: join(base, "home"), root: join(base, "root"), tmp: join(base, "tmp") };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  return { base, roots };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

test("real shell: a clean sandbox passes", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    expect(runAgainst(script, roots).status).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: short, underscore-separated placeholders (test fixtures) do not trip the scan", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    writeFileSync(
      join(roots.home, "fixtures.ts"),
      ['const a = "ghs_test_secret";', 'const b = "ghu_caller_access_token";', ""].join("\n"),
    );
    expect(runAgainst(script, roots).status).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: a realistically-shaped token in a plain file fails the build", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    writeFileSync(join(roots.tmp, "leak.env"), `GH_TOKEN=ghp_${"A".repeat(36)}\n`);
    expect(runAgainst(script, roots).status).toBe(97);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: a token in .git/config is rejected without printing the token", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const token = `ghp_${"C".repeat(36)}`;
    writeFileSync(join(repo, ".git", "config"), `[core]\nrepositoryformatversion = 0\n# ${token}\n`);
    const result = spawnSync("bash", ["-c", script.replace("roots='/home/user /root /tmp'", `roots='${roots.home} ${roots.root} ${roots.tmp}'`)], { encoding: "utf8" });
    expect(result.status).toBe(97);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("real shell: a token in a commit message is rejected without printing it", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo"); mkdirSync(repo); git(repo, "init", "-q");
    git(repo, "config", "user.email", "a@b.com"); git(repo, "config", "user.name", "a");
    writeFileSync(join(repo, "f"), "ok\n"); git(repo, "add", "f");
    const token = `gho_${"D".repeat(36)}`;
    git(repo, "commit", "-qm", `message ${token}`);
    const isolated = script.replace("roots='/home/user /root /tmp'", `roots='${roots.home} ${roots.root} ${roots.tmp}'`);
    const result = spawnSync("bash", ["-c", isolated], { encoding: "utf8" });
    expect(result.status).toBe(97);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("real shell: a token in a dangling (amended-away, not yet gc'd) git blob still fails the build", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "a@b.com");
    git(repo, "config", "user.name", "a");
    writeFileSync(join(repo, "f.txt"), "hello\n");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "first");
    writeFileSync(join(repo, "secret.txt"), `GH_TOKEN=ghu_${"B".repeat(36)}\n`);
    git(repo, "add", "secret.txt");
    git(repo, "commit", "-qm", "oops");
    git(repo, "reset", "--hard", "HEAD~1", "-q");
    // Reachable history (what "git log" would see) no longer mentions the secret commit at all.
    const log = spawnSync("git", ["log", "--oneline", "--all"], { cwd: repo, encoding: "utf8" });
    expect(log.stdout).not.toContain("oops");
    expect(runAgainst(script, roots).status).toBe(97);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("real shell: a corrupted git object fails closed instead of being silently skipped", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "a@b.com");
    git(repo, "config", "user.name", "a");
    writeFileSync(join(repo, "f.txt"), "hello\n");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "first");
    writeFileSync(join(repo, "g.txt"), "world\n");
    git(repo, "add", "g.txt");
    git(repo, "commit", "-qm", "second");
    const list = spawnSync("bash", ["-c", `find '${repo}/.git/objects' -type f | grep -v pack | head -1`], {
      encoding: "utf8",
    });
    const objectFile = list.stdout.trim();
    expect(objectFile).not.toBe("");
    chmodSync(objectFile, 0o644);
    writeFileSync(objectFile, "garbage-not-a-valid-zlib-stream");
    const result = runAgainst(script, roots);
    // 95: the scan itself could not run to completion. Never 0 (silently clean) and never 97
    // (that code means a token was actually found, which this is not).
    expect(result.status).toBe(95);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
