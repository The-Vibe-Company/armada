import assert from "node:assert/strict";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { WorkerRef, Workspace } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import { createLocalNode } from "../src/index.ts";
import { eventually, repository } from "./support.ts";

const execute = promisify(execFile);

test("eventually rejects at its clock deadline, including late observations", async () => {
  for (const scenario of ["unsettled", "late poll", "late result"]) {
    let now = 100;
    const waits: number[] = [];
    await assert.rejects(
      eventually(
        async () => {
          if (scenario === "late result") {
            now = 161;
            return true;
          }
          return scenario === "late poll" && now >= 161;
        },
        {
          timeoutMs: 61,
          now: () => now,
          sleep: async (ms) => {
            waits.push(ms);
            now += ms;
          },
        },
      ),
      /condition did not settle/,
      scenario,
    );
    assert.equal(now, 161);
    assert.deepEqual(waits, scenario === "late result" ? [] : [25, 25, 11]);
  }
});

async function launch(
  node: ReturnType<typeof createLocalNode>,
  workspace: Awaited<ReturnType<typeof node.prepare>>,
  session: string,
  environment: Record<string, string> = {},
) {
  const worker = { project: "local-test", ticket: "CHECK-1", session, generation: 1 };
  return guarded(
    worker,
    () => {},
    () =>
      node.launch({
        workspace,
        worker,
        command: process.execPath,
        args: [join(workspace.path, "worker.mjs")],
        env: environment,
      }),
  );
}

for (const linked of [false, true]) {
  test(`project-root worktrees stay in the chosen ${linked ? "linked " : ""}checkout and are excluded once`, async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-node-root-"));
    try {
      const home = join(root, "home");
      const config = join(root, "xdg");
      await mkdir(home);
      await mkdir(config);
      // Use a child so parallel tests cannot change this fixture's process environment.
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./project-root-worktrees.ts", import.meta.url)), root, linked ? "linked" : "main"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: config,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Local node test",
            GIT_AUTHOR_EMAIL: "local-node@example.invalid",
            GIT_COMMITTER_NAME: "Local node test",
            GIT_COMMITTER_EMAIL: "local-node@example.invalid",
            LANG: "C",
            LC_ALL: "C",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      const exited = once(child, "close");
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const [code, signal] = await exited;
      assert.equal(code, 0, `Worktree fixture failed (signal: ${signal ?? "none"}). Child stderr:\n${stderr}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const parent of [".armada", ".armada/worktrees", ".armada/worktrees/CHECK-1"]) {
  test(`project-root preparation rejects a symlink at ${parent} before changing Git or the target`, async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-node-symlink-"));
    try {
      const source = await repository(root);
      const outside = join(root, "outside");
      await mkdir(outside);
      await mkdir(dirname(join(source, parent)), { recursive: true });
      await symlink(outside, join(source, parent), "dir");
      const before = (await execute("git", ["-C", source, "worktree", "list", "--porcelain"])).stdout;
      const exclude = resolve(
        source,
        (await execute("git", ["-C", source, "rev-parse", "--git-path", "info/exclude"])).stdout.trim(),
      );
      const rules = await readFile(exclude, "utf8");
      const node = createLocalNode({ projects: { orchard: { root: source } }, transport: "pipe" });
      await assert.rejects(
        node.prepare({ project: "orchard", ticket: "CHECK-1", repository: source, branch: "escaped-worker" }),
        /symbolic link/,
      );
      assert.deepEqual(await readdir(outside), []);
      assert.equal((await execute("git", ["-C", source, "worktree", "list", "--porcelain"])).stdout, before);
      assert.equal(await readFile(exclude, "utf8"), rules);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("prepares a checked-out worktree and delivers keyed messages to a headless process", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "worker-branch",
    });
    assert.equal(
      (await execute("git", ["-C", workspace.path, "branch", "--show-current"])).stdout.trim(),
      "worker-branch",
    );
    await writeFile(
      join(workspace.path, "worker.mjs"),
      [
        "import { createInterface } from 'node:readline';",
        "console.log('READY');",
        `createInterface({ input: process.stdin }).on('line', (line) => { console.log(\`ACK:\${line}\`); if (line === 'exit') process.exit(0); });`,
      ].join("\n"),
    );

    const worker = await launch(node, workspace, "session-a");
    await eventually(async () => (await node.observe(worker)).reply?.includes("READY") === true);
    await guarded(
      worker,
      () => {},
      () => node.deliver(worker, "hello", "delivery-1"),
    );
    await guarded(
      worker,
      () => {},
      () => node.deliver(worker, "hello", "delivery-1"),
    );
    await eventually(async () => (await node.observe(worker)).reply?.includes("ACK:hello") === true);
    assert.equal(
      await node.transcript?.(worker, 6),
      "hello\n",
      "transcript reads the bounded output without sending input",
    );
    await assert.rejects(node.transcript!({ ...worker, generation: worker.generation + 1 }, 6), /stale|mismatched/i);
    await assert.rejects(
      guarded(
        worker,
        () => {},
        () => node.deliver(worker, "changed", "delivery-1"),
      ),
      /delivery key.*different message/,
    );
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
    assert.equal((await node.observe(worker)).state, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale or mismatched WorkerRef cannot deliver to the replacement process", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "worker-branch",
    });
    await writeFile(
      join(workspace.path, "worker.mjs"),
      `import { createInterface } from 'node:readline'; console.log('READY'); createInterface({input:process.stdin}).on('line', line => console.log(\`ACK:\${line}\`));\n`,
    );
    const first = await launch(node, workspace, "session-a");
    await eventually(async () => (await node.observe(first)).reply?.includes("READY") === true);
    await guarded(
      first,
      () => {},
      () => node.stop(first),
    );

    const replacement = await launch(node, workspace, "session-b");
    await eventually(async () => (await node.observe(replacement)).reply?.includes("READY") === true);
    const stale = { ...replacement, session: "session-a" };
    await assert.rejects(
      guarded(
        stale,
        () => {},
        () => node.deliver(stale, "must-not-arrive", "stale-key"),
      ),
      /stale or mismatched/,
    );
    assert.doesNotMatch((await node.observe(replacement)).reply ?? "", /must-not-arrive/);
    await guarded(
      replacement,
      () => {},
      () => node.stop(replacement),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a detached worker can be adopted after its launching host exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const workspaceRoot = join(root, "workspaces");
    const projects = { "local-test": { root: source } };
    const hostScript = join(root, "launch-host.mjs");
    const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
    const guardUrl = new URL("../../../plugin-api/dist/guard.js", import.meta.url).href;
    const preallocatedHandle = "00000000-0000-4000-8000-000000002093";
    await writeFile(
      hostScript,
      [
        `import { createLocalNode } from ${JSON.stringify(moduleUrl)};`,
        `import { guarded } from ${JSON.stringify(guardUrl)};`,
        `import { writeFile } from "node:fs/promises";`,
        `import { join } from "node:path";`,
        `const node = createLocalNode({ workspaceRoot: ${JSON.stringify(workspaceRoot)}, projects: ${JSON.stringify(projects)}, transport: "pipe" });`,
        `const workspace = await node.prepare({ project: "local-test", ticket: "CHECK-1", repository: ${JSON.stringify(source)}, branch: "detached-host-branch" });`,
        `await writeFile(join(workspace.path, "worker.mjs"), "import { createInterface } from 'node:readline'; console.log('READY'); createInterface({ input: process.stdin }).on('line', line => console.log('ACK:' + line));\\n");`,
        `const identity = { project: "local-test", ticket: "CHECK-1", session: "session-detached", generation: 1 };`,
        `const worker = await guarded(identity, () => {}, () => node.launch({ handle: ${JSON.stringify(preallocatedHandle)}, workspace, worker: identity, command: process.execPath, args: [join(workspace.path, "worker.mjs")], env: {} }));`,
        `await guarded(worker, () => {}, () => node.deliver(worker, "from-first-host", "warmup"));`,
        `await new Promise(resolve => process.stdout.write(JSON.stringify({ workspace, worker }) + "\\n", resolve));`,
        `process.exit(0);`,
      ].join("\n"),
    );

    const { stdout } = await execute(process.execPath, [hostScript], { cwd: root, maxBuffer: 1024 * 1024 });
    const { workspace, worker } = JSON.parse(stdout.trim()) as {
      workspace: Workspace;
      worker: WorkerRef;
    };
    assert.equal(worker.handle, preallocatedHandle);
    assert.equal(workspace.path, join(source, ".armada", "worktrees", "CHECK-1"));
    const node = createLocalNode({ workspaceRoot, projects, transport: "pipe" });
    assert(node.adopt, "node-local must expose adoption");

    const stale = { ...worker, session: "stale-session" };
    await assert.rejects(node.adopt(stale, workspace), /stale or mismatched/);
    assert.deepEqual(await node.adopt(worker, workspace), { deliveries: 1 });
    await assert.rejects(
      guarded(
        stale,
        () => {},
        () => node.stop(stale),
      ),
      /stale or mismatched/,
    );
    assert.equal((await node.observe(worker)).state, "running");
    assert.equal((await node.observe(worker)).acceptedDeliveries, 1);
    await guarded(
      worker,
      () => {},
      () => node.deliver(worker, "from-first-host", "warmup"),
    );
    await eventually(async () => (await node.observe(worker)).reply?.includes("ACK:from-first-host") === true);
    assert.equal(((await node.observe(worker)).reply ?? "").match(/ACK:from-first-host/g)?.length, 1);
    assert.equal((await node.observe(worker)).acceptedDeliveries, 1);

    await guarded(
      worker,
      () => {},
      () => node.deliver(worker, "from-second-host", "delivery-2"),
    );
    await guarded(
      worker,
      () => {},
      () => node.deliver(worker, "from-second-host", "delivery-2"),
    );
    await eventually(async () => (await node.observe(worker)).reply?.includes("ACK:from-second-host") === true);
    assert.equal(((await node.observe(worker)).reply ?? "").match(/ACK:from-second-host/g)?.length, 1);
    assert.equal((await node.observe(worker)).acceptedDeliveries, 2);
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
    assert.equal((await node.observe(worker)).state, "stopped");

    await rm(join(workspace.path, "worker.mjs"));
    await writeFile(join(workspace.path, "dirty-after-adoption.txt"), "preserve this work\n");
    assert(node.dispose);
    await assert.rejects(node.dispose(workspace), /dirty/);
    assert.equal((await stat(workspace.path)).isDirectory(), true);
    await execute("git", ["-C", workspace.path, "add", "dirty-after-adoption.txt"]);
    await execute("git", [
      "-C",
      workspace.path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Keep adopted work",
    ]);
    await assert.rejects(node.dispose(workspace), /unpushed/);
    assert.equal((await stat(workspace.path)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starting adoption waits for the preallocated endpoint, and terminal metadata survives stop until dispose", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  const workspaceRoot = join(root, "workspaces");
  const workspaceFile = join(root, "workspace.json");
  const startFile = join(root, "start-launch");
  const launchedFile = join(root, "launched.json");
  const handle = "00000000-0000-4000-8000-000000002094";
  const workerIdentity = {
    project: "local-test",
    ticket: "CHECK-1",
    session: "session-starting-adopt",
    generation: 1,
  };
  const worker = { ...workerIdentity, handle };
  const hostScript = join(root, "starting-host.mjs");
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const guardUrl = new URL("../../../plugin-api/dist/guard.js", import.meta.url).href;
  await writeFile(
    hostScript,
    [
      `import { createLocalNode } from ${JSON.stringify(moduleUrl)};`,
      `import { guarded } from ${JSON.stringify(guardUrl)};`,
      `import { readFile, writeFile } from "node:fs/promises";`,
      `import { join } from "node:path";`,
      `const node = createLocalNode({ workspaceRoot: ${JSON.stringify(workspaceRoot)}, transport: "pipe" });`,
      `const workspace = await node.prepare({ project: "local-test", ticket: "CHECK-1", repository: ${JSON.stringify(await repository(root))}, branch: "starting-adopt-branch" });`,
      `await writeFile(join(workspace.path, "worker.mjs"), "console.log('READY'); process.stdin.resume(); setInterval(() => {}, 1000);\\n");`,
      `await writeFile(${JSON.stringify(workspaceFile)}, JSON.stringify(workspace));`,
      `while (true) { try { await readFile(${JSON.stringify(startFile)}); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }`,
      `const identity = ${JSON.stringify(workerIdentity)};`,
      `const ref = await guarded(identity, () => {}, () => node.launch({ handle: ${JSON.stringify(handle)}, workspace, worker: identity, command: process.execPath, args: [join(workspace.path, "worker.mjs")], env: {} }));`,
      `await writeFile(${JSON.stringify(launchedFile)}, JSON.stringify(ref));`,
      `process.exit(0);`,
    ].join("\n"),
  );

  const host = spawn(process.execPath, [hostScript], { cwd: root, stdio: "ignore" });
  const hostDone = new Promise<void>((resolvePromise, rejectPromise) => {
    host.once("error", rejectPromise);
    host.once("close", (code, signal) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`starting host exited with ${code ?? signal}`)),
    );
  });
  void hostDone.catch(() => {});
  const adopter = createLocalNode({ workspaceRoot, transport: "pipe" });
  assert(adopter.adopt);
  let workspace: Workspace | undefined;
  let adopted = false;
  let attachment: Promise<{ deliveries: number }> | undefined;
  try {
    await eventually(async () =>
      stat(workspaceFile).then(
        () => true,
        () => false,
      ),
    );
    workspace = JSON.parse(await readFile(workspaceFile, "utf8")) as Workspace;
    const endpointHash = createHash("sha256")
      .update(workspaceRoot)
      .update("\0")
      .update(handle)
      .digest("hex")
      .slice(0, 24);
    const endpointDirectory = join(tmpdir(), `armada-nl-${endpointHash}`);
    await assert.rejects(
      adopter.adopt(worker, workspace),
      /unreachable.*no liveness contract/,
      "ordinary adoption does not wait for a launch that has not started",
    );

    let settled = false;
    attachment = adopter.adopt(worker, workspace, { starting: true }).finally(() => {
      settled = true;
    });
    void attachment.catch(() => {});
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(settled, false, "starting adoption should still be retrying before the launcher is released");
    await assert.rejects(stat(endpointDirectory), /ENOENT/, "the endpoint must not pre-exist the launcher");

    await writeFile(startFile, "launch\n");
    assert.deepEqual(await attachment, { deliveries: 0 });
    adopted = true;
    await hostDone;
    const launched = JSON.parse(await readFile(launchedFile, "utf8")) as WorkerRef;
    assert.deepEqual(launched, worker);
    await eventually(async () => (await adopter.observe(worker)).reply?.includes("READY") === true);
    await guarded(
      worker,
      () => {},
      () => adopter.stop(worker),
    );

    const restarted = createLocalNode({ workspaceRoot, transport: "pipe" });
    assert(restarted.adopt);
    assert.deepEqual(await restarted.adopt(worker, workspace), { deliveries: 0 });
    assert.equal((await restarted.observe(worker)).state, "stopped");
    await guarded(
      worker,
      () => {},
      () => restarted.stop(worker),
    );

    await rm(join(workspace.path, "worker.mjs"));
    assert(restarted.dispose);
    await restarted.dispose(workspace);
    await assert.rejects(stat(workspace.path), /ENOENT/);
    await assert.rejects(restarted.adopt(worker, workspace), /stale or mismatched/);
  } finally {
    await writeFile(startFile, "cleanup\n").catch(() => {});
    await hostDone.catch(() => {});
    await attachment?.catch(() => {});
    const didLaunch = await stat(launchedFile).then(
      () => true,
      () => false,
    );
    if (workspace && didLaunch) {
      if (!adopted) await adopter.adopt(worker, workspace, { starting: true }).catch(() => {});
      await guarded(
        worker,
        () => {},
        () => adopter.stop(worker),
      ).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose keeps dirty or unpushed worktrees and removes only clean pushed work", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
    const dirty = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "dirty-branch",
    });
    await writeFile(join(dirty.path, "untracked.txt"), "keep me\n");
    assert(node.dispose);
    await assert.rejects(node.dispose(dirty), /dirty/);
    assert.equal((await stat(dirty.path)).isDirectory(), true);

    const clean = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "clean-branch",
    });
    const cleanPath = clean.path;
    const dirtyPath = dirty.path;
    // Returned values must not alias the provider's stored provenance.
    dirty.path = clean.path;
    try {
      await assert.rejects(node.dispose(dirty), /not owned/);
    } finally {
      dirty.path = dirtyPath;
    }
    assert.equal((await stat(cleanPath)).isDirectory(), true);
    await node.dispose(clean);
    await assert.rejects(stat(cleanPath), /ENOENT/);
    assert.equal(await readFile(join(dirty.path, "untracked.txt"), "utf8"), "keep me\n");
    await execute("git", ["-C", dirty.path, "add", "untracked.txt"]);
    await execute("git", [
      "-C",
      dirty.path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Keep my work",
    ]);
    await assert.rejects(node.dispose(dirty), /unpushed/);
    assert.equal((await stat(dirty.path)).isDirectory(), true);
    const remote = join(root, "remote.git");
    await execute("git", ["init", "--bare", "--quiet", remote]);
    await execute("git", ["-C", source, "remote", "add", "origin", remote]);
    await execute("git", ["-C", dirty.path, "push", "--quiet", "origin", "HEAD"]);
    await node.dispose(dirty);
    await assert.rejects(stat(dirty.path), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop escalates a process that ignores SIGTERM and waits for it to close", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({
      workspaceRoot: join(root, "workspaces"),
      transport: "pipe",
      stopTimeoutMs: 20,
      killTimeoutMs: 500,
    });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "stubborn-branch",
    });
    await writeFile(
      join(workspace.path, "worker.mjs"),
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    const worker = await launch(node, workspace, "session-stubborn");
    assert.equal((await node.observe(worker)).state, "running");
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
    assert.equal((await node.observe(worker)).state, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop kills an ignored-stdio descendant after its CLI wrapper exits", {
  skip: process.platform !== "linux" && process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  let descendantPid: number | undefined;
  let worker: WorkerRef | undefined;
  let node: ReturnType<typeof createLocalNode> | undefined;
  try {
    const source = await repository(root);
    node = createLocalNode({
      workspaceRoot: join(root, "workspaces"),
      transport: "pipe",
      stopTimeoutMs: process.platform === "win32" ? 1_000 : 20,
      killTimeoutMs: process.platform === "win32" ? 10_000 : 500,
    });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "ignored-descendant-branch",
    });
    const readyFile = join(root, "descendant.ready");
    const safetyExitMs = process.platform === "win32" ? 15_000 : 30_000;
    const descendantCode = `process.title='armada-node-local-descendant-fixture'; process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setTimeout(() => process.exit(0), ${safetyExitMs}); setInterval(() => {}, 1000);`;
    const workerScript = [
      "import { spawn } from 'node:child_process';",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' });`,
      "console.log('DESCENDANT_PID:' + descendant.pid);",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(join(workspace.path, "worker.mjs"), workerScript);
    worker = await launch(node, workspace, "session-ignored-descendant");
    await eventually(async () =>
      stat(readyFile).then(
        () => true,
        () => false,
      ),
    );
    const runningNode = node;
    const runningWorker = worker;
    await eventually(
      async () => (await runningNode.observe(runningWorker)).reply?.includes("DESCENDANT_PID:") === true,
    );
    const reply = (await node.observe(worker)).reply ?? "";
    const match = reply.match(/DESCENDANT_PID:(\d+)/);
    assert(match, "worker should report the test descendant PID");
    descendantPid = Number(match[1]);
    assert(Number.isInteger(descendantPid) && descendantPid > 1);
    assert.doesNotThrow(() => process.kill(descendantPid!, 0));

    await guarded(
      worker,
      () => {},
      () => runningNode.stop(runningWorker),
    );
    await eventually(
      async () => {
        try {
          process.kill(descendantPid!, 0);
          if (process.platform !== "linux") return false;
          const statText = await readFile(`/proc/${descendantPid}/stat`, "utf8").catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          });
          const state = statText.slice(statText.lastIndexOf(")") + 2, statText.lastIndexOf(")") + 3);
          return !statText || state === "Z";
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM") return false;
          return code === "ESRCH";
        }
      },
      { timeoutMs: process.platform === "win32" ? 10_000 : 3_000 },
    );
    assert.equal((await node.observe(worker)).state, "stopped");
  } finally {
    if (node && worker)
      await guarded(
        worker,
        () => {},
        () => node!.stop(worker!),
      ).catch(() => {});
    if (descendantPid) {
      const cmdline = await readFile(`/proc/${descendantPid}/cmdline`, "utf8").catch(() => "");
      if (cmdline.includes("armada-node-local-descendant-fixture")) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an unexpectedly exited pin remains unconfirmed and cannot release its workspace", {
  skip: process.platform !== "linux",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  const workspaceRoot = join(root, "workspaces");
  const pidFile = join(root, "unexpected-pin-pids.json");
  let worker: WorkerRef | undefined;
  let workspace: Workspace | undefined;
  let node: ReturnType<typeof createLocalNode> | undefined;
  let fixturePids:
    | {
        workerPid: number;
        workerStart: string;
        pinPid: number;
        pinStart: string;
        supervisorPid: number;
        supervisorStart: string;
      }
    | undefined;
  try {
    const source = await repository(root);
    node = createLocalNode({ workspaceRoot, transport: "pipe" });
    workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "unexpected-pin-branch",
    });
    const workerScript = [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "process.title = 'armada-node-local-unexpected-pin-fixture';",
      "const fields = (pid) => { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' '); };",
      "const pinPid = process.ppid;",
      "const pinFields = fields(pinPid);",
      "const supervisorPid = Number(pinFields[1]);",
      "const supervisorFields = fields(supervisorPid);",
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ workerPid: process.pid, workerStart: fields(process.pid)[19], pinPid, pinStart: pinFields[19], supervisorPid, supervisorStart: supervisorFields[19] }));`,
      "process.kill(pinPid, 'SIGKILL');",
      "setTimeout(() => process.exit(0), 5000);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(join(workspace.path, "worker.mjs"), workerScript);
    worker = await launch(node, workspace, "session-unexpected-pin");
    await eventually(async () =>
      stat(pidFile).then(
        () => true,
        () => false,
      ),
    );
    fixturePids = JSON.parse(await readFile(pidFile, "utf8")) as {
      workerPid: number;
      workerStart: string;
      pinPid: number;
      pinStart: string;
      supervisorPid: number;
      supervisorStart: string;
    };

    await eventually(async () => (await node!.observe(worker!)).state === "failed");
    await assert.rejects(
      guarded(
        worker,
        () => {},
        () => node!.stop(worker!),
      ),
      /identity is no longer live|unverified PID/,
    );
    assert.equal((await node.observe(worker)).state, "failed");
    assert(node.dispose);
    await assert.rejects(node.dispose(workspace), /active worker/);

    const adopter = createLocalNode({ workspaceRoot, transport: "pipe" });
    assert.deepEqual(await adopter.adopt!(worker, workspace), { deliveries: 0 });
    assert.equal((await adopter.observe(worker)).state, "failed");
    await assert.rejects(
      guarded(
        worker,
        () => {},
        () => adopter.stop(worker!),
      ),
      /identity is no longer live|unverified PID/,
    );
  } finally {
    if (node && worker)
      await guarded(
        worker,
        () => {},
        () => node!.stop(worker!),
      ).catch(() => {});
    if (fixturePids) {
      // Test cleanup only signals the exact fixture processes captured above,
      // after checking their Linux start time and command/cwd identity.
      const exactProcess = async (pid: number, start: string) => {
        const statText = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        if (!statText) return false;
        const fields = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
        return fields[19] === start;
      };
      if (await exactProcess(fixturePids.workerPid, fixturePids.workerStart)) {
        const cmdline = await readFile(`/proc/${fixturePids.workerPid}/cmdline`, "utf8").catch(() => "");
        if (cmdline.includes("armada-node-local-unexpected-pin-fixture"))
          process.kill(fixturePids.workerPid, "SIGKILL");
      }
      if (await exactProcess(fixturePids.supervisorPid, fixturePids.supervisorStart)) {
        const [cwd, cmdline, statText] = await Promise.all([
          readlink(`/proc/${fixturePids.supervisorPid}/cwd`).catch(() => ""),
          readFile(`/proc/${fixturePids.supervisorPid}/cmdline`, "utf8").catch(() => ""),
          readFile(`/proc/${fixturePids.supervisorPid}/stat`, "utf8").catch(() => ""),
        ]);
        const fields = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
        if (
          cwd === workspaceRoot &&
          Number(fields[1]) === process.pid &&
          cmdline.includes("function terminateWindowsTree(pid)")
        )
          process.kill(fixturePids.supervisorPid, "SIGKILL");
      }
      if (worker)
        await rm(
          join(
            tmpdir(),
            `armada-nl-${createHash("sha256").update(workspaceRoot).update("\0").update(worker.handle).digest("hex").slice(0, 24)}`,
          ),
          { recursive: true, force: true },
        );
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("worker output remains bounded to the configured tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe", outputTail: 32 });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "bounded-output-branch",
    });
    await writeFile(
      join(workspace.path, "worker.mjs"),
      "process.stdout.write('prefix-' + 'x'.repeat(200)); setInterval(() => {}, 1000);\n",
    );
    const worker = await launch(node, workspace, "session-bounded-output");
    await eventually(async () => ((await node.observe(worker)).reply ?? "").length === 32);
    const reply = (await node.observe(worker)).reply ?? "";
    assert.equal(reply, "x".repeat(32));
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker environments exclude parent secrets, retain explicit values, and redact the worker token", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  const parentOnly = `ARMADA_NODE_LOCAL_PARENT_ONLY_${randomUUID().replaceAll("-", "")}`;
  const explicit = "ARMADA_NODE_LOCAL_EXPLICIT";
  const token = "worker-token-must-not-appear-in-observation";
  const previous = process.env[parentOnly];
  process.env[parentOnly] = "parent-secret-must-not-cross";
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "environment-branch",
    });
    await writeFile(
      join(workspace.path, "worker.mjs"),
      [
        `console.log(process.env[${JSON.stringify(parentOnly)}] === undefined ? "PARENT_SECRET_ABSENT" : "PARENT_SECRET_PRESENT");`,
        `console.log(process.env[${JSON.stringify(explicit)}] === "caller-value" ? "EXPLICIT_VALUE_PRESENT" : "EXPLICIT_VALUE_MISSING");`,
        `console.log(process.env.ARMADA_WORKER_TOKEN);`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const worker = await launch(node, workspace, "session-environment", {
      [explicit]: "caller-value",
      ARMADA_WORKER_TOKEN: token,
    });
    await eventually(async () => {
      const reply = (await node.observe(worker)).reply ?? "";
      return reply.includes("PARENT_SECRET_ABSENT") && reply.includes("EXPLICIT_VALUE_PRESENT");
    });
    const reply = (await node.observe(worker)).reply ?? "";
    assert.doesNotMatch(reply, /PARENT_SECRET_PRESENT/);
    assert.doesNotMatch(reply, new RegExp(token));
    assert.match(reply, /\[redacted\]/);
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
  } finally {
    if (previous === undefined) delete process.env[parentOnly];
    else process.env[parentOnly] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("token redaction leaves a short newline-terminated ready frame visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "token-ready-branch",
    });
    await writeFile(join(workspace.path, "worker.mjs"), "console.log('READY'); setInterval(() => {}, 1000);\n");
    const worker = await launch(node, workspace, "session-token-ready", {
      ARMADA_WORKER_TOKEN: "long-worker-token-value-that-is-not-output",
    });
    await eventually(async () => (await node.observe(worker)).reply?.includes("READY\n") === true);
    assert.equal((await node.observe(worker)).state, "running");
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop and kill deadlines reject zero", () => {
  assert.throws(() => createLocalNode({ stopTimeoutMs: 0 }), /stopTimeoutMs.*positive integer/);
  assert.throws(() => createLocalNode({ killTimeoutMs: 0 }), /killTimeoutMs.*positive integer/);
});

test("a missing executable returns a failed handle that can still be observed and stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "missing-executable-branch",
    });
    const worker = { project: "local-test", ticket: "CHECK-1", session: "session-missing", generation: 1 };
    const failed = await guarded(
      worker,
      () => {},
      () =>
        node.launch({
          workspace,
          worker,
          command: join(root, "does-not-exist"),
          args: [],
          env: {},
        }),
    );
    assert(failed.handle);
    assert.equal((await node.observe(failed)).state, "failed");
    await guarded(
      failed,
      () => {},
      () => node.stop(failed),
    );
    assert.equal((await node.observe(failed)).state, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// THE-2212: a supervisor that died with its daemon (a tree kill of the dev app, a kill by
// name) leaves a dead endpoint and no final record. Only the liveness contract it wrote
// once the CLI ran, plus the end of that process group, proves the tree gone.
const supervisorDirectory = (workspaceRoot: string, handle: string) =>
  join(
    process.platform === "win32" ? tmpdir() : "/tmp",
    `armada-nl-${createHash("sha256").update(workspaceRoot).update("\0").update(handle).digest("hex").slice(0, 24)}`,
  );
const parentOf = async (pid: number) => Number((await execute("ps", ["-o", "ppid=", "-p", String(pid)])).stdout.trim());
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A CLI fixture that survives its supervisor: it ignores stdin's end and exits only on a stop file. */
const survivingFixture = (pidFile: string, stopFile: string) =>
  [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "console.log('READY');",
    `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pin: process.ppid }));`,
    "process.stdin.resume();",
    `setInterval(() => { if (existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 50);`,
    "setTimeout(() => process.exit(0), 60_000);",
  ].join("\n");

test("a dead supervisor is reported gone only once its contracted process group ended; the kept worktree is then reused", {
  skip: process.platform === "win32",
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-gone-"));
  let fixture: { pin: number; supervisor: number } | undefined;
  const handles: string[] = [];
  let workspaceRoot = "";
  try {
    const source = await repository(root);
    const projects = { "local-test": { root: source } };
    workspaceRoot = join(source, ".armada", "worktrees");
    const node = createLocalNode({ projects, transport: "pipe" });
    const request = { project: "local-test", ticket: "CHECK-1", repository: source, branch: "kept-branch" };
    const workspace = await node.prepare(request);
    const pidFile = join(root, "fixture.json");
    const stopFile = join(root, "stop");
    await writeFile(join(workspace.path, "worker.mjs"), survivingFixture(pidFile, stopFile));
    await writeFile(join(workspace.path, "unpushed-notes.txt"), "dirty work to preserve\n");
    const worker = await launch(node, workspace, "session-gone");
    handles.push(worker.handle);
    const paths = supervisorDirectory(workspaceRoot, worker.handle);
    await eventually(async () => (await node.observe(worker)).reply?.includes("READY") === true);
    await eventually(() =>
      stat(join(paths, "pin.json")).then(
        () => true,
        () => false,
      ),
    );
    const contract = JSON.parse(await readFile(join(paths, "pin.json"), "utf8"));
    const { pin } = JSON.parse(await readFile(pidFile, "utf8")) as { pin: number };
    assert.equal(contract.version, 1);
    assert.equal(contract.group, pin, "the contract names the pinned group, the pin runner's pid");
    assert.deepEqual(contract.worker, worker);
    fixture = { pin, supervisor: await parentOf(pin) };
    assert(fixture.supervisor > 1);

    process.kill(fixture.supervisor, "SIGKILL");
    await eventually(async () => !alive(fixture!.supervisor), { timeoutMs: 10_000 });
    const adopter = createLocalNode({ projects, transport: "pipe" });
    await eventually(
      async () => {
        const error = await adopter.adopt!(worker, workspace).then(
          () => undefined,
          (e: Error) => e,
        );
        return /refused the connection|no supervisor endpoint/.test(error?.message ?? "");
      },
      { timeoutMs: 10_000 },
    );
    const running = await adopter.adopt!(worker, workspace).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.match(running!.message, /process group still exists/);
    assert.equal(running!.name, "WorkerRuntimeAlive", "a live group is reported alive, never gone");
    assert(alive(pin), "nothing was signaled: the surviving tree keeps running");

    await writeFile(stopFile, "stop\n");
    await eventually(async () => !alive(pin), { timeoutMs: 15_000 });
    const gone = await adopter.adopt!(worker, workspace).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.equal(gone!.name, "WorkerRuntimeGone");
    assert.match(gone!.message, /process group that no longer exists/);
    assert.match(gone!.message, /nothing was signaled/);

    const reused = await adopter.prepare(request);
    assert.equal(reused.path, workspace.path, "the kept worktree is reused at its path");
    assert.notEqual(reused.id, workspace.id, "under a new workspace identity");
    assert.equal(await readFile(join(reused.path, "unpushed-notes.txt"), "utf8"), "dirty work to preserve\n");
    await writeFile(
      join(reused.path, "worker.mjs"),
      "import { createInterface } from 'node:readline'; console.log('READY'); createInterface({ input: process.stdin }).on('line', () => {});\n",
    );
    const replacement = await guarded(
      { project: "local-test", ticket: "CHECK-1", session: "session-replacement", generation: 2 },
      () => {},
      () =>
        adopter.launch({
          workspace: reused,
          worker: { project: "local-test", ticket: "CHECK-1", session: "session-replacement", generation: 2 },
          command: process.execPath,
          args: [join(reused.path, "worker.mjs")],
          env: {},
        }),
    );
    handles.push(replacement.handle);
    await eventually(async () => (await adopter.observe(replacement)).reply?.includes("READY") === true);
    await assert.rejects(adopter.prepare(request), /active worker/, "no second worker in the reused worktree");
    await guarded(
      replacement,
      () => {},
      () => adopter.stop(replacement),
    );
    assert.equal((await adopter.observe(replacement)).state, "stopped");
  } finally {
    if (fixture && alive(fixture.pin)) process.kill(fixture.pin, "SIGKILL");
    for (const handle of handles)
      await rm(supervisorDirectory(workspaceRoot, handle), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing, legacy or foreign liveness contract never proves a tree gone", {
  skip: process.platform === "win32",
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-legacy-"));
  let fixture: { pin: number; supervisor: number } | undefined;
  let handle = "";
  const workspaceRoot = join(root, "workspaces");
  try {
    const source = await repository(root);
    const node = createLocalNode({ workspaceRoot, transport: "pipe" });
    const workspace = await node.prepare({
      project: "local-test",
      ticket: "CHECK-1",
      repository: source,
      branch: "legacy-branch",
    });
    const pidFile = join(root, "fixture.json");
    const stopFile = join(root, "stop");
    await writeFile(join(workspace.path, "worker.mjs"), survivingFixture(pidFile, stopFile));
    const worker = await launch(node, workspace, "session-legacy");
    handle = worker.handle;
    const paths = supervisorDirectory(workspaceRoot, handle);
    await eventually(async () => (await node.observe(worker)).reply?.includes("READY") === true);
    await eventually(() =>
      stat(join(paths, "pin.json")).then(
        () => true,
        () => false,
      ),
    );
    const { pin } = JSON.parse(await readFile(pidFile, "utf8")) as { pin: number };
    fixture = { pin, supervisor: await parentOf(pin) };
    const contract = await readFile(join(paths, "pin.json"), "utf8");
    // A worker launched before the contract existed left no such file.
    await rm(join(paths, "pin.json"));
    process.kill(fixture.supervisor, "SIGKILL");
    await eventually(async () => !alive(fixture!.supervisor), { timeoutMs: 10_000 });
    const adopter = createLocalNode({ workspaceRoot, transport: "pipe" });
    const reject = async () =>
      adopter.adopt!(worker, workspace).then(
        () => undefined,
        (e: Error) => e,
      );
    await eventually(async () => /unreachable/.test((await reject())?.message ?? ""), { timeoutMs: 10_000 });
    const legacyLive = await reject();
    assert.match(legacyLive!.message, /no liveness contract was recorded/);
    assert.notEqual(legacyLive!.name, "WorkerRuntimeGone");
    assert(alive(pin));

    await writeFile(stopFile, "stop\n");
    await eventually(async () => !alive(pin), { timeoutMs: 15_000 });
    const legacyDead = await reject();
    assert.match(legacyDead!.message, /no liveness contract was recorded/);
    assert.notEqual(legacyDead!.name, "WorkerRuntimeGone", "absence of evidence is not evidence of termination");

    const parsed = JSON.parse(contract);
    await writeFile(join(paths, "pin.json"), JSON.stringify({ ...parsed, worker: { ...worker, session: "other" } }), {
      mode: 0o600,
    });
    assert.match((await reject())!.message, /belongs to another worker generation/);
    await writeFile(join(paths, "pin.json"), JSON.stringify({ ...parsed, version: 2 }), { mode: 0o600 });
    assert.match((await reject())!.message, /unknown version/);
    await writeFile(join(paths, "pin.json"), "not json", { mode: 0o600 });
    assert.match((await reject())!.message, /not valid JSON/);
    for (const message of [/another worker generation/, /unknown version/, /not valid JSON/])
      assert.notEqual((await reject())!.name, "WorkerRuntimeGone", String(message));

    await writeFile(join(paths, "pin.json"), contract, { mode: 0o600 });
    const gone = await reject();
    assert.equal(gone!.name, "WorkerRuntimeGone", "the contract plus the ended group is the evidence");
    assert.match(gone!.message, /version 1/);
  } finally {
    if (fixture && alive(fixture.pin)) process.kill(fixture.pin, "SIGKILL");
    if (handle) await rm(supervisorDirectory(workspaceRoot, handle), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a kept project worktree is reused only for its own branch, never twice at once", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-reuse-"));
  const handles: string[] = [];
  let workspaceRoot = "";
  try {
    const source = await repository(root);
    workspaceRoot = join(source, ".armada", "worktrees");
    const node = createLocalNode({ projects: { "local-test": { root: source } }, transport: "pipe" });
    const request = { project: "local-test", ticket: "CHECK-1", repository: source, branch: "kept-branch" };
    const first = await node.prepare(request);
    await writeFile(
      join(first.path, "worker.mjs"),
      "import { createInterface } from 'node:readline'; console.log('READY'); createInterface({ input: process.stdin }).on('line', () => {});\n",
    );
    const worker = await launch(node, first, "session-reuse-1");
    handles.push(worker.handle);
    await eventually(async () => (await node.observe(worker)).reply?.includes("READY") === true);
    await assert.rejects(node.prepare(request), /active worker/, "a running worker keeps its worktree");
    await guarded(
      worker,
      () => {},
      () => node.stop(worker),
    );
    await writeFile(join(first.path, "kept.txt"), "kept\n");

    const [again, concurrent] = await Promise.all([node.prepare(request), node.prepare(request)]);
    assert.equal(again.path, first.path);
    assert.equal(concurrent.path, first.path);
    assert.notEqual(again.id, concurrent.id);
    assert.equal(await readFile(join(again.path, "kept.txt"), "utf8"), "kept\n", "nothing in it is reset");
    const second = await guarded(
      { project: "local-test", ticket: "CHECK-1", session: "session-reuse-2", generation: 2 },
      () => {},
      () =>
        node.launch({
          workspace: again,
          worker: { project: "local-test", ticket: "CHECK-1", session: "session-reuse-2", generation: 2 },
          command: process.execPath,
          args: [join(again.path, "worker.mjs")],
          env: {},
        }),
    );
    handles.push(second.handle);
    await guarded(
      second,
      () => {},
      () => node.stop(second),
    );
    // Two admissions of one worktree launching at the same moment still run at most one worker in it.
    const launchIn = (workspace: Workspace, session: string, generation: number) =>
      guarded(
        { project: "local-test", ticket: "CHECK-1", session, generation },
        () => {},
        () =>
          node.launch({
            workspace,
            worker: { project: "local-test", ticket: "CHECK-1", session, generation },
            command: process.execPath,
            args: [join(workspace.path, "worker.mjs")],
            env: {},
          }),
      );
    const [third, fourth] = await node.prepare(request).then(async (a) => [a, await node.prepare(request)]);
    const race = await Promise.allSettled([
      launchIn(third, "session-reuse-3", 3),
      launchIn(fourth, "session-reuse-4", 4),
    ]);
    const won = race.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<WorkerRef>[];
    assert.equal(won.length, 1, "exactly one of two simultaneous launches wins the kept worktree");
    const lostRace = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.match(String(lostRace.reason.message), /active worker/);
    handles.push(won[0]!.value.handle);
    await guarded(
      won[0]!.value,
      () => {},
      () => node.stop(won[0]!.value),
    );

    await assert.rejects(
      node.prepare({ ...request, branch: "other-branch" }),
      /kept worktree on kept-branch, not other-branch/,
      "provenance is the branch the worktree is attached to, not a name",
    );
    await mkdir(join(workspaceRoot, "CHECK-2"));
    await assert.rejects(
      node.prepare({ ...request, ticket: "CHECK-2", branch: "plain-branch" }),
      /not a worktree of/,
      "a plain directory at the path is never adopted",
    );
  } finally {
    for (const handle of handles)
      await rm(supervisorDirectory(workspaceRoot, handle), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
