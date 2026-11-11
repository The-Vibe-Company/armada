import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";

const sqlModule = await import("../../src/sql.ts");
const originalSQL = Bun.SQL;
const pools: { max: number; closed: number }[] = [];
let attempts = 0;
let failUntil = 2;
let now = 0;
const logs: string[] = [];
const intervals = spyOn(globalThis, "setInterval");
const sleep = spyOn(Bun, "sleep").mockImplementation((async () => {
  assert.equal(intervals.mock.calls.length, 0, "No background timer may bypass boot backoff");
  now += 5000;
}) as typeof Bun.sleep);
const clock = spyOn(Date, "now").mockImplementation(() => now);
Bun.SQL = class {
  constructor(_url: string, options: { max: number }) {
    const pool = { max: options.max, closed: 0 };
    pools.push(pool);
    return {
      async unsafe() {
        if (++attempts <= failUntil)
          throw Object.assign(new Error("(EMAXCONNSESSION) max clients reached; private connection detail"), {
            code: "ERR_POSTGRES_SERVER_ERROR",
            errno: "XX000",
          });
        return [];
      },
      async close() {
        pool.closed++;
      },
    };
  }
} as unknown as typeof Bun.SQL;
// Use the real adapter over fake physical pools, so close assertions cover both clients.
mock.module(new URL("../../src/sql.ts", import.meta.url).pathname, () => sqlModule);
const { startServer } = await import("../../src/serve.ts");
const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
const port = reservation.port;
await reservation.stop(true);
const env = {
  ARMADA_DATABASE_URL: "postgres://fixture",
  ARMADA_DATABASE_POOL_MAX: "5",
  SUPABASE_URL: "https://auth.example",
  SUPABASE_ANON_KEY: "public",
  ARMADA_AUTH_SECRET: "test-only-auth-secret",
  ARMADA_PUBLIC_URL: "https://gateway.example",
  ARMADA_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
  PORT: String(port),
};
try {
  const server = await startServer(env, { log: () => {}, logError: (line) => logs.push(line) });
  try {
    assert.equal(attempts >= 3, true);
    assert.equal(intervals.mock.calls.length > 0, true);
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  } finally {
    await server.stop(true);
    await server.workerDone;
  }
  assert.deepEqual(
    pools.map((p) => [p.max, p.closed]),
    [
      [5, 1],
      [1, 1],
    ],
  );
  assert.equal(
    logs.some((line) => line.includes("private connection detail")),
    false,
  );

  intervals.mockClear();
  attempts = 0;
  failUntil = Infinity;
  now = 0;
  await assert.rejects(startServer(env, { log: () => {}, logError: (line) => logs.push(line) }), /EMAXCONNSESSION/);
  assert.equal(attempts > 1, true);
  assert.equal(intervals.mock.calls.length, 0);
  assert.deepEqual(
    pools.slice(2).map((p) => p.closed),
    [1, 1],
  );
  console.log("BOOT_RETRY_SERVE_AND_EXHAUSTION_VERIFIED");
} finally {
  Bun.SQL = originalSQL;
  clock.mockRestore();
  sleep.mockRestore();
  intervals.mockRestore();
}
