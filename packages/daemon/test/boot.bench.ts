import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { EventInput } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";
import { daemonEnv, daemonReady, nodeExecutable } from "./support/node.ts";

// Run alone after the daemon suite: CPU contention between cold Node processes
// is not daemon startup work. Setup is excluded; the deadline starts at spawn.
test("a 10 MB log announces liveness within 1 s and serves within 3 s while first readers hang", {
  timeout: 15000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-boot-bench-"));
  const database = join(dir, "fleet.sqlite");
  const events: EventInput[] = Array.from({ length: 5134 }, (_, i) => ({
    project: "orchard",
    actor: "coordinator",
    at: "2030-01-01T00:00:00Z",
    ...(i % 2
      ? {
          kind: "coordinator.checkpoint",
          payload: {
            checkpoint: {
              format: "armada.pi",
              version: 1,
              type: "id",
              id: i + 2,
              // Synthetic structured document data stresses JSON parsing and clone cost.
              documents: Array.from({ length: 12 }, (_, j) => ({ id: j, text: "x".repeat(160) })),
            },
          },
        }
      : { kind: "coordinator.message", payload: { role: "owner", body: "Synthetic history ".padEnd(2200, "x") } }),
  }));
  const bytes = Buffer.byteLength(JSON.stringify(events));
  assert.ok(bytes >= 10 * 1024 * 1024);
  let before = performance.now();
  const store = new EventStore(database);
  const initializeMs = performance.now() - before;
  store.appendMany(events);
  before = performance.now();
  const history = store.readSince(0, "orchard");
  const readMs = performance.now() - before;
  before = performance.now();
  fold(history);
  const foldMs = performance.now() - before;
  store.close();
  writeFileSync(
    join(dir, "projects.json"),
    JSON.stringify([
      {
        id: "orchard",
        name: "Orchard",
        repository: "example/orchard",
        programRoot: "SEED-1",
        coordinatorModel: {
          kind: "openai-compatible",
          config: { model: "offline-startup", baseURL: "http://fixture.invalid/v1", apiKeySecret: null },
        },
      },
    ]),
  );
  writeFileSync(join(dir, "index.html"), "<title>Synthetic app</title>");
  const startedAt = performance.now();
  const child = spawn(
    nodeExecutable,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("offline fixture aborted"));
      if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, {once:true});
    });`)}`,
      new URL("../src/server/main.ts", import.meta.url).pathname,
      "--database",
      database,
      "--projects",
      join(dir, "projects.json"),
      "--port",
      "0",
      "--static-dir",
      dir,
    ],
    {
      env: {
        ...daemonEnv(dir),
        ARMADA_APP_CONFIG: join(dir, "config.json"),
        LINEAR_API_KEY: "synthetic-linear-boot-key",
        GITHUB_TOKEN: "synthetic-github-boot-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  // The parent can kill a CPU-stalled child even before its signal handlers exist.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const first = Promise.race([
    once(lines, "line"),
    exited.then(() => {
      throw new Error("daemon exited before announcing startup");
    }),
  ]);
  let count: number | undefined;
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.starting && value.events !== undefined) count = value.events;
  });
  const ready = daemonReady(child);
  void ready.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    clearTimeout(watchdog);
    lines.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const [line] = await first;
  const startingMs = performance.now() - startedAt;
  assert.deepEqual(JSON.parse(line), { starting: true });
  assert.ok(startingMs < 1000, `starting took ${startingMs.toFixed(1)} ms`);
  const address = await ready;
  const readyMs = performance.now() - startedAt;
  t.diagnostic(
    JSON.stringify({
      bytes,
      events: events.length,
      initializeMs,
      readMs,
      foldMs,
      startingMs,
      readyMs,
      stages: address.timings,
    }),
  );
  assert.equal(count, events.length);
  assert.ok(readyMs < 3000, `readiness took ${readyMs.toFixed(1)} ms`);
  assert.equal(
    await (await fetch(address.url)).text(),
    "<title>Synthetic app</title>",
    "readiness means HTTP serves, even while providers hang",
  );
});
