import { expect, test } from "bun:test";
import { AUTH_HEADER, type Driver, Journal, Runner, type RunnerRequest } from "../src/index.ts";

test.each([
  { count: 0, ack: 0 },
  { count: 3, ack: 3 },
  { count: 3, ack: 2 },
])("checkpoint watermark avoids transcript reads and requires upstream ACK: %j", async ({ count, ack }) => {
  const grant = {
    sandboxId: "watermark",
    generation: "1",
    token: "offline_watermark",
    expiresAt: Date.now() + 60000,
  };
  const journal = new Journal(":memory:", (value) => value);
  try {
    const runner = new Runner(journal, grant, {});
    // Invalid bodies make accidental transcript parsing fail without large allocations.
    for (let i = 0; i < count; i++) journal.db.query("INSERT INTO events(body) VALUES(?)").run("not_json");
    journal.ack = ack;
    journal.events = () => {
      throw Error("unexpected_event_history_read");
    };
    expect(journal.highWatermark()).toBe(count);
    const response = await runner.handle(
      new Request("https://runtime/v1", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, sandboxId: grant.sandboxId, requestId: "seal", op: "checkpoint" }),
      }),
    );
    const body = await response.text();
    if (ack < count) {
      expect(response.status).not.toBe(200);
      expect(body).toContain("checkpoint_upstream_unacknowledged");
      expect(() => journal.requireCheckpoint(grant, count, null)).toThrow("resume_checkpoint_mismatch");
    } else {
      expect(response.status).toBe(200);
      expect(JSON.parse(body).result).toMatchObject({ watermark: count, acknowledgedSequence: ack, generation: "1" });
      expect(() => journal.requireCheckpoint(grant, count, null)).not.toThrow();
    }
  } finally {
    journal.close();
  }
});

test("checkpoint interrupts an active turn and publishes its terminal event before sealing the journal", async () => {
  const grant = {
    sandboxId: "active_checkpoint",
    generation: "1",
    token: "offline_checkpoint",
    expiresAt: Date.now() + 60000,
  };
  const done = Promise.withResolvers<"interrupted">();
  const started = Promise.withResolvers<void>();
  const driver: Driver = {
    start(context) {
      context.session("native-thread");
      started.resolve();
      return {
        done: done.promise,
        async steer() {},
        async interrupt() {
          done.resolve("interrupted");
        },
      };
    },
    async close() {},
  };
  const journal = new Journal(":memory:", (value) => value);
  const delivered: unknown[] = [];
  const runner = new Runner(
    journal,
    grant,
    { codex: driver },
    {
      async append({ events }) {
        delivered.push(...events.map(({ event }) => event));
        return { acknowledgedSequence: events.at(-1)!.sequence };
      },
    },
  );
  const call = (request: Pick<RunnerRequest, "op" | "requestId"> & { input?: object }) =>
    runner.handle(
      new Request("https://runtime/v1", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ ...request, version: 1, sandboxId: grant.sandboxId }),
      }),
    );

  try {
    const input = { sandboxId: grant.sandboxId, harness: "codex", text: "active turn" };
    const prompt = await call({ requestId: "prompt", op: "prompt", input });
    expect(prompt.status).toBe(200);
    const { result } = await prompt.json();
    await started.promise;

    const checkpoint = await call({ requestId: "checkpoint", op: "checkpoint" });
    expect(checkpoint.status).toBe(200);
    const watermark = journal.highWatermark();
    expect(await checkpoint.json()).toMatchObject({
      result: { watermark, acknowledgedSequence: watermark, generation: grant.generation },
    });
    expect(delivered).toContainEqual(
      expect.objectContaining({ kind: "prompt", promptId: result.promptId, status: "interrupted" }),
    );
    expect(() => journal.requireCheckpoint(grant, watermark, result.conversationId)).not.toThrow();
    const blocked = await call({ requestId: "blocked", op: "prompt", input });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("checkpoint_in_progress");
  } finally {
    done.resolve("interrupted");
    await runner.close();
    journal.close();
  }
});
