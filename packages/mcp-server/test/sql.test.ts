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

test("standalone queries count attempts, measure acquisition and release the same client on success or failure", async () => {
  const { RequestTiming, withRequestTiming } = await import("../src/request-timing.ts");
  for (const failure of ["none", "acquire", "query"] as const) {
    const timing = new RequestTiming();
    const calls: string[] = [];
    const error = new Error("private_database_failure");
    const sql = sqlOver({
      unsafe: async () => {
        throw new Error("must use reserved client");
      },
      reserve: async () => {
        calls.push("acquire");
        if (failure === "acquire") throw error;
        return {
          unsafe: async () => {
            calls.push("query");
            if (failure === "query") throw error;
            return [{ ok: true }];
          },
          release: () => {
            calls.push("release");
          },
        };
      },
    });
    const result = withRequestTiming(timing, () => sql.query("select private_column", ["private_value"]));
    if (failure === "none") expect(await result).toEqual({ rows: [{ ok: true }] });
    else await expect(result).rejects.toBe(error);
    expect(calls).toEqual(failure === "acquire" ? ["acquire"] : ["acquire", "query", "release"]);
    expect(timing.header()).toMatch(/^db_acquire;dur=\d+\.\d{2}, sql;dur=\d+\.\d{2};desc="1", sql_1;dur=\d+\.\d{2}$/);
  }
});
