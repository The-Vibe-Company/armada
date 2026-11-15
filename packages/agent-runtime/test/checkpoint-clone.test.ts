import { expect, test } from "bun:test";
import { type Driver, Journal, Runner } from "../src/index.ts";

test("legacy generation-only seals fail closed rather than being adopted by a new logical sandbox", () => {
  const journal = new Journal(":memory:", (s) => s);
  const driver: Driver = {
    start() {
      throw Error("unused");
    },
    async close() {},
  };
  try {
    journal.db.query("INSERT INTO metadata VALUES(?,?)").run("checkpoint:1", "complete");
    expect(
      () =>
        new Runner(
          journal,
          {
            token: "legacy-fixture-private-grant",
            sandboxId: "new-id",
            generation: "1",
            expiresAt: Date.now() + 60000,
          },
          { claude: driver, codex: driver },
        ),
    ).toThrow("checkpoint_identity_ambiguous");
    expect(
      (journal.db.query("SELECT value FROM metadata WHERE key=?").get("checkpoint:1") as { value: string }).value,
    ).toBe("complete");
  } finally {
    journal.close();
  }
});
