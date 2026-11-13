import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullCommand } from "../../core/src/golden-config.ts";
import { Journal, Runner, type RunnerRequest } from "../src/index.ts";

const git = "/usr/lib/git-core/git";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-workspace-")),
    home = join(root, "home"),
    bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await symlink(git, join(bin, "git"));
  const command = (...args: string[]) => {
    const r = Bun.spawnSync([git, ...args], { env: { PATH: "/usr/bin:/bin", HOME: home } });
    if (r.exitCode) throw Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
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
    { execEnv: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } },
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
    command,
    starts: () => starts,
    async close() {
      journal.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
test("private runtime workspace performs a real fast-forward before init, replays once, and never resets a divergent checkout", async () => {
  const f = await fixture(),
    origin = join(f.root, "origin"),
    writer = join(f.root, "writer"),
    checkout = join(f.root, "checkout");
  try {
    f.command("init", "--bare", origin);
    f.command("init", "-b", "main", writer);
    f.command("-C", writer, "config", "user.name", "Fixture");
    f.command("-C", writer, "config", "user.email", "fixture@example.test");
    await writeFile(join(writer, "file"), "first");
    f.command("-C", writer, "add", "file");
    f.command("-C", writer, "-c", "commit.gpgsign=false", "commit", "-m", "first");
    f.command("-C", writer, "remote", "add", "origin", origin);
    f.command("-C", writer, "push", "origin", "main");
    f.command("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main");
    f.command("clone", origin, checkout);
    await writeFile(join(writer, "file"), "second");
    f.command("-C", writer, "-c", "commit.gpgsign=false", "commit", "-am", "second");
    f.command("-C", writer, "push", "origin", "main");
    const head = f.command("-C", writer, "rev-parse", "HEAD"),
      spec = pullCommand({ url: "https://github.com/fixture/project.git", branch: "main", dir: "project" });
    // Private transport takes the server's cwd; production server uses the shared
    // native /home/user builders. No test-only workspace-root option is needed.
    expect(await (await f.step("pull", spec.command, checkout, "repository")).json()).toMatchObject({
      result: { exitCode: 0, detached: false },
    });
    expect(f.command("-C", checkout, "rev-parse", "HEAD")).toBe(head);
    const init = `test "$(git rev-parse HEAD)" = ${quote(head)} && printf 'ran\\n' >> marker`;
    expect(await (await f.step("init", init, checkout)).json()).toMatchObject({ result: { exitCode: 0 } });
    expect((await f.step("init", init, checkout)).status).toBe(200);
    expect(await readFile(join(checkout, "marker"), "utf8")).toBe("ran\n");
    f.command(
      "-C",
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "local",
    );
    const local = f.command("-C", checkout, "rev-parse", "HEAD");
    await writeFile(join(writer, "file"), "third");
    f.command("-C", writer, "-c", "commit.gpgsign=false", "commit", "-am", "third");
    f.command("-C", writer, "push", "origin", "main");
    expect(await (await f.step("divergent", spec.command, checkout, "repository")).json()).toMatchObject({
      result: { exitCode: 128 },
    });
    expect(f.command("-C", checkout, "rev-parse", "HEAD")).toBe(local);
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
    ).toHaveLength(3);
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
