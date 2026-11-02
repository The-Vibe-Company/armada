import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeProvider, RuntimeProvider, WorkerObservation, WorkerRef } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import { claudeRuntime } from "../../claude/src/index.ts";
import { createLocalNode } from "../../node-local/src/index.ts";
import { opencodeRuntime } from "../../opencode/src/index.ts";
import { codexRuntime } from "../src/index.ts";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function until(
  runtime: RuntimeProvider,
  ref: WorkerRef,
  predicate: (value: WorkerObservation) => boolean,
  timeout = 8_000,
) {
  const deadline = Date.now() + timeout;
  do {
    const value = await runtime.observe(ref);
    if (predicate(value)) return value;
    await setImmediate();
  } while (Date.now() < deadline);
  throw new Error("Runtime did not produce the expected observation");
}

// Input order is a runtime contract: a slow observation of the first delivery must
// not let the next message overtake it before the node's own write queue is entered.
for (const [kind, create] of [
  ["claude", claudeRuntime],
  ["codex", codexRuntime],
  ["opencode", opencodeRuntime],
] as const) {
  test(`${kind} preserves delivery order when the first pre-write observation is delayed`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const received: string[] = [];
    const node: NodeProvider = {
      prepare: async () => ({ id: "workspace", path: "/synthetic/workspace", node: "local" }),
      launch: async ({ worker }) => ({ ...worker, handle: "synthetic-worker" }),
      observe: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return { state: "running" };
      },
      deliver: async (_ref, message) => {
        received.push(message);
      },
      stop: async () => {},
    };
    const runtime = create({}, node);
    const workspace = await runtime.prepare({
      project: "orchard",
      ticket: "ORC-1",
      repository: "/synthetic",
      branch: "worker",
    });
    const worker = { project: "orchard", ticket: "ORC-1", session: "ordered", generation: 1 };
    const ref = await runtime.launch({ worker, workspace, command: "synthetic-cli", args: [], env: {} });
    const firstDelivery = runtime.deliver(ref, "first", "one");
    const secondDelivery = runtime.deliver(ref, "second", "two");
    await setImmediate();
    release();
    await Promise.all([firstDelivery, secondDelivery]);
    expect(received).toEqual(["first", "second"]);
  });
}

for (const [kind, create] of [
  ["codex", codexRuntime],
  ["opencode", opencodeRuntime],
] as const) {
  describe(`${kind} runtime through real node processes`, () => {
    async function setup(
      auth = "yes",
      outputTail = 65_536,
      config: Record<string, unknown> = {},
      launchEnv: Record<string, string> = {},
    ) {
      const root = await mkdtemp(join(tmpdir(), `${kind}-worker-`));
      roots.push(root);
      await execute("git", ["init", "--quiet", root]);
      await execute("git", [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "Initial",
      ]);
      const node = createLocalNode({ workspaceRoot: join(root, "worktrees"), transport: "pipe", outputTail });
      const unbound = create({
        command: fileURLToPath(new URL(`../../${kind}/test/fixtures/${kind}-worker.mjs`, import.meta.url)),
        model: "configured-model",
        effort: "low",
        extraArgs: ["--fixture-extra", "space value"],
        ...config,
      });
      assert(unbound.withNode);
      const runtime = unbound.withNode(node);
      assert(node.dispose);
      const workspace = await runtime.prepare({
        project: "sample",
        ticket: "EX-1",
        repository: root,
        branch: "worker-test",
      });
      const worker = { project: "sample", ticket: "EX-1", session: "one", generation: 1 };
      const mutate = <T>(action: () => Promise<T>) => guarded(worker, () => {}, action);
      const launch = (args = ["--model", "route-model", "--effort", "high"]) =>
        mutate(() =>
          runtime.launch({
            workspace,
            worker,
            command: "",
            args,
            env: {
              FAKE_AUTH: auth,
              XDG_CONFIG_HOME: join(root, "config"),
              FAKE_RUN_MARKER: join(root, "run"),
              ...launchEnv,
            },
          }),
        );
      const reopen = () => {
        const fresh = createLocalNode({ workspaceRoot: join(root, "worktrees"), transport: "pipe", outputTail });
        assert(unbound.withNode);
        return unbound.withNode(fresh);
      };
      return { root, runtime, node, workspace, mutate, launch, reopen };
    }

    test("translates routing flags, preserves messages and resumes the exact CLI session", async () => {
      const { runtime, node, workspace, mutate, launch } = await setup();
      const ref = await launch();
      try {
        expect((await runtime.observe(ref)).activity).toBe("idle");
        const message = "brief\nwith 'quotes' and $(literal)";
        await Promise.all([
          mutate(() => runtime.deliver(ref, message, "brief")),
          mutate(() => runtime.deliver(ref, message, "brief")),
        ]);
        const first = await until(runtime, ref, (v) => v.activity === "idle");
        const result = JSON.parse(first.reply ?? "");
        expect(result.input).toBe(message);
        if (kind === "codex") {
          expect(result.args).toContain('approval_policy="never"');
          expect(result.args).toContain('sandbox_mode="workspace-write"');
          expect(result.args).toContain("sandbox_workspace_write.network_access=true");
        } else expect(result.permission).toEqual({ "*": "allow" });
        expect(result.args).toContain("route-model");
        expect(result.args).toContain("space value");
        expect(result.args).not.toContain("--effort");
        expect(result.args).toContain(kind === "codex" ? 'model_reasoning_effort="high"' : "--variant");
        if (kind === "opencode") expect(result.args).toContain("high");
        await mutate(() => runtime.deliver(ref, message, "brief"));
        expect((await runtime.observe(ref)).reply).toBe(first.reply);
        await expect(mutate(() => runtime.deliver(ref, "different", "brief"))).rejects.toThrow("key");
        await mutate(() => runtime.deliver(ref, "follow-up", "answer"));
        const second = JSON.parse((await until(runtime, ref, (v) => v.activity === "idle")).reply ?? "");
        expect(second.input).toBe("follow-up");
        if (kind === "codex") {
          expect(second.args).toContain('approval_policy="never"');
          expect(second.args).toContain('sandbox_mode="workspace-write"');
          expect(second.args).toContain("sandbox_workspace_write.network_access=true");
        } else expect(second.permission).toEqual({ "*": "allow" });
        expect(second.args).toContain(kind === "codex" ? "resume" : "--session");
        expect(second.args).toContain("session-fixture-1");
        const stale = { ...ref, generation: 2 };
        await expect(mutate(() => runtime.deliver(stale, "wrong", "stale"))).rejects.toThrow("generation");
        await expect(mutate(() => runtime.stop(stale))).rejects.toThrow("generation");
        expect((await runtime.observe(ref)).state).toBe("running");
        await mutate(() => runtime.deliver(ref, "hold", "hold"));
        expect((await runtime.observe(ref)).activity).toBe("working");
      } finally {
        await mutate(() => runtime.stop(ref));
      }
      expect((await runtime.observe(ref)).state).toBe("stopped");
      expect((await runtime.observe(ref)).activity).toBe("idle");
      await node.dispose?.(workspace);
    }, 20_000);

    for (const permissionMode of ["default", kind === "codex" ? "read-only" : "deny"]) {
      test(`configured permission mode reaches the executable: ${permissionMode}`, async () => {
        const { runtime, mutate, launch } = await setup("yes", 65_536, { permissionMode });
        const ref = await launch([]);
        try {
          await mutate(() => runtime.deliver(ref, "configured mode", "brief"));
          const result = JSON.parse((await until(runtime, ref, (v) => v.activity === "idle")).reply ?? "");
          if (kind === "codex") {
            expect(result.args.includes('approval_policy="never"')).toBe(permissionMode !== "default");
            expect(result.args.includes('sandbox_mode="read-only"')).toBe(permissionMode === "read-only");
          } else expect(result.permission).toEqual(permissionMode === "default" ? null : { "*": "deny" });
        } finally {
          await mutate(() => runtime.stop(ref));
        }
      });
    }

    for (const overrides of kind === "codex"
      ? [
          ["-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="read-only"'],
          ["-a", "on-request", "--sandbox", "read-only"],
          ["--approve-for-me"],
          ['--config=approval_policy="on-request"', '--config=sandbox_mode="read-only"'],
        ]
      : [[]]) {
      test(`explicit permission configuration wins over unattended defaults: ${overrides}`, async () => {
        const { runtime, mutate, launch } = await setup(
          "yes",
          65_536,
          kind === "codex" ? { extraArgs: overrides } : {},
          kind === "opencode" ? { OPENCODE_PERMISSION: '{"*":"deny"}' } : {},
        );
        const ref = await launch([]);
        try {
          await mutate(() => runtime.deliver(ref, "override", "brief"));
          const result = JSON.parse((await until(runtime, ref, (v) => v.activity === "idle")).reply ?? "");
          if (kind === "codex") {
            expect(result.args).toEqual(expect.arrayContaining(overrides));
            expect(result.args).not.toContain('approval_policy="never"');
            expect(result.args).not.toContain('sandbox_mode="workspace-write"');
          } else expect(result.permission).toEqual({ "*": "deny" });
          await mutate(() => runtime.deliver(ref, "resume override", "answer"));
          const resumed = JSON.parse((await until(runtime, ref, (v) => v.activity === "idle")).reply ?? "");
          if (kind === "codex") expect(resumed.args).toEqual(expect.arrayContaining(overrides));
          else expect(resumed.permission).toEqual({ "*": "deny" });
        } finally {
          await mutate(() => runtime.stop(ref));
        }
      });
    }

    for (const input of ["permission-denied", "permission-hold"]) {
      test(`permission failure reaches the watchdog without raw diagnostics: ${input}`, async () => {
        const { runtime, mutate, launch } = await setup();
        const ref = await launch([]);
        try {
          await mutate(() => runtime.deliver(ref, input, "brief"));
          await until(runtime, ref, (v) => v.state === "failed");
          const tail = await runtime.transcript?.(ref, 4096);
          expect(tail).toContain('"permission":true');
          expect(tail).not.toContain("private diagnostic");
        } finally {
          await mutate(() => runtime.stop(ref));
        }
      });
    }

    test("a fresh runtime reattaches and resumes the same CLI session without counting a delivery retry twice", async () => {
      const { runtime, workspace, mutate, launch, reopen } = await setup();
      const ref = await launch();
      let attached = runtime;
      try {
        await mutate(() => runtime.deliver(ref, "first", "first"));
        await until(runtime, ref, (v) => v.activity === "idle");
        attached = reopen();
        assert(attached.adopt);
        await attached.adopt(ref, workspace, runtime.checkpoint?.(ref));
        assert.equal((await attached.observe(ref)).activity, "idle");
        await mutate(() => attached.deliver(ref, "first", "first"));
        assert.equal((await attached.observe(ref)).activity, "idle");
        await mutate(() => attached.deliver(ref, "after restart", "answer"));
        const reply = JSON.parse((await until(attached, ref, (v) => v.activity === "idle")).reply ?? "");
        assert.equal(reply.input, "after restart");
        assert(reply.args.includes("session-fixture-1"));
      } finally {
        await mutate(() => attached.stop(ref));
      }
    });

    test("refuses missing credentials before any inference and leaves the workspace disposable", async () => {
      const { root, runtime, node, workspace, mutate, launch } = await setup("no");
      const ref = await launch();
      expect((await runtime.observe(ref)).state).toBe("failed");
      try {
        await expect(mutate(() => runtime.deliver(ref, "brief", "brief"))).rejects.toThrow(
          kind === "codex" ? "codex login" : "opencode auth login",
        );
      } finally {
        await mutate(() => runtime.stop(ref));
      }
      await expect(readFile(join(root, "run"))).rejects.toMatchObject({ code: "ENOENT" });
      await node.dispose?.(workspace);
    });

    test("uses contribution model and effort when routing supplies no override", async () => {
      const { runtime, node, workspace, mutate, launch } = await setup();
      const ref = await launch([]);
      try {
        await mutate(() => runtime.deliver(ref, "configured", "brief"));
        const result = JSON.parse((await until(runtime, ref, (v) => v.activity === "idle")).reply ?? "");
        expect(result.args).toContain("configured-model");
        expect(result.args).toContain(kind === "codex" ? 'model_reasoning_effort="low"' : "low");
      } finally {
        await mutate(() => runtime.stop(ref));
      }
      await node.dispose?.(workspace);
    });

    for (const mode of ["ordinary", "rules-change"] as const) {
      test(`daemon retires a refused launch and allows retry (${mode})`, async () => {
        const root = await mkdtemp(join(tmpdir(), `${kind}-launch-refusal-`));
        roots.push(root);
        const result = await execute(
          "node",
          [fileURLToPath(new URL("./service-refusal.mjs", import.meta.url)), kind, root, mode],
          { timeout: 10_000 },
        );
        const observed = JSON.parse(result.stdout);
        expect(observed.remaining).toEqual([]);
        expect(observed.receipts).toMatchObject([{ key: "refused", result: { ok: false, code: "launch_failed" } }]);
        expect(observed.released).toBe(true); // Even a refused startup now has a separately recorded launch generation.
        expect(observed.active).toBe(0);
        expect(observed.retry).toBe(true);
      }, 15_000);
    }

    test("returns to idle when completed queued turns roll out of the node's transcript tail", async () => {
      const { root, runtime, node, workspace, mutate, launch } = await setup("yes", 512);
      const ref = await launch();
      try {
        await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            mutate(() => runtime.deliver(ref, `queued-${index}`, `key-${index}`)),
          ),
        );
        // Observe only after the final CLI has started; prior completion lines have rolled away.
        const deadline = Date.now() + 5_000;
        while ((await readFile(join(root, "run"), "utf8").catch(() => "")) !== "queued-9") {
          if (Date.now() >= deadline) throw new Error("Fixture did not receive the queued turns");
          await setImmediate();
        }
        const result = await until(runtime, ref, (v) => v.activity === "idle", 2_000);
        expect(JSON.parse(result.reply ?? "").input).toBe("queued-9");
      } finally {
        await mutate(() => runtime.stop(ref));
      }
      await node.dispose?.(workspace);
    });

    test("surfaces structured turn failures without treating an exited CLI as successful", async () => {
      const { runtime, node, workspace, mutate, launch } = await setup();
      const ref = await launch();
      try {
        await mutate(() => runtime.deliver(ref, "fail", "failure"));
        const result = await until(runtime, ref, (v) => v.state === "failed");
        expect(result.reply).toContain("turn failed");
      } finally {
        await mutate(() => runtime.stop(ref));
      }
      await node.dispose?.(workspace);
    });
  });
}
