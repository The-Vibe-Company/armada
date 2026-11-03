import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { projectTablesSchema, type ServerMessage, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import type { EventInput } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";
import { daemonEnv, daemonReady, nodeExecutable } from "./support/node.ts";

// Run alone via bun run bench: cold-process contention is not startup work.
// These generous deadlines catch hangs, not performance regressions.
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_WINDOW_RATIO = 1.8;
const MAX_WAKER_FRACTION = 0.5;

async function measure(t: TestContext, checkpoints: number, factCount = 3628) {
  const dir = mkdtempSync(join(tmpdir(), "armada-boot-bench-"));
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let socket: WebSocket | undefined;
  try {
    const database = join(dir, "fleet.sqlite");
    const base = { project: "orchard", actor: "coordinator", at: "2030-01-01T00:00:00Z" };
    // Same fleet history at both sizes; only coordinator turns double. Real pi
    // document mutations exercise restore, unlike the previous ID-only fixture.
    const facts: EventInput[] = Array.from({ length: factCount }, (_, i): EventInput => {
      const ticket = `ORC-${(i % 28) + 1}`;
      if (i < 2200)
        return {
          ...base,
          kind: "ticket.seen",
          payload: {
            id: ticket,
            title: "Plant the orchard",
            status: "started",
            phase: "implementing",
            description: "Synthetic ticket details. ".padEnd(1700, "x"),
            labels: [],
            blockers: [],
          },
        };
      if (i < 3000)
        return {
          ...base,
          kind: "session.reported",
          payload: {
            ticket,
            session: `tracker:${ticket}`,
            phase: "implementing",
            reason: "Synthetic work report. ".padEnd(1250, "x"),
          },
        };
      return {
        ...base,
        kind: "pull-request.seen",
        payload: {
          ticket,
          number: (i % 28) + 1,
          head: "a".repeat(40),
          ci: "pending",
          conflicting: false,
          state: "open",
          base: "synthetic-branch-".padEnd(1300, "x"),
        },
      };
    });
    const events: EventInput[] = [];
    for (let i = 0; i < checkpoints; i++) {
      if (i < facts.length) events.push(facts[i]!);
      const content = {
        kind: "base",
        version: 1,
        value: { chunks: Array.from({ length: 10 }, (_, j) => ({ id: j, text: "x".repeat(175) })), turn: i },
      };
      events.push({
        ...base,
        kind: "coordinator.checkpoint",
        payload: {
          checkpoint: {
            format: "armada.pi",
            version: 1,
            type: "commit",
            seq: i + 1,
            writes: [
              i === 0
                ? {
                    type: "document.create",
                    record: { id: 2, kind: "bench.notes", scope: { kind: "session" } },
                    content,
                  }
                : { type: "document.change", id: 2, content },
            ],
          },
        },
      });
    }
    const bytes = Buffer.byteLength(JSON.stringify(events));
    if (checkpoints >= 7623) assert.ok(bytes >= 23_000_000);
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
    before = performance.now();
    store.fold("orchard");
    const storeFoldMs = performance.now() - before;
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
    const daemon = spawn(
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
    child = daemon;
    exited = once(daemon, "exit");
    // The parent can kill a CPU-stalled child even before its signal handlers exist.
    watchdog = setTimeout(() => daemon.kill("SIGKILL"), PROCESS_TIMEOUT_MS);
    daemon.stderr.resume();
    lines = createInterface({ input: daemon.stdout });
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
    const ready = daemonReady(daemon);
    void ready.catch(() => {});
    const [line] = await first;
    const startingMs = performance.now() - startedAt;
    assert.deepEqual(JSON.parse(line), { starting: true });
    const address = await ready;
    const readyMs = performance.now() - startedAt;
    assert.equal(count, events.length);

    assert.equal(
      await (await fetch(address.url)).text(),
      "<title>Synthetic app</title>",
      "readiness means HTTP serves, even while providers hang",
    );
    socket = new WebSocket(address.wsUrl);
    const connection = socket;
    const snapshot = new Promise<ServerMessage>((resolve, reject) => {
      connection.on("message", (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type === "project.subscribed") resolve(frame);
      });
      connection.once("error", reject);
      connection.once("close", () => reject(new Error("closed before first snapshot")));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "project.subscribe", version, id: "boot", project: "orchard", after: 0 }));
    const frame = await snapshot;
    socket.terminate();
    assert.equal(frame.type, "project.subscribed");
    if (frame.type !== "project.subscribed") throw new Error("missing snapshot");
    assert.equal(projectTablesSchema.parse(frame.snapshot?.state).tickets.length, 28);
    const windowReadyMs = performance.now() - startedAt;
    const measurement = {
      checkpoints,
      bytes,
      events: events.length,
      initializeMs,
      readMs,
      foldMs,
      storeFoldMs,
      startingMs,
      readyMs,
      windowReadyMs,
      stages: address.timings,
    };
    t.diagnostic(JSON.stringify(measurement));
    return measurement;
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      await exited;
    } finally {
      clearTimeout(watchdog);
      lines?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function median(values: number[]) {
  const value = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  assert.ok(value !== undefined, "no benchmark samples");
  return value;
}

// The only absolute budget is cheap: a small real log. Slow hosts skip this
// budget explicitly, while retaining the large-log relative regression gates.
test("small-log window readiness", { timeout: PROCESS_TIMEOUT_MS + 30_000 }, async (t) => {
  const result = await measure(t, 32, 28);
  if (process.env.ARMADA_BENCH_SLOW === "1") {
    t.diagnostic("ARMADA_BENCH_SLOW=1: skipping only the small-log 5 s budget");
  } else {
    assert.ok(result.windowReadyMs < 5000, `small-log window readiness took ${result.windowReadyMs.toFixed(1)} ms`);
  }
});

test("checkpoint-heavy boot stays flat and Waker does not dominate", { timeout: 900_000 }, async (t) => {
  const windows: Record<number, number[]> = { 7623: [], 15246: [] };
  // Alternate sizes and take medians so one cold process or scheduling pause
  // cannot alone decide the scaling ratio. Fixture construction is unmeasured.
  for (let sample = 0; sample < 3; sample++) {
    for (const checkpoints of sample % 2 === 0 ? [7623, 15246] : [15246, 7623]) {
      const result = await measure(t, checkpoints);
      const samples = windows[checkpoints];
      assert.ok(samples);
      samples.push(result.windowReadyMs);
      const wakerMs = result.stages.coordinatorWakeMs;
      assert.ok(typeof wakerMs === "number" && Number.isFinite(wakerMs) && wakerMs >= 0, "missing Waker stage timing");
      const wakerFraction = wakerMs / result.windowReadyMs;
      t.diagnostic(JSON.stringify({ sample, checkpoints, wakerFraction }));
      // Old per-prefix refolding took ~29 s at BOTH sizes: a scaling ratio alone
      // would pass it. The stage fraction independently catches that regression.
      assert.ok(
        wakerFraction < MAX_WAKER_FRACTION,
        `Waker used ${(wakerFraction * 100).toFixed(1)}% of window readiness (limit ${MAX_WAKER_FRACTION * 100}%)`,
      );
    }
  }
  const normalMs = median(windows[7623] ?? []);
  const doubledMs = median(windows[15246] ?? []);
  const windowRatio = doubledMs / normalMs;
  t.diagnostic(JSON.stringify({ normalMs, doubledMs, windowRatio }));
  assert.ok(
    windowRatio < MAX_WINDOW_RATIO,
    `doubling checkpoints grew window readiness ${windowRatio.toFixed(2)}x (limit ${MAX_WINDOW_RATIO}x)`,
  );
});
