import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { guarded } from "@armada/plugin-api/guard";
import { createLocalNode } from "../src/index.ts";

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

async function eventually(action: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    if (await action()) return;
    await setImmediate();
  }
  throw new Error("condition did not settle");
}

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

test("dispose keeps dirty worktrees and removes only a clean owned worktree", async () => {
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
