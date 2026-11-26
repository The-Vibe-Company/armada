import type { Sql } from "@armada/core";
import { measureDbAcquire, measureSqlQuery } from "./request-timing.ts";
import { collectTransactionWakes, type PgNotifyClient } from "./wake-bus.ts";

/** The one method of Bun's Postgres client the server uses. */
export interface SqlDriver {
  unsafe(text: string, params: never[]): PromiseLike<unknown>;
  reserve?(): Promise<SqlDriver & { release(): void }>;
  autonomous?(text: string, params: never[]): PromiseLike<unknown>;
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
    const rows = (await measureSqlQuery(async () => {
      if (!driver.reserve) return driver.unsafe(encoded, sent as never[]);
      const connection = await measureDbAcquire(() => driver.reserve!());
      try {
        return await connection.unsafe(encoded, sent as never[]);
      } finally {
        connection.release();
      }
    })) as unknown as T[];
    return { rows: Array.from(rows) };
  };
  const transaction = driver.begin;
  return {
    query,
    ...(driver.autonomous ? { autonomousQuery: sqlOver({ unsafe: driver.autonomous }).query } : {}),
    ...(transaction
      ? {
          async transaction<T>(work: (sql: Sql) => Promise<T>) {
            let publish: (() => void) | undefined;
            const result = await transaction(async (tx) => {
              const sql = sqlOver(tx);
              publish = collectTransactionWakes(sql);
              return work(sql);
            });
            publish?.();
            return result;
          },
        }
      : {}),
  };
}

function isUnnamedPooler(url: string) {
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new Error("Invalid database URL.");
  }
  return address.hostname.toLowerCase().endsWith(".pooler.supabase.com") && ["", "5432", "6543"].includes(address.port);
}

/** `Sql` over Bun's Postgres client, for the privileged `ARMADA_DATABASE_URL` connection. */
export function bunSql(url: string, max = 3, queryTimeoutMs?: number): Sql & { close(): Promise<void> } {
  const unnamedPooler = isUnnamedPooler(url);
  // Use a single Parse/Bind/Execute exchange on both shared pooler modes, including cold statements.
  // Session mode supports named statements, but preparing a cache miss adds a Describe exchange.
  // Transaction mode additionally cannot retain named statements across backend leases.
  // Bun 1.4.2 unnamed binds need explicit Date/JSON encoding (fixed upstream in 1.4.4).
  const parameters = (params: never[]): never[] =>
    unnamedPooler
      ? (params.map((value: unknown) => {
          if (value instanceof Date) return value.toISOString();
          if (
            value !== null &&
            typeof value === "object" &&
            (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
          )
            return JSON.stringify(value);
          return value;
        }) as never[])
      : params;
  const options = {
    ...(unnamedPooler ? { prepare: false } : {}),
    connectionTimeout: queryTimeoutMs ? 1 : 5,
    idleTimeout: 30,
    ...(queryTimeoutMs ? { connection: { statement_timeout: queryTimeoutMs } } : {}),
  };
  const client = new Bun.SQL(url, { ...options, max });
  // Never starve durable pre-refresh claims behind owner transactions in the main pool.
  const autonomous = new Bun.SQL(url, { ...options, max: 1 });
  return {
    ...sqlOver({
      autonomous: async (text, params) => {
        const connection = await measureDbAcquire(() => autonomous.reserve());
        try {
          return await connection.unsafe(text, parameters(params));
        } finally {
          connection.release();
        }
      },
      reserve: async () => {
        const connection = await client.reserve();
        return {
          unsafe: (text, params) => connection.unsafe(text, parameters(params)),
          release: () => connection.release(),
        };
      },
      unsafe: (text, params) => client.unsafe(text, parameters(params)),
      begin: async (work) => {
        const connection = await measureDbAcquire(() => client.reserve());
        try {
          return await connection.begin((transaction) =>
            work({ unsafe: (text, params) => transaction.unsafe(text, parameters(params)) }),
          );
        } finally {
          connection.release();
        }
      },
    }),
    close: async () => {
      await Promise.all([client.close(), autonomous.close()]);
    },
  };
}

export function createPgNotifyClient(url: string) {
  const client = new Bun.SQL(url, {
    ...(isUnnamedPooler(url) ? { prepare: false } : {}),
    max: 1,
    connectionTimeout: 5,
    idleTimeout: 0,
  }) as unknown as {
    listen(channel: string, onNotify: (payload: string) => void): Promise<{ unlisten(): Promise<void> }>;
    close(): Promise<void>;
  };
  return {
    listen: (channel, onNotify) => client.listen(channel, onNotify),
    async ping(signal: AbortSignal) {
      if (signal.aborted) throw signal.reason ?? new Error("notify_probe_aborted");
      const probe = (async () => {
        const handle = await client.listen("armada_events_probe", () => {});
        await handle.unlisten();
      })();
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          probe,
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason ?? new Error("notify_probe_aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        void probe.catch(() => {});
      }
    },
    close: () => client.close(),
  } satisfies PgNotifyClient;
}
