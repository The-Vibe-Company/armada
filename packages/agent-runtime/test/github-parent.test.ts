import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCwdCommand } from "../../provider-boat/src/native-cwd.ts";
import { GitHubBroker } from "../src/github-broker.ts";
import { processIdentity } from "../src/processes.ts";

async function withParents(
  work: (context: { base: string; home: string; old: string; current: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "gh-parents-")),
    home = join(base, "home");
  const old = `offline-${crypto.randomUUID()}`,
    current = `offline-${crypto.randomUUID()}`;
  await mkdir(home);
  await mkdir(join(home, ".armada"), { mode: 0o700 });
  const root = join(home, ".armada", `github-${"a".repeat(16)}`);
  const broker = new GitHubBroker(() => {}, (async () => Response.json({ token: current })) as unknown as typeof fetch);
  broker.configure({
    version: 1,
    revision: "1",
    generation: "offline",
    url: "https://armada.example/api/internal/github/credentials",
    capability: `armada_gh_${"c".repeat(64)}`,
    retired: [old],
    expiresAt: Date.now() + 60000,
  });
  await broker.acquire("acme/repo", "gh");
  const listener = await broker.listen(root);
  try {
    const git = join(base, "git-source");
    await writeFile(git, '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o700 });
    const installer = Bun.spawn(
      ["sudo", "-n", process.execPath, join(import.meta.dir, "../dist/main.js"), "github-install"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    installer.stdin.write(
      JSON.stringify({
        root,
        socket: listener.socket,
        activation: listener.activation,
        gh: join(base, "missing-gh"),
        git,
        ghWrapper: join(base, "gh"),
        gitWrapper: join(base, "git"),
        homes: [home],
      }),
    );
    installer.stdin.end();
    expect(await installer.exited).toBe(0);
    await work({ base, home, old, current });
  } finally {
    listener.close();
    await rm(base, { recursive: true, force: true });
  }
}

test("actual Boat Claude and Codex parent pipes redact arbitrary current and retired leaves before forwarding", () =>
  withParents(async ({ base, home, old, current }) => {
    for (const harness of ["claude", "codex"] as const) {
      const path = join(base, harness);
      await writeFile(
        `${path}.armada-original`,
        `#!/usr/bin/python3\nimport os,json,sys\nif ${JSON.stringify(harness)}=='codex': sys.stdin.readline()\nprint(json.dumps({'id':'probe','result':{'text':os.environ['SAMPLE']}}),flush=True)\nprint(os.environ['SAMPLE'],file=sys.stderr,flush=True)\n`,
        { mode: 0o700 },
      );
      const command = nativeCwdCommand(path, harness, home);
      const child = Bun.spawn(["bash", "-c", command, "--", ...(harness === "codex" ? ["app-server"] : [])], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SAMPLE: `${old} ${current}` },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write('{"id":"probe","method":"initialize"}\n');
      child.stdin.end();
      const output = await new Response(child.stdout).text(),
        error = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({ id: "probe", result: { text: "*** ***" } });
      expect(error).toBe("*** ***\n");
    }
  }));

test("native proxy forwards termination signals and reaps its actual original child", () =>
  withParents(async ({ base, home }) => {
    const program = join(base, "wait.py");
    await writeFile(program, "import os,signal\nprint(os.getpid(),flush=True)\nsignal.pause()\n");
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const proxy = Bun.spawn([join(home, ".armada", "github-native-proxy"), "/usr/bin/python3", program], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      let pid: number | undefined, birth: ReturnType<typeof processIdentity>;
      try {
        const reader = proxy.stdout.getReader();
        let ready = "";
        while (!ready.includes("\n")) {
          const value = await reader.read();
          if (value.done) throw Error("Native child did not become ready");
          ready += new TextDecoder().decode(value.value);
        }
        reader.releaseLock();
        pid = Number(ready.trim());
        birth = processIdentity(pid);
        if (!birth) throw Error("Native child disappeared before signal admission");
        proxy.kill(signal);
        await proxy.exited;
        expect(processIdentity(pid)?.start === birth.start).toBe(false);
      } finally {
        if (pid && birth && processIdentity(pid)?.start === birth.start) process.kill(pid, "SIGKILL");
        if (proxy.exitCode === null) proxy.kill("SIGKILL");
        await proxy.exited;
      }
    }
  }));

// The installed supervisor must preserve binary streams, even with split redaction leaves.
test("native proxy preserves large newline-free binary output and redacts chunk-spanning leaves", () =>
  withParents(async ({ base, home, old }) => {
    const input = Buffer.concat([Buffer.alloc(65530, 0), Buffer.from(old), Buffer.alloc(300000, 1)]);
    const program = join(base, "binary.py");
    await writeFile(program, "import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n");
    const child = Bun.spawn([join(home, ".armada", "github-native-proxy"), "/usr/bin/python3", program], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(input);
    child.stdin.end();
    const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
    expect(await child.exited).toBe(0);
    expect(output).toEqual(Buffer.concat([Buffer.alloc(65530, 0), Buffer.from("***"), Buffer.alloc(300000, 1)]));
    expect(await new Response(child.stderr).text()).toBe("");
  }));
