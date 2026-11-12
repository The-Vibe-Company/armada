import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { VERSION } from "@armada/core";
import { REQUIRED_MIGRATION } from "../../src/required-migration.ts";

const sqlModule = await import("../../src/sql.ts");
const originalSQL = Bun.SQL;
const pools: { max: number; closed: number }[] = [];
let attempts = 0;
let failUntil = 2;
let now = 0;
let schemaVersion = REQUIRED_MIGRATION;
const logs: string[] = [];
const intervals = spyOn(globalThis, "setInterval");
const sleep = spyOn(Bun, "sleep").mockImplementation((async () => {
  assert.equal(intervals.mock.calls.length, 0, "No background timer may bypass boot backoff");
  now += 5000;
}) as typeof Bun.sleep);
const clock = spyOn(Date, "now").mockImplementation(() => now);
Bun.SQL = class {
  pool: { max: number; closed: number };
  constructor(_url: string, options: { max: number }) {
    this.pool = { max: options.max, closed: 0 };
    pools.push(this.pool);
  }
  async unsafe(text: string) {
    if (++attempts <= failUntil)
      throw Object.assign(new Error("(EMAXCONNSESSION) max clients reached; private connection detail"), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "XX000",
      });
    return text.includes("supabase_migrations.schema_migrations") ? [{ version: schemaVersion }] : [];
  }
  async close() {
    this.pool.closed++;
  }
} as unknown as typeof Bun.SQL;
// Use the real adapter over fake physical pools, so close assertions cover both clients.
mock.module(new URL("../../src/sql.ts", import.meta.url).pathname, () => sqlModule);
const mcpModule = await import("../../src/mcp-http-integration.ts");
const createIntegration = mcpModule.createMcpHttpIntegration;
let mcpClosed = false;
mock.module(new URL("../../src/mcp-http-integration.ts", import.meta.url).pathname, () => ({
  ...mcpModule,
  createMcpHttpIntegration: (...args: Parameters<typeof mcpModule.createMcpHttpIntegration>) => {
    const integration = createIntegration(...args);
    const close = integration.close.bind(integration);
    integration.close = async () => {
      mcpClosed = true;
      await close();
    };
    return integration;
  },
}));
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
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const streamed = Promise.withResolvers<void>();
  const server = await startServer(env, {
    log: () => {},
    logError: (line) => logs.push(line),
    routes: [
      async (request) => {
        if (new URL(request.url).pathname === "/stream-fixture") {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("started"));
                await streamed.promise;
                assert.equal(
                  pools.every((pool) => pool.closed === 0),
                  true,
                  "POST response retains SQL",
                );
                assert.equal(mcpClosed, false, "POST tool stream retains MCP until EOF");
                controller.enqueue(new TextEncoder().encode("finished"));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (new URL(request.url).pathname !== "/drain-fixture") return null;
        entered.resolve();
        await release.promise;
        assert.equal(
          pools.every((pool) => pool.closed === 0),
          true,
          "HTTP work retains SQL during drain",
        );
        return new Response("finished");
      },
    ],
  });
  try {
    assert.equal(attempts >= 3, true);
    assert.equal(intervals.mock.calls.length > 0, true);
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, true);
    // Runtime failure after successful boot must not keep reporting healthy.
    now += 1_001;
    schemaVersion = "20000101000000";
    const behind = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(behind.status, 503, "Database connectivity alone is not readiness");
    now += 1_001;
    schemaVersion = REQUIRED_MIGRATION;
    failUntil = Infinity;
    const unavailable = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.equal(unavailable.headers.get("retry-after"), "5");
    assert.deepEqual(await unavailable.json(), { ok: false, version: VERSION, reason: "database_unavailable" });
    now += 1_001;
    failUntil = 0;
    const recovered = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(recovered.status, 200);
    assert.equal(((await recovered.json()) as { ok: boolean }).ok, true);
    const stream = await fetch(`http://127.0.0.1:${server.port}/stream-fixture`, { method: "POST" });
    const streamText = stream.text();
    const request = fetch(`http://127.0.0.1:${server.port}/drain-fixture`);
    await entered.promise;
    const stopped = server.stop(false);
    assert.equal(server.stop(false), stopped, "Repeated stop shares one cleanup");
    release.resolve();
    assert.equal(await (await request).text(), "finished");
    streamed.resolve();
    assert.equal(await streamText, "startedfinished");
    await stopped;
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
  failUntil = 0;
  schemaVersion = "20000101000000";
  await assert.rejects(startServer(env, { log: () => {}, logError: (line) => logs.push(line) }), /schema behind/);
  assert.equal(intervals.mock.calls.length, 0, "Outdated schema must fail before workers start");
  assert.deepEqual(
    pools.slice(2).map((p) => p.closed),
    [1, 1],
  );
  schemaVersion = REQUIRED_MIGRATION;

  intervals.mockClear();
  attempts = 0;
  failUntil = Infinity;
  now = 0;
  await assert.rejects(startServer(env, { log: () => {}, logError: (line) => logs.push(line) }), /EMAXCONNSESSION/);
  assert.equal(attempts > 1, true);
  assert.equal(intervals.mock.calls.length, 0);
  assert.deepEqual(
    pools.slice(4).map((p) => p.closed),
    [1, 1],
  );
  console.log("BOOT_RETRY_SERVE_AND_EXHAUSTION_VERIFIED");
} finally {
  Bun.SQL = originalSQL;
  clock.mockRestore();
  sleep.mockRestore();
  intervals.mockRestore();
}
