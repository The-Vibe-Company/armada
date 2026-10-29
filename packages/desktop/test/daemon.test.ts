import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonProcess } from "../src/daemon.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "armada-desktop-"));
  const projects = join(dir, "projects.json");
  writeFileSync(projects, JSON.stringify([{ id: "orchard", name: "Orchard", repository: "example/orchard" }]));
  writeFileSync(join(dir, "index.html"), "<title>Armada</title>");
  return {
    dir,
    options: {
      executable: process.execPath,
      entry: fileURLToPath(new URL("../../daemon/src/server/main.ts", import.meta.url)),
      database: join(dir, "fleet.sqlite"),
      projects,
      staticDir: dir,
      env: { ...process.env, XDG_CONFIG_HOME: dir, ARMADA_APP_CONFIG: join(dir, "config.json") },
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
