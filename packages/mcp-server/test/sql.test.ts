import { describe, expect, test } from "bun:test";
import { pgArray, sqlOver } from "../src/sql.ts";

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
