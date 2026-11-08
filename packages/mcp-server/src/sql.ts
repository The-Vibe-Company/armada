import type { Sql } from "@armada/core";

/** The one method of Bun's Postgres client the server uses. */
export interface SqlDriver {
  unsafe(text: string, params: never[]): PromiseLike<unknown>;
}

/**
 * A Postgres array literal for a JS array: `{"a","b"}`, `NULL` for null, nested arrays for nesting.
 * Bun sends a JS array parameter in a form Postgres refuses for `$1::uuid[]` or `$1::text[]`
 * (22P02, "Array value must start with \"{\""), so arrays are sent as text and cast by the query.
 */
export function pgArray(items: readonly unknown[]): string {
  const element = (item: unknown): string => {
    if (item === null || item === undefined) return "NULL";
    if (Array.isArray(item)) return pgArray(item);
    return `"${String(item).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };
  return `{${items.map(element).join(",")}}`;
}

/** `Sql` over a Bun-style driver: array parameters become array literals, everything else goes through as is. */
export function sqlOver(driver: SqlDriver): Sql {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const sent = params.map((param) => (Array.isArray(param) ? pgArray(param) : param));
      const rows = (await driver.unsafe(text, sent as never[])) as unknown as T[];
      return { rows: Array.from(rows) };
    },
  };
}

/** `Sql` over Bun's Postgres client, for the privileged `ARMADA_DATABASE_URL` connection. */
export function bunSql(url: string): Sql {
  return sqlOver(new Bun.SQL(url));
}
