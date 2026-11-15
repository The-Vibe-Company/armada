import { expect, test } from "bun:test";
import { bunSql } from "../src/sql.ts";

test("shared session and transaction endpoints avoid named Describe setup and normalize unnamed binds on every pool path", async () => {
  const original = Bun.SQL;
  const options: { prepare?: boolean }[] = [];
  const sent: unknown[][] = [];
  Bun.SQL = class {
    constructor(_url: string, input: { prepare?: boolean }) {
      options.push(input);
    }
    async unsafe(_text: string, params: unknown[]) {
      sent.push(params);
      return [];
    }
    async reserve() {
      return {
        unsafe: this.unsafe.bind(this),
        release: () => {},
        begin: async (work: (tx: unknown) => unknown) => work(this),
      };
    }
    async close() {}
  } as unknown as typeof Bun.SQL;
  try {
    for (const [url, prepare] of [
      ["postgres://db.example:5432/postgres", undefined],
      ["postgres://db.example:6543/postgres", undefined],
      ["postgres://aws-1-eu-west-3.pooler.supabase.com:5432/postgres", false],
      ["postgres://aws-1-eu-west-3.pooler.supabase.com/postgres", false],
      ["postgres://aws-1-eu-west-3.pooler.supabase.com:6544/postgres", undefined],
      ["postgres://aws-1-eu-west-3.pooler.supabase.com:6543/postgres", false],
      ["postgres://pooler.supabase.com.example:6543/postgres", undefined],
    ] as const) {
      const sql = bunSql(url);
      expect(options.slice(-2).map((value) => value.prepare)).toEqual([prepare, prepare]);
      const date = new Date("2026-11-14T00:00:00Z");
      const json = { key: "value" };
      const bytes = new Uint8Array([1, 2]);
      const params = [date, json, bytes];
      await sql.query("select $1::timestamptz, $2::jsonb, $3::bytea", params);
      await sql.autonomousQuery!("select $1::timestamptz, $2::jsonb, $3::bytea", params);
      await sql.transaction!((tx) => tx.query("select $1::timestamptz, $2::jsonb, $3::bytea", params));
      for (const values of sent.slice(-3)) {
        expect(values).toEqual(prepare === false ? [date.toISOString(), JSON.stringify(json), bytes] : params);
        expect(values[2]).toBe(bytes);
      }
      await sql.close();
    }
  } finally {
    Bun.SQL = original;
  }
});
