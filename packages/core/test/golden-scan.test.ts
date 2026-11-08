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

test("uses non-interactive sudo for the production scan command", async () => {
  const script = await capturedScript();
  expect(script).toContain("id -u");
  expect(script).toContain("sudo -n bash -c");
  expect(script).toContain("else exec sudo");
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

/** Extracts and shell-unquotes the inner scan script from the "run as root, else sudo -n" wrapper. */
function innerScript(script: string): string {
  const payload = script.match(/then ('[\s\S]*'); else exec sudo/)?.[1];
  if (!payload) throw new Error("missing controlled sudo scan payload");
  const decoded = spawnSync("bash", ["-c", `printf %s ${payload}`], { encoding: "utf8" });
  if (decoded.status !== 0) throw new Error("could not decode scan payload");
  return decoded.stdout;
}

function withIsolatedRoots(script: string, roots: { home: string; root: string; tmp: string }): string {
  return innerScript(script).replace(
    "roots='/home/user /root /tmp'",
    `roots='${roots.home} ${roots.root} ${roots.tmp}'`,
  );
}

/** Runs the exact generated script against isolated scratch roots instead of the real filesystem. */
function runAgainst(script: string, roots: { home: string; root: string; tmp: string }): { status: number } {
  const result = spawnSync("bash", ["-c", withIsolatedRoots(script, roots)], { encoding: "utf8" });
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
}, 30_000);

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
}, 30_000);

test("real shell: a realistically-shaped token in a plain file fails the build", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    writeFileSync(join(roots.tmp, "leak.env"), `GH_TOKEN=ghp_${"A".repeat(36)}\n`);
    expect(runAgainst(script, roots).status).toBe(97);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("real shell: a token-shaped filename is rejected without printing it", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const token = `ghp_${"F".repeat(36)}`;
    writeFileSync(join(roots.tmp, token), "");
    const isolated = script.replace(
      "roots='/home/user /root /tmp'",
      `roots='${roots.home} ${roots.root} ${roots.tmp}'`,
    );
    const result = spawnSync("bash", ["-c", isolated], { encoding: "utf8" });
    expect(result.status).toBe(97);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("real shell: a token in .git/config is rejected without printing the token", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const token = `ghp_${"C".repeat(36)}`;
    writeFileSync(join(repo, ".git", "config"), `[core]\nrepositoryformatversion = 0\n# ${token}\n`);
    const result = spawnSync("bash", ["-c", withIsolatedRoots(script, roots)], { encoding: "utf8" });
    expect(result.status).toBe(97);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("real shell: a token in a commit message is rejected without printing it", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "a@b.com");
    git(repo, "config", "user.name", "a");
    writeFileSync(join(repo, "f"), "ok\n");
    git(repo, "add", "f");
    const token = `gho_${"D".repeat(36)}`;
    git(repo, "commit", "-qm", `message ${token}`);
    const result = spawnSync("bash", ["-c", withIsolatedRoots(script, roots)], { encoding: "utf8" });
    expect(result.status).toBe(97);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

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
}, 30_000);

function canDropToNobody(): boolean {
  return spawnSync("sudo", ["-n", "-u", "nobody", "true"], { encoding: "utf8" }).status === 0;
}

test.skipIf(!canDropToNobody())(
  "real shell: a root the sandbox user has no access to at all is skipped, not a false failure",
  async () => {
    const script = await capturedScript();
    const { base, roots } = sandbox();
    try {
      // A secret genuinely unreachable from the scan's own privilege: owned by root, closed to
      // everyone else, exactly like the real /root under an ordinary, unprivileged builder user.
      writeFileSync(join(roots.root, "shadow.env"), `GH_TOKEN=ghp_${"D".repeat(36)}\n`);
      spawnSync("sudo", ["chown", "-R", "root:root", roots.root]);
      spawnSync("sudo", ["chmod", "700", roots.root]);
      // Runs the inner script directly as "nobody", bypassing the production sudo wrapper: this
      // tests the inner script's own fail-open-on-no-access property in isolation.
      const result = spawnSync("sudo", ["-u", "nobody", "bash", "-c", withIsolatedRoots(script, roots)], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    } finally {
      spawnSync("sudo", ["rm", "-rf", roots.root]);
      rmSync(base, { recursive: true, force: true });
    }
  },
  30_000,
);

test("real shell: a token in .git/config (a credential URL, say) fails the build", async () => {
  const script = await capturedScript();
  const { base, roots } = sandbox();
  try {
    const repo = join(roots.home, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "test.leak", `https://x-access-token:ghs_${"E".repeat(36)}@github.com/acme/web.git`);
    expect(runAgainst(script, roots).status).toBe(97);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("real shell: a token in a commit message fails the build even though it is reachable, not just dangling", async () => {
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
    git(repo, "commit", "-qm", `oops GH_TOKEN=ghu_${"F".repeat(36)} in the message`);
    expect(runAgainst(script, roots).status).toBe(97);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

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
}, 30_000);
