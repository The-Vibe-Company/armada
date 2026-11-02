import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { projectTablesSchema, type ServerMessage, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import type { EventInput } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";
import { daemonEnv, daemonReady, nodeExecutable } from "./support/node.ts";

// Run alone: cold-process CPU contention is not startup work. Setup is excluded.
for (const checkpoints of [7623, 15246]) {
  test(`checkpoint-heavy boot (${checkpoints} checkpoints) serves the hangar within 5 s`, {
    timeout: 30000,
  }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "armada-boot-bench-"));
    const database = join(dir, "fleet.sqlite");
    const base = { project: "orchard", actor: "coordinator", at: "2030-01-01T00:00:00Z" };
    // Same fleet history at both sizes; only coordinator turns double. Real pi
    // document mutations exercise restore, unlike the previous ID-only fixture.
    const facts: EventInput[] = Array.from({ length: 3628 }, (_, i): EventInput => {
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
    assert.ok(bytes >= 23_000_000);
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
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
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
        storeFoldMs,
        startingMs,
        readyMs,
        stages: address.timings,
      }),
    );
    assert.equal(count, events.length);

    assert.equal(
      await (await fetch(address.url)).text(),
      "<title>Synthetic app</title>",
      "readiness means HTTP serves, even while providers hang",
    );
    const socket = new WebSocket(address.wsUrl);
    const snapshot = new Promise<ServerMessage>((resolve, reject) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type === "project.subscribed") resolve(frame);
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("closed before first snapshot")));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "project.subscribe", version, id: "boot", project: "orchard", after: 0 }));
    const frame = await snapshot;
    socket.terminate();
    assert.equal(frame.type, "project.subscribed");
    if (frame.type !== "project.subscribed") throw new Error("missing snapshot");
    assert.equal(projectTablesSchema.parse(frame.snapshot?.state).tickets.length, 28);
    const windowReadyMs = performance.now() - startedAt;
    t.diagnostic(JSON.stringify({ checkpoints, readyMs, windowReadyMs }));
    assert.ok(windowReadyMs < 5000, `window readiness took ${windowReadyMs.toFixed(1)} ms`);
  });
}
