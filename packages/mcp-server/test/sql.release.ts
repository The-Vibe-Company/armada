// This contract must never silently skip in release validation.
if (!process.env.ARMADA_TEST_POSTGRES_URL) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

// Release-only PostgreSQL contracts; retained unit cases stay in the sibling test file.
import { describe, expect, test } from "bun:test";
import { bunSql } from "../src/sql.ts";

/**
 * Opt-in: two real Postgres connections prove advisory locks stay transaction-scoped through
 * bunSql, including release after commit and rollback. PGlite cannot prove cross-connection
 * exclusion. Set ARMADA_TEST_POSTGRES_URL to run.
 */
describe("bunSql transactions across two connections (PostgreSQL)", () => {
  for (const outcome of ["commit", "rollback"] as const) {
    test(`advisory lock excludes another transaction until ${outcome}`, async () => {
      const url = process.env.ARMADA_TEST_POSTGRES_URL;
      if (!url) throw new Error("ARMADA_TEST_POSTGRES_URL is required");
      const one = bunSql(url);
      const two = bunSql(url);
      const key = crypto.randomUUID();
      const rollback = new Error("rollback");
      try {
        if (!one.transaction || !two.transaction) throw new Error("bunSql must support transactions");
        const tryLock = () =>
          two.transaction!(async (tx) => {
            const { rows } = await tx.query<{ acquired: boolean }>(
              "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
              [key],
            );
            return rows[0]?.acquired;
          });
        const first = one.transaction(async (tx) => {
          await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
          // This query has completed on a separate connection while the first still holds its lock.
          expect(await tryLock()).toBe(false);
          if (outcome === "rollback") throw rollback;
        });
        if (outcome === "rollback") await expect(first).rejects.toBe(rollback);
        else await first;
        expect(await tryLock()).toBe(true);
      } finally {
        await Promise.all([one.close(), two.close()]);
      }
    });
  }
});
