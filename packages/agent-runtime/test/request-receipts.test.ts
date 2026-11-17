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

test("definite refusals replay their status while ambiguous failures retain the crash fence", async () => {
  const { RequestRefused } = await import("../src/errors.ts");
  const journal = new Journal(":memory:", (value) => value);
  try {
    for (const definite of [true, false]) {
      const request = {
        version: 1 as const,
        sandboxId: "logical",
        requestId: String(definite),
        op: "interrupt" as const,
      };
      let calls = 0;
      const dispatch = async () => {
        calls++;
        throw definite ? new RequestRefused("no_running_turn") : Error("transport_lost");
      };
      if (definite) expect((await executeWithReceipt(journal, request, dispatch)).status).toBe(409);
      else await expect(executeWithReceipt(journal, request, dispatch)).rejects.toThrow("transport_lost");
      const replay = await executeWithReceipt(journal, request, dispatch);
      expect(replay.status).toBe(definite ? 409 : 200);
      expect(await replay.json()).toMatchObject({ error: definite ? "no_running_turn" : "request_outcome_unknown" });
      expect(calls).toBe(1);
    }
  } finally {
    journal.close();
  }
});
