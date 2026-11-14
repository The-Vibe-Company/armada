import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, Runner, type RunnerRequest } from "../src/index.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-workspace-")),
    home = join(root, "home");
  await mkdir(home);
  const journal = new Journal(join(root, "journal"), (v) => v),
    grant = { sandboxId: "workspace", generation: "1", token: "x".repeat(32), expiresAt: Date.now() + 60000 };
  let starts = 0;
  const runner = new Runner(
    journal,
    grant,
    {
      codex: {
        start() {
          starts++;
          return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
        },
        async close() {},
      },
    },
    undefined,
    undefined,
    undefined,
    { execEnv: { HOME: home, PATH: "/usr/bin:/bin" } },
  );
  const call = (r: RunnerRequest, signal?: AbortSignal) =>
    runner.handle(
      new Request("http://runtime/v1", {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify(r),
        ...(signal ? { signal } : {}),
      }),
    );
  const step = (id: string, cmd: string, cwd: string, phase: "repository" | "init" = "init", signal?: AbortSignal) =>
    call(
      {
        version: 1,
        sandboxId: grant.sandboxId,
        requestId: id,
        op: "workspaceExec",
        input: { command: cmd, cwd, timeoutSeconds: 600, phase, index: 0, attempt: 0 },
      },
      signal,
    );
  return {
    root,
    home,
    journal,
    grant,
    call,
    step,
    starts: () => starts,
    async close() {
      journal.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Core launch tests own the generated fast-forward policy. This boundary owns
// durable command execution, not Git's repository/commit/fast-forward engine.
test("private workspace command replay runs once without starting inference", async () => {
  const f = await fixture();
  try {
    const command = "printf 'ran\n' >> marker";
    const first = await (await f.step("init", command, f.home)).json();
    expect(first).toMatchObject({ result: { exitCode: 0, detached: false, timedOut: false } });
    expect(await (await f.step("init", command, f.home)).json()).toEqual(first);
    expect(await readFile(join(f.home, "marker"), "utf8")).toBe("ran\n");
    expect(f.starts()).toBe(0);
    expect(
      f.journal
        .events(0, 100)
        .filter(
          (e) =>
            e.event.kind === "other" &&
            e.event.type === "armada/workspaceStep" &&
            (e.event.data as { status: string }).status !== "running",
        ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("workspace cancellation kills owned descendants and blocks inference until cleanup; later turns cannot run launch setup", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    ready = Promise.withResolvers<{ pid: number; child: number }>();
  const server = createServer((s) => {
    let data = "";
    s.on("data", (c) => (data += c));
    s.on("end", () => ready.resolve(JSON.parse(data)));
  });
  await new Promise<void>((r) => server.listen(join(f.root, "ready.sock"), r));
  const script = `const{spawn}=require('child_process'),net=require('net');const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:['ignore',1,2]});const socket=net.connect(${JSON.stringify(join(f.root, "ready.sock"))},()=>socket.end(JSON.stringify({pid:process.pid,child:child.pid})));setInterval(()=>{},10000);`;
  try {
    const work = f.step("pending", `${quote(process.execPath)} -e ${quote(script)}`, f.home, "init", abort.signal);
    const pids = await Promise.race([
      ready.promise,
      work.then(() => {
        throw Error("Workspace exited before readiness");
      }),
    ]);
    const prompt: RunnerRequest = {
      version: 1,
      sandboxId: f.grant.sandboxId,
      requestId: "prompt",
      op: "prompt",
      input: { sandboxId: f.grant.sandboxId, harness: "codex", text: "must not overlap", cwd: f.home },
    };
    expect(await (await f.call(prompt)).json()).toMatchObject({ error: "workspace_setup_in_progress" });
    abort.abort();
    expect(await (await work).json()).toMatchObject({ result: { timedOut: true } });
    for (const pid of [pids.pid, pids.child]) {
      const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      expect(state.exitCode !== 0 || state.stdout.toString().trim().startsWith("Z")).toBe(true);
    }
    expect(f.starts()).toBe(0);
    await f.call({ ...prompt, requestId: "actual-prompt" });
    const restored = new Runner(f.journal, f.grant, {});
    expect(
      await (
        await restored.handle(
          new Request("http://runtime/v1", {
            method: "POST",
            headers: { "x-armada-runner-grant": f.grant.token },
            body: JSON.stringify({
              version: 1,
              sandboxId: f.grant.sandboxId,
              requestId: "too-late",
              op: "workspaceExec",
              input: { command: "exit 0", cwd: f.home, timeoutSeconds: 600, phase: "init", index: 0, attempt: 0 },
            }),
          }),
        )
      ).json(),
    ).toMatchObject({ error: "workspace_launch_only" });
  } finally {
    abort.abort();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
