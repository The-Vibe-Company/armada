import { expect, test } from "bun:test";
import { migratedDatabase } from "../../core/test/support/database.ts";

const database = migratedDatabase();

// The reset may use database-owner maintenance privileges, but must restore the
// journal guard before handing the database to application-behavior tests.
// CASCADE reaches that guard even when projection tables reference the journal.
test("shared fixture reset restores the journal truncate guard", async () => {
  await expect(database().exec("truncate table public.otto_facts cascade")).rejects.toThrow("append-only");
});
