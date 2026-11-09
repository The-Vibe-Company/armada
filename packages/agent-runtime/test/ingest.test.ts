import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Driver, type IngestClient, Journal, Runner } from "../src/index.ts";

// Durable outbox boundary: an untrusted HTTP-shaped acknowledgement must never poison WAL metadata.
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
)("malformed ingest acknowledgement %j rejects without durable advancement and retries after reopen", async (body) => {
  const root = mkdtempSync(join(tmpdir(), "armada-ack-"));
  const path = join(root, "journal.sqlite");
  let journal = new Journal(path, (s) => s);
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
    journal.close();
    journal = new Journal(path, (s) => s);
    expect(journal.ack).toBe(0);
    const retry = new Runner(
      journal,
      grant,
      { claude: driver, codex: driver },
      {
        async append(batch) {
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
    );
    await retry.flushOutbox();
    expect(journal.ack).toBe(1);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
