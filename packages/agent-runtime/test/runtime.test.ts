import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, type Driver, type Grant, Journal, Runner } from "../src/index.ts";

const grant: Grant = {
  token: "fixture-ephemeral-secret",
  sandboxId: "logical",
  generation: "g1",
  expiresAt: Date.now() + 60000,
};
const unused: Driver = {
  start() {
    throw Error("not used");
  },
  async close() {},
};
function setup(drivers = { claude: unused, codex: unused }) {
  const dir = mkdtempSync(join(tmpdir(), "armada-runner-"));
  const path = join(dir, "journal");
  const journal = new Journal(path, (t) => t.replaceAll(grant.token, "[REDACTED]"));
  const runner = new Runner(journal, grant, drivers);
  return {
    dir,
    path,
    journal,
    runner,
    close() {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
interface Envelope {
  result: {
    status: string;
    done: boolean;
    events: unknown[];
    exitCode: number;
    processId: number;
    promptId: string;
    conversationId: string;
    watermark: number;
    acknowledgedSequence: number;
  };
}
async function payload(response: Response): Promise<Envelope> {
  return response.json() as Promise<Envelope>;
}
async function call(runner: Runner, body: Record<string, unknown>, token = grant.token) {
  return runner.handle(
    new Request("https://runner/v1", {
      method: "POST",
      headers: { [AUTH_HEADER]: token },
      body: JSON.stringify({ version: 1, sandboxId: "logical", requestId: crypto.randomUUID(), ...body }),
    }),
  );
}
// Audit: transport refusal and durable replay protect different boundaries from driver semantics.
test("auth refuses before dispatch; real WAL survives restart and reconciles lost turns honestly", async () => {
  const s = setup();
  try {
    expect((await call(s.runner, { op: "health" }, "wrong")).status).toBe(401);
    s.journal.transition(
      {
        promptId: "p",
        conversationId: "c",
        status: "running",
        request: { sandboxId: "logical", harness: "claude", text: grant.token },
      },
      "running",
    );
    s.journal.saveSession("c", "claude", "official-session");
    s.journal.close();
    const restored = new Journal(s.path, (t) => t.replaceAll(grant.token, "[REDACTED]"));
    const runner = new Runner(restored, grant, { claude: unused, codex: unused });
    const response = await call(runner, { op: "getPrompt", promptId: "p" });
    expect((await payload(response)).result).toMatchObject({ status: "failed", done: true });
    const replay = await payload(await call(runner, { op: "events" }));
    expect(replay.result.events).toHaveLength(2);
    expect(JSON.stringify(replay)).not.toContain(grant.token);
    expect(restored.session("c")).toBe("official-session");
    restored.close();
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
test.skipIf(process.platform !== "linux")(
  "real command timeout kills process group and detached PID retains terminal evidence",
  async () => {
    const s = setup();
    try {
      const response = await call(s.runner, {
        op: "exec",
        input: { sandboxId: "logical", command: "sleep 60", timeoutSeconds: 0 },
      });
      const { result } = await payload(response);
      expect(result).toMatchObject({ timedOut: true, detached: false });
      expect(result.exitCode).not.toBe(0);
      const detached = await (
        await call(s.runner, { op: "exec", input: { sandboxId: "logical", command: "printf done", detached: true } })
      )
        .json()
        .then((x) => x as Envelope);
      expect(detached.result.processId).toBeGreaterThan(0);
      // A real checkpoint is the completion barrier, not a wall-clock sleep.
      await call(s.runner, { op: "checkpoint" });
      const state = await payload(await call(s.runner, { op: "getExec", processId: detached.result.processId }));
      expect(state.result).toMatchObject({ status: "exited", exitCode: 0, stdout: "done" });
    } finally {
      s.close();
    }
  },
);
test("independent conversations, native steering and checkpoint wait for upstream ack", async () => {
  const running = new Map<string, { resolve: (s: "finished" | "interrupted") => void; steers: string[] }>();
  const driver: Driver = {
    start(c) {
      let resolve!: (s: "finished" | "interrupted") => void;
      const done = new Promise<"finished" | "interrupted">((r) => {
        resolve = r;
      });
      const item = { resolve, steers: [] as string[] };
      running.set(c.request.text, item);
      c.session(`session-${c.request.text}`);
      return {
        done,
        async interrupt() {
          resolve("interrupted");
        },
        async steer(text) {
          item.steers.push(text);
        },
      };
    },
    async close() {},
  };
  const s = setup({ claude: driver, codex: driver });
  try {
    const a = await (
      await call(s.runner, { op: "prompt", input: { sandboxId: "logical", harness: "claude", text: "one" } })
    )
      .json()
      .then((x) => x as Envelope);
    const b = await (
      await call(s.runner, { op: "prompt", input: { sandboxId: "logical", harness: "codex", text: "two" } })
    )
      .json()
      .then((x) => x as Envelope);
    expect((await call(s.runner, { op: "steer", conversationId: a.result.conversationId, text: "new" })).status).toBe(
      200,
    );
    expect(running.get("one")?.steers).toEqual(["new"]);
    await call(s.runner, { op: "interrupt", conversationId: a.result.conversationId });
    expect((await payload(await call(s.runner, { op: "getPrompt", promptId: b.result.promptId }))).result.status).toBe(
      "running",
    );
    expect((await call(s.runner, { op: "steer", conversationId: a.result.conversationId, text: "late" })).status).toBe(
      409,
    );
    expect((await call(s.runner, { op: "checkpoint" })).status).toBe(409);
    const runner = new Runner(
      s.journal,
      grant,
      { claude: unused, codex: unused },
      {
        async append(batch) {
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
    );
    const checkpoint = await payload(await call(runner, { op: "checkpoint", requestId: "checkpoint-retry" }));
    expect(checkpoint.result.watermark).toBeGreaterThan(0);
    expect(checkpoint.result.acknowledgedSequence).toBe(checkpoint.result.watermark);
    const restored = new Runner(
      s.journal,
      { ...grant, generation: "g2" },
      { claude: unused, codex: unused },
      {
        async append(batch) {
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
    );
    await call(restored, { op: "prompt", input: { sandboxId: "logical", harness: "claude", text: "after restore" } });
    const fresh = await payload(await call(restored, { op: "checkpoint", requestId: "checkpoint-retry" }));
    expect(fresh.result.watermark).toBeGreaterThan(checkpoint.result.watermark);
  } finally {
    s.close();
  }
});
test.skipIf(process.platform !== "linux")(
  "checkpoint refuses live detached groups after restart and never signals unverifiable recycled identities",
  async () => {
    const s = setup();
    let pid: number | undefined;
    try {
      const receipt = await payload(
        await call(s.runner, { op: "exec", input: { sandboxId: "logical", command: "exec sleep 60", detached: true } }),
      );
      pid = receipt.result.processId;
      const restored = new Runner(s.journal, { ...grant, generation: "g2" }, { claude: unused, codex: unused });
      expect((await payload(await call(restored, { op: "getExec", processId: pid }))).result.status).toBe(
        "running_after_restart",
      );
      const blocked = await call(restored, { op: "checkpoint" });
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: string }).error).toBe("checkpoint_exec_processes_live");
      const row = s.journal.db.query("SELECT body FROM processes WHERE pid=?").get(pid) as { body: string };
      const record = JSON.parse(row.body);
      s.journal.db
        .query("UPDATE processes SET body=? WHERE pid=?")
        .run(JSON.stringify({ ...record, identity: { ...record.identity, start: "different-process-birth" } }), pid);
      const unknown = new Runner(s.journal, { ...grant, generation: "g3" }, { claude: unused, codex: unused });
      expect((await call(unknown, { op: "checkpoint" })).status).toBe(409);
      expect(() => process.kill(pid as number, 0)).not.toThrow();
    } finally {
      if (pid)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      for (let attempt = 0; attempt < 10000 && pid; attempt++) {
        const row = s.journal.db.query("SELECT body FROM processes WHERE pid=?").get(pid) as { body: string };
        if (JSON.parse(row.body).status === "exited") break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      s.close();
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "checkpoint reconciles completed exec with unavailable process birth evidence",
  async () => {
    const s = setup();
    try {
      const response = await call(s.runner, {
        op: "exec",
        input: { sandboxId: "logical", command: "printf completed" },
      });
      expect((await payload(response)).result).toMatchObject({ exitCode: 0, stdout: "completed" });
      const rows = s.journal.db.query("SELECT pid,body FROM processes").all() as { pid: number; body: string }[];
      for (const row of rows) {
        const record = JSON.parse(row.body);
        delete record.identity;
        s.journal.db.query("UPDATE processes SET body=? WHERE pid=?").run(JSON.stringify(record), row.pid);
      }
      const restarted = new Runner(s.journal, grant, { claude: unused, codex: unused });
      expect((await call(restarted, { op: "checkpoint" })).status).toBe(200);
    } finally {
      s.close();
    }
  },
);
