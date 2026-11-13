import { expect, test } from "bun:test";
import type { Sql } from "@armada/core";
import { createDatabaseReadiness } from "../src/database-readiness.ts";
import { requireDatabaseSchema } from "../src/database-schema.ts";
import { REQUIRED_MIGRATION } from "../src/required-migration.ts";

test("schema readiness rejects missing, empty and behind history, accepting current and newer databases", async () => {
  let version: string | null | undefined;
  const sql: Sql = {
    async query<T>() {
      if (version === undefined) throw new Error("Migration history is unavailable");
      return { rows: [{ version }] as T[] };
    },
  };
  expect(await createDatabaseReadiness(sql)()).toBe(false);
  version = null;
  expect(await createDatabaseReadiness(sql)()).toBe(false);
  version = "20000101000000";
  await expect(requireDatabaseSchema(sql)).rejects.toThrow("Database schema behind running code");
  expect(await createDatabaseReadiness(sql)()).toBe(false);
  version = REQUIRED_MIGRATION;
  expect(await createDatabaseReadiness(sql)()).toBe(true);
  version = "99991231235959";
  expect(await createDatabaseReadiness(sql)()).toBe(true);
});
