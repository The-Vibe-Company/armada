import { expect, test } from "bun:test";
import { GoldenError } from "../src/golden-config.ts";
import { beginGoldenOperation, type Sql } from "../src/golden-store.ts";

test("operation admission retains the database cause without exposing it in the public error", async () => {
  const cause = new Error("database connection refused");
  const sql: Sql = {
    async query() {
      throw cause;
    },
  };
  const error = await beginGoldenOperation(sql, "golden", { snapshotId: null, sandboxId: null }).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(GoldenError);
  expect(error).toMatchObject({ code: "conflict", message: "Golden operation could not be admitted.", cause });
});
