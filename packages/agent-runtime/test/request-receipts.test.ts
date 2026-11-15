import { expect, test } from "bun:test";
import { Journal } from "../src/journal.ts";
import { executeWithReceipt } from "../src/request-receipts.ts";

test("checkpoint retries dispatch afresh instead of replaying an old request receipt", async () => {
  const journal = new Journal(":memory:", (value) => value);
  try {
    journal.db
      .query("INSERT INTO requests VALUES(?,?)")
      .run("checkpoint_retry", JSON.stringify({ result: { watermark: 1, generation: "old" } }));
    const response = await executeWithReceipt(
      journal,
      { version: 1, sandboxId: "logical", requestId: "checkpoint_retry", op: "checkpoint" },
      async () => ({ watermark: 2, generation: "new" }),
    );
    expect(await response.json()).toEqual({
      version: 1,
      requestId: "checkpoint_retry",
      result: { watermark: 2, generation: "new" },
    });
  } finally {
    journal.close();
  }
});
