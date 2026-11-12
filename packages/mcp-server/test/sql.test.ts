import { describe, expect, test } from "bun:test";
import { bunSql, pgArray, sqlOver } from "../src/sql.ts";

describe("transaction wiring", () => {
  test("sqlOver exposes .transaction only when the driver can begin one", async () => {
    const withoutBegin = sqlOver({
      async unsafe() {
        return [];
      },
    });
    expect(withoutBegin.transaction).toBeUndefined();

    const calls: string[] = [];
    const withBegin = sqlOver({
      async unsafe() {
        return [];
      },
      async begin(work) {
        calls.push("begin");
        return work({ unsafe: async () => [] });
      },
    });
    expect(typeof withBegin.transaction).toBe("function");
    await withBegin.transaction?.(async () => "done");
    expect(calls).toEqual(["begin"]);
  });

  test("bunSql (what controlOptionsFromEnv and armada serve both use) wires .transaction to Bun.SQL.begin", () => {
    // Bun.SQL connects lazily: constructing it, even with an address nothing is listening on,
    // never touches the network, so this needs no live database.
    const sql = bunSql("postgres://armada:armada@127.0.0.1:1/armada_test_unreachable");
    expect(typeof sql.transaction).toBe("function");
  });
});

/**
 * Opt-in: two real Postgres connections prove advisory locks stay transaction-scoped through
 * bunSql, including release after commit and rollback. PGlite cannot prove cross-connection
 * exclusion. Set ARMADA_TEST_POSTGRES_URL to run.
 */
describe.skipIf(!process.env.ARMADA_TEST_POSTGRES_URL)(
  "bunSql transactions across two connections (PostgreSQL)",
  () => {
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
  },
);

describe("array parameters", () => {
  test("an array becomes a Postgres array literal, quoted and escaped", () => {
    expect(pgArray(["a", "b"])).toBe('{"a","b"}');
    expect(pgArray([])).toBe("{}");
    expect(pgArray(['say "hi"', "back\\slash", null])).toBe('{"say \\"hi\\"","back\\\\slash",NULL}');
    expect(pgArray([["a"], ["b"]])).toBe('{{"a"},{"b"}}');
  });

  test("only arrays are rewritten: null, text, numbers, dates and bytes go through as they are", async () => {
    let seen: unknown[] = [];
    const sql = sqlOver({
      async unsafe(_text, params) {
        seen = params;
        return [{ ok: true }];
      },
    });
    const bytes = new Uint8Array([1, 2]);
    const date = new Date(0);
    const result = await sql.query("select 1", [["org-1", "org-2"], null, "text", 4, date, bytes]);
    expect(seen).toEqual(['{"org-1","org-2"}', null, "text", 4, date, bytes]);
    expect(seen[5]).toBe(bytes);
    expect(result.rows).toEqual([{ ok: true }]);
  });
});
