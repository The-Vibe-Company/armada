import { expect, jest, test } from "bun:test";
import { type Driver, type IngestClient, Journal, Runner } from "../src/index.ts";

// Outbox admission: an untrusted acknowledgement must not advance the cursor or lose the pending event.
test.each(
  [
    null,
    [],
    {},
    { acknowledgedSequence: "invalid" },
    { acknowledgedSequence: "1" },
    { acknowledgedSequence: -1 },
    { acknowledgedSequence: 0.5 },
    { acknowledgedSequence: 1e30 },
    { acknowledgedSequence: 2 },
  ].map((body) => [body] as const),
)("malformed ingest acknowledgement %j preserves cursor and retries through a fresh Runner", async (body) => {
  const journal = new Journal(":memory:", (s) => s);
  const driver: Driver = {
    start() {
      throw Error("unused");
    },
    async close() {},
  };
  const grant = {
    token: "fixture-ingest-private-grant",
    sandboxId: "s",
    generation: "g1",
    expiresAt: Date.now() + 60000,
  };
  const bad: IngestClient = {
    async append() {
      return (await Response.json(body).json()) as { acknowledgedSequence: number };
    },
  };
  try {
    const runner = new Runner(journal, grant, { claude: driver, codex: driver }, bad);
    journal.append({ id: "event", at: 1, kind: "other", type: "fixture", data: {} });
    await expect(runner.flushOutbox()).rejects.toThrow("invalid_ingest_ack");
    expect(journal.ack).toBe(0);
    const retry = new Runner(
      journal,
      grant,
      { claude: driver, codex: driver },
      {
        async append(batch) {
          expect(batch.events).toMatchObject([{ sequence: 1, event: { id: "event" } }]);
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
    );
    await retry.flushOutbox();
    expect(journal.ack).toBe(1);
  } finally {
    journal.close();
  }
});

function outboxFixture(append: IngestClient["append"]) {
  const journal = new Journal(":memory:", (value) => value);
  const runner = new Runner(
    journal,
    { token: "fixture_ingest_private_grant", sandboxId: "s", generation: "g1", expiresAt: Date.now() + 60000 },
    {},
    { append },
  );
  const write = (id: string) => journal.append({ id, at: 1, kind: "other", type: "fixture", data: {} });
  return { journal, runner, write };
}

test.each([1, 10])("posts %i events together 50 ms after the first write", async (count) => {
  jest.useFakeTimers();
  const batches: string[][] = [];
  const { journal, runner, write } = outboxFixture(async ({ events }) => {
    batches.push(events.map(({ event }) => event.id));
    return { acknowledgedSequence: events.at(-1)!.sequence };
  });
  try {
    runner.startOutboxDelivery();
    // Place the first write just before the periodic retry tick.
    jest.advanceTimersByTime(999);
    const ids = Array.from({ length: count }, (_, index) => String(index));
    write(ids[0]!);
    jest.advanceTimersByTime(49);
    for (const id of ids.slice(1)) write(id);
    expect(batches).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(batches).toEqual([ids]);
  } finally {
    await runner.close();
    journal.close();
    jest.useRealTimers();
  }
});

test("retries an unacknowledged write on the one-second interval", async () => {
  jest.useFakeTimers();
  const sequences: number[][] = [];
  const { journal, runner, write } = outboxFixture(async ({ events }) => {
    sequences.push(events.map(({ sequence }) => sequence));
    if (sequences.length === 1) throw Error("fixture_ingest_unavailable");
    return { acknowledgedSequence: events.at(-1)!.sequence };
  });
  try {
    runner.startOutboxDelivery();
    write("first");
    jest.advanceTimersByTime(50);
    expect(sequences).toEqual([[1]]);
    expect(journal.ack).toBe(0);
    jest.advanceTimersByTime(949);
    expect(sequences).toEqual([[1]]);
    jest.advanceTimersByTime(1);
    expect(sequences).toEqual([[1], [1]]);
    await runner.close();
    expect(journal.ack).toBe(1);
  } finally {
    await runner.close();
    journal.close();
    jest.useRealTimers();
  }
});

test("write and retry timers share one in-flight flush", async () => {
  jest.useFakeTimers();
  const firstAck = Promise.withResolvers<{ acknowledgedSequence: number }>();
  const batches: number[][] = [];
  const { journal, runner, write } = outboxFixture(async ({ events }) => {
    batches.push(events.map(({ sequence }) => sequence));
    return batches.length === 1 ? firstAck.promise : { acknowledgedSequence: events.at(-1)!.sequence };
  });
  try {
    runner.startOutboxDelivery();
    write("first");
    jest.advanceTimersByTime(50);
    expect(batches).toEqual([[1]]);
    write("second");
    jest.advanceTimersByTime(950);
    expect(batches).toEqual([[1]]);
    firstAck.resolve({ acknowledgedSequence: 1 });
    await runner.flushOutbox();
    expect(batches).toEqual([[1], [2]]);
  } finally {
    firstAck.resolve({ acknowledgedSequence: 1 });
    await runner.close();
    journal.close();
    jest.useRealTimers();
  }
});
