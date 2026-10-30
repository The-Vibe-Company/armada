import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { guarded } from "@armada/plugin-api/guard";
import { createLocalNode } from "../src/index.ts";
import { eventually } from "./support.ts";

const execute = promisify(execFile);

async function repository(root: string): Promise<string> {
  const path = join(root, "repository");
  await mkdir(path, { recursive: true });
  await execute("git", ["init", "--quiet", path]);
  await writeFile(join(path, "README.md"), "local node fixture\n");
  await execute("git", ["-C", path, "add", "README.md"]);
  await execute("git", [
    "-C",
    path,
    "-c",
    "user.name=Local node test",
    "-c",
    "user.email=local-node@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return path;
}

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
      const main = await repository(root);
      const ignore = "# Repository-owned ignore rules\nnode_modules/\n";
      await writeFile(join(main, ".gitignore"), ignore);
      await execute("git", ["-C", main, "add", ".gitignore"]);
      await execute("git", [
        "-C",
        main,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Repository ignore rules",
      ]);
      const source = linked ? join(root, "chosen-checkout") : main;
      if (linked) await execute("git", ["-C", main, "worktree", "add", "--quiet", "-b", "chosen", source]);
      const node = createLocalNode({
        projects: { orchard: { root: source } },
        workspaceRoot: join(root, "legacy-workspaces"),
        transport: "pipe",
      });
      const workspaces = [];
      for (const ticket of ["CHECK-1", "CHECK-2"]) {
        const workspace = await node.prepare({
          project: "orchard",
          ticket,
          repository: main,
          branch: `worker-${ticket}`,
        });
        workspaces.push(workspace);
        assert.equal(workspace.path, join(source, ".armada", "worktrees", ticket));
        assert.equal(
          (await execute("git", ["-C", workspace.path, "branch", "--show-current"])).stdout.trim(),
          `worker-${ticket}`,
        );
        assert.equal(
          (await execute("git", ["-C", source, "check-ignore", `.armada/worktrees/${ticket}`])).stdout.trim(),
          `.armada/worktrees/${ticket}`,
        );
      }
      const exclude = resolve(
        source,
        (await execute("git", ["-C", source, "rev-parse", "--git-path", "info/exclude"])).stdout.trim(),
      );
      assert.equal(
        (await readFile(exclude, "utf8")).split("\n").filter((line) => line === "/.armada/worktrees/").length,
        1,
      );
      assert.equal(await readFile(join(source, ".gitignore"), "utf8"), ignore);
      assert(node.dispose);
      for (const workspace of workspaces) {
        await node.dispose(workspace);
        await assert.rejects(stat(workspace.path), /ENOENT/);
      }
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

test("worker environments exclude parent secrets and retain explicit caller variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
  const parentOnly = `ARMADA_NODE_LOCAL_PARENT_ONLY_${randomUUID().replaceAll("-", "")}`;
  const explicit = "ARMADA_NODE_LOCAL_EXPLICIT";
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
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const worker = await launch(node, workspace, "session-environment", { [explicit]: "caller-value" });
    await eventually(async () => {
      const reply = (await node.observe(worker)).reply ?? "";
      return reply.includes("PARENT_SECRET_ABSENT") && reply.includes("EXPLICIT_VALUE_PRESENT");
    });
    const reply = (await node.observe(worker)).reply ?? "";
    assert.doesNotMatch(reply, /PARENT_SECRET_PRESENT/);
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

test("stop and kill deadlines reject zero", () => {
  assert.throws(() => createLocalNode({ stopTimeoutMs: 0 }), /stopTimeoutMs.*positive integer/);
  assert.throws(() => createLocalNode({ killTimeoutMs: 0 }), /killTimeoutMs.*positive integer/);
});

for (const childError of [undefined, "ESRCH", "EPERM"]) {
  test(`stop waits for child closure after group EPERM and child ${childError ?? "success"}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "armada-node-local-"));
    const kill = process.kill.bind(process);
    let groupPid: number | undefined;
    try {
      const source = await repository(root);
      const node = createLocalNode({ workspaceRoot: join(root, "workspaces"), transport: "pipe" });
      const workspace = await node.prepare({
        project: "local-test",
        ticket: "CHECK-1",
        repository: source,
        branch: "closing-worker-branch",
      });
      const script = join(workspace.path, "worker.mjs");
      await writeFile(script, "process.stdin.resume(); process.stdin.on('end', () => process.exit(1));\n");
      const worker = await launch(node, workspace, "session-closing");
      assert.equal((await node.observe(worker)).state, "running");

      let signalChild!: (child: ChildProcess) => void;
      const signaled = new Promise<ChildProcess>((resolve) => {
        signalChild = resolve;
      });
      t.mock.method(process, "kill", (pid: number) => {
        assert(pid < 0, "stop must attempt the process group");
        groupPid = pid;
        throw Object.assign(new Error("process group already exited"), { code: "EPERM" });
      });
      t.mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess) {
        signalChild(this);
        if (childError) throw Object.assign(new Error("child already exited"), { code: childError });
        return true;
      });

      let settled = false;
      const stopped = guarded(
        worker,
        () => {},
        () => node.stop(worker),
      ).finally(() => {
        settled = true;
      });
      const child = await Promise.race([
        signaled,
        stopped.then(() => {
          throw new Error("stop resolved before signaling the child");
        }),
      ]);
      await setImmediate(); // drain promise adoption without waiting on a clock
      assert.equal(settled, false, "a tolerated signal error must still wait for close");
      child.stdin?.end();
      await stopped;
      assert.equal((await node.observe(worker)).state, "stopped");
      await rm(script);
      assert(node.dispose);
      await node.dispose(workspace);
      await assert.rejects(stat(workspace.path), /ENOENT/);
    } finally {
      t.mock.restoreAll();
      if (groupPid !== undefined) {
        try {
          kill(groupPid, "SIGKILL");
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
