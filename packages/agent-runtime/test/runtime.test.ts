import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
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
  const journal = new Journal(":memory:", (t) => t.replaceAll(grant.token, "[REDACTED]"));
  const runner = new Runner(journal, grant, drivers);
  return {
    dir,
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
// Reconstructing a Runner exercises lost-turn reconciliation without disk-reopen latency.
test("auth refuses before dispatch; a fresh Runner reconciles lost turns and retains redacted sessions", async () => {
  const journal = new Journal(":memory:", (t) => t.replaceAll(grant.token, "[REDACTED]"));
  try {
    const initial = new Runner(journal, grant, { claude: unused, codex: unused });
    expect((await call(initial, { op: "health" }, "wrong")).status).toBe(401);
    journal.transition(
      {
        promptId: "p",
        conversationId: "c",
        status: "running",
        request: { sandboxId: "logical", harness: "claude", text: grant.token },
      },
      "running",
    );
    journal.saveSession("c", "claude", "official-session");
    const runner = new Runner(journal, grant, { claude: unused, codex: unused });
    const response = await call(runner, { op: "getPrompt", promptId: "p" });
    expect((await payload(response)).result).toMatchObject({ status: "failed", done: true });
    const replay = await payload(await call(runner, { op: "events" }));
    expect(replay.result.events).toHaveLength(2);
    expect(JSON.stringify(replay)).not.toContain(grant.token);
    expect(journal.session("c")).toBe("official-session");
  } finally {
    journal.close();
  }
});
test.skipIf(process.platform !== "linux")(
  "real exec timeout reconciles missing birth evidence and detached PID retains terminal output",
  async () => {
    // Exec recovery reuses one SQL connection; disk-reopen durability belongs to staging.
    const journal = new Journal(":memory:", (text) => text);
    const runner = new Runner(journal, grant, { claude: unused, codex: unused });
    try {
      const response = await call(runner, {
        op: "exec",
        input: { sandboxId: "logical", command: "sleep 60", timeoutSeconds: 0 },
      });
      const { result } = await payload(response);
      expect(result).toMatchObject({ timedOut: true, detached: false });
      expect(result.exitCode).not.toBe(0);
      // This real completed command also owns recovery without persisted birth evidence.
      const rows = journal.db.query("SELECT pid,body FROM processes").all() as { pid: number; body: string }[];
      for (const row of rows) {
        const record = JSON.parse(row.body);
        delete record.identity;
        journal.db.query("UPDATE processes SET body=? WHERE pid=?").run(JSON.stringify(record), row.pid);
      }
      const restarted = new Runner(journal, grant, { claude: unused, codex: unused });
      expect((await call(restarted, { op: "checkpoint" })).status).toBe(200);
      const resumed = new Runner(journal, { ...grant, generation: "g2" }, { claude: unused, codex: unused });
      const detached = await (
        await call(resumed, { op: "exec", input: { sandboxId: "logical", command: "printf done", detached: true } })
      )
        .json()
        .then((x) => x as Envelope);
      expect(detached.result.processId).toBeGreaterThan(0);
      // Live detached groups refuse checkpoint; observe terminal evidence without a timed sleep.
      let state: Envelope | undefined;
      for (let attempt = 0; attempt < 10000; attempt++) {
        state = await payload(await call(resumed, { op: "getExec", processId: detached.result.processId }));
        if (state.result.status === "exited") break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(state?.result).toMatchObject({ status: "exited", exitCode: 0, stdout: "done" });
    } finally {
      journal.close();
    }
  },
);
// Checkpoint ACK acceptance/refusal is owned by checkpoint-watermark.test.ts;
// do not replay it here through a disk journal and unrelated live turns.
function controlledConversations() {
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
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, { claude: driver, codex: driver });
  return { journal, runner, running };
}
test("interrupting one conversation leaves another running", async () => {
  const { journal, runner, running } = controlledConversations();
  try {
    const a = await payload(
      await call(runner, {
        op: "prompt",
        input: { sandboxId: "logical", harness: "claude", text: "one" },
      }),
    );
    const b = await payload(
      await call(runner, {
        op: "prompt",
        input: { sandboxId: "logical", harness: "codex", text: "two" },
      }),
    );
    expect(a.result.conversationId).not.toBe(b.result.conversationId);
    expect((await call(runner, { op: "interrupt", conversationId: a.result.conversationId })).status).toBe(200);
    expect((await payload(await call(runner, { op: "getPrompt", promptId: a.result.promptId }))).result.status).toBe(
      "interrupted",
    );
    expect((await payload(await call(runner, { op: "getPrompt", promptId: b.result.promptId }))).result.status).toBe(
      "running",
    );
    expect((await call(runner, { op: "checkpoint" })).status).toBe(409);
    await call(runner, { op: "interrupt", conversationId: b.result.conversationId });
    expect(running.size).toBe(2);
  } finally {
    journal.close();
  }
});
test("native steering reaches the active turn and refuses a terminal conversation", async () => {
  const { journal, runner, running } = controlledConversations();
  try {
    const a = await payload(
      await call(runner, {
        op: "prompt",
        input: { sandboxId: "logical", harness: "claude", text: "one" },
      }),
    );
    expect((await call(runner, { op: "steer", conversationId: a.result.conversationId, text: "new" })).status).toBe(
      200,
    );
    expect(running.get("one")?.steers).toEqual(["new"]);
    await call(runner, { op: "interrupt", conversationId: a.result.conversationId });
    expect((await call(runner, { op: "steer", conversationId: a.result.conversationId, text: "late" })).status).toBe(
      409,
    );
    expect(running.get("one")?.steers).toEqual(["new"]);
  } finally {
    journal.close();
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

test("revoking a dial-out request kills its synchronous exec before returning", async () => {
  const s = setup();
  const stop = new AbortController();
  const ready = join(s.dir, "ready");
  const watcher = watch(s.dir, () => {
    if (existsSync(ready)) stop.abort();
  });
  try {
    const reply = await s.runner.handle(
      new Request("https://runner/v1", {
        method: "POST",
        signal: stop.signal,
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({
          version: 1,
          sandboxId: "logical",
          requestId: crypto.randomUUID(),
          op: "exec",
          input: { sandboxId: "logical", command: `printf ready > '${ready}'; exec sleep 600` },
        }),
      }),
    );
    expect(stop.signal.aborted).toBe(true);
    expect(reply.status).toBe(200);
    const row = s.journal.db.query("SELECT body FROM processes").get() as { body: string };
    expect(JSON.parse(row.body).status).toBe("exited");
    expect(JSON.parse(row.body).exitCode).toBeNull();
  } finally {
    watcher.close();
    stop.abort();
    s.close();
  }
});
