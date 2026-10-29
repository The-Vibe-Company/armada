import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonProcess, RESTART_EXIT_CODE, restartDaemon } from "../src/daemon.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "armada-desktop-"));
  const projects = join(dir, "projects.json");
  writeFileSync(projects, JSON.stringify([{ id: "orchard", name: "Orchard", repository: "example/orchard" }]));
  writeFileSync(join(dir, "index.html"), "<title>Armada</title>");
  return {
    dir,
    options: {
      executable: "node",
      entry: fileURLToPath(new URL("../../daemon/src/server/main.ts", import.meta.url)),
      database: join(dir, "fleet.sqlite"),
      projects,
      staticDir: dir,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: dir,
        ARMADA_APP_CONFIG: join(dir, "config.json"),
        GITHUB_TOKEN: randomBytes(24).toString("hex"),
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline fixture"); };')}`,
      },
    },
  };
}

function gone(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("ready daemon serves the app on an allocated port; repeated stop awaits process removal", async () => {
  const f = fixture();
  const daemon = new DaemonProcess(f.options);
  try {
    const address = await daemon.ready;
    assert.ok(Number(new URL(address.url).port) > 0);
    assert.equal(address.wsUrl, `${address.url.replace("http:", "ws:")}/`);
    assert.equal(await (await fetch(address.url)).text(), "<title>Armada</title>");
    assert.doesNotThrow(() => process.kill(daemon.pid, 0));
    await Promise.all([daemon.stop(), daemon.stop()]);
    assert.equal((await daemon.exited).code, 0);
    gone(daemon.pid);
  } finally {
    await daemon.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

/** Asks the daemon at `wsUrl` to restart, as the app's Restart button does, and reads its answer. */
async function askRestart(wsUrl: string): Promise<string> {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const answer = new Promise<string>((resolve) =>
    ws.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)).type), { once: true }),
  );
  ws.send(JSON.stringify({ version: { major: 1, minor: 2 }, id: "restart-1", type: "daemon.restart" }));
  return answer;
}

test("the app's restart ends a restartable daemon with the restart code; it comes back on its port, else another", async () => {
  const f = fixture();
  const children: DaemonProcess[] = [];
  const start = (port: number) => {
    const child = new DaemonProcess({ ...f.options, port, restartable: true });
    children.push(child);
    return child;
  };
  const blocker = createServer();
  try {
    const first = start(0);
    const address = await first.ready;
    assert.equal(await askRestart(address.wsUrl), "daemon.restarting");
    assert.equal((await first.exited).code, RESTART_EXIT_CODE);
    gone(first.pid);
    // Its port is free again: the same address, so the app's socket reconnects on its own.
    const again = await restartDaemon(address, start);
    assert.deepEqual(again, address);
    assert.equal(await (await fetch(again.url)).text(), "<title>Armada</title>");
    assert.equal(await askRestart(again.wsUrl), "daemon.restarting");
    assert.equal((await children[1]?.exited)?.code, RESTART_EXIT_CODE);
    // Taken meanwhile: another port.
    await new Promise<void>((resolve) => blocker.listen(Number(new URL(address.url).port), "127.0.0.1", resolve));
    const moved = await restartDaemon(address, start);
    assert.notEqual(moved.url, address.url);
    assert.equal(await (await fetch(moved.url)).text(), "<title>Armada</title>");
  } finally {
    blocker.close();
    await Promise.all(children.map((child) => child.stop()));
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a quit during a restart's first attempt starts no second daemon", async () => {
  const ports: number[] = [];
  let quitting = false;
  const start = (port: number) => {
    ports.push(port);
    // The quit stops this child, which rejects its readiness.
    quitting = true;
    return { ready: Promise.reject(new Error("armadad stopped before readiness")) } as unknown as DaemonProcess;
  };
  await assert.rejects(
    restartDaemon({ url: "http://127.0.0.1:4999", wsUrl: "ws://127.0.0.1:4999/" }, start, () => quitting),
    /stopped before readiness/,
  );
  assert.deepEqual(ports, [4999]);
});

test("startup failure rejects readiness and reaps the failed child", async () => {
  const f = fixture();
  writeFileSync(f.options.projects, "invalid");
  const daemon = new DaemonProcess(f.options);
  try {
    await assert.rejects(daemon.ready, /exited before readiness/);
    await daemon.stop();
    gone(daemon.pid);
  } finally {
    await daemon.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("stopping during startup rejects readiness and leaves no child", async () => {
  const f = fixture();
  const daemon = new DaemonProcess(f.options);
  const readiness = assert.rejects(daemon.ready, /stopped before readiness/);
  try {
    await daemon.stop();
    await readiness;
    gone(daemon.pid);
  } finally {
    await daemon.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("startup deadline kills an unresponsive child, including one ignoring SIGTERM", async () => {
  const f = fixture();
  const entry = join(f.dir, "stuck.mjs");
  // No sleep: the readiness deadline exercises the production timer and termination escalation.
  writeFileSync(entry, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const daemon = new DaemonProcess({ ...f.options, entry, startupMs: 1000, shutdownMs: 20 });
  try {
    await assert.rejects(daemon.ready, /readiness timed out/);
    await daemon.stop();
    assert.equal((await daemon.exited).signal, "SIGKILL");
    gone(daemon.pid);
  } finally {
    await daemon.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("spawn errors reject readiness without hanging shutdown", async () => {
  const f = fixture();
  const daemon = new DaemonProcess({ ...f.options, executable: join(f.dir, "missing-node") });
  try {
    await assert.rejects(daemon.ready, /Could not start armadad/);
    await daemon.stop();
  } finally {
    await daemon.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
