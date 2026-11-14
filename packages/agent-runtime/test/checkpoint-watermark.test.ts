import { expect, test } from "bun:test";
import { AUTH_HEADER, Journal, Runner } from "../src/index.ts";

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
