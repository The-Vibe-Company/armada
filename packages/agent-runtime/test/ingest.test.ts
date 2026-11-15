import { expect, test } from "bun:test";
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
