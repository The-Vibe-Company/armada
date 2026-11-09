import type { Sql } from "@armada/core";

/** The one method of Bun's Postgres client the server uses. */
export interface SqlDriver {
  unsafe(text: string, params: never[]): PromiseLike<unknown>;
  begin?<T>(work: (driver: SqlDriver) => Promise<T>): Promise<T>;
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
  const query = async <T>(text: string, params: unknown[] = []) => {
    const sent = params.map((param) => (Array.isArray(param) ? pgArray(param) : param));
    // Bun infers a JSONB parameter from a direct cast and JSON-encodes string values again.
    // The shared Sql contract takes explicitly serialized JSON strings; force text wire encoding
    // before PostgreSQL parses those bytes as JSON. Do not alter object/non-string parameters.
    const encoded = text.replace(/\$(\d+)::(jsonb|json)\b/g, (cast, index: string, kind: string) =>
      typeof params[Number(index) - 1] === "string" ? `$${index}::text::${kind}` : cast,
    );
    const rows = (await driver.unsafe(encoded, sent as never[])) as unknown as T[];
    return { rows: Array.from(rows) };
  };
  const transaction = driver.begin;
  return {
    query,
    ...(transaction
      ? { transaction: <T>(work: (sql: Sql) => Promise<T>) => transaction(async (tx) => work(sqlOver(tx))) }
      : {}),
  };
}

/** `Sql` over Bun's Postgres client, for the privileged `ARMADA_DATABASE_URL` connection. */
export function bunSql(url: string): Sql {
  const client = new Bun.SQL(url);
  return sqlOver({
    unsafe: (text, params) => client.unsafe(text, params),
    begin: (work) =>
      client.begin((transaction) => work({ unsafe: (text, params) => transaction.unsafe(text, params) })),
  });
}
