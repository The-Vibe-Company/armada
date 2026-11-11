import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import { retryDatabaseBoot } from "../src/database-boot.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";

afterEach(() => jest.restoreAllMocks());

test("boot survives admission pressure with capped backoff and redacted diagnostics", async () => {
  const delays: number[] = [];
  spyOn(Bun, "sleep").mockImplementation((async (ms: number) => {
    delays.push(ms);
  }) as typeof Bun.sleep);
  let attempts = 0;
  const logs: string[] = [];
  await retryDatabaseBoot(
    async () => {
      const states = ["EMAXCONNSESSION", "08000", "08003", "08006", "57P01", "53300", "57P03", "EMAXCONNSESSION"];
      const state = states[attempts++];
      if (state)
        throw Object.assign(
          new Error(
            state === "EMAXCONNSESSION" ? "(EMAXCONNSESSION) secret connection string" : "secret connection string",
          ),
          {
            code: "ERR_POSTGRES_SERVER_ERROR",
            errno: state === "EMAXCONNSESSION" ? "XX000" : state,
          },
        );
    },
    (line) => logs.push(line),
  );
  expect(attempts).toBe(9);
  expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  expect(logs.every((line) => !line.includes("secret"))).toBe(true);
});

test("boot fails promptly on permanent SQL errors and stops retrying after its deadline", async () => {
  const log = () => {};
  const permanent = Object.assign(new Error("unrelated internal error"), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "XX000",
  });
  await expect(
    retryDatabaseBoot(async () => {
      throw permanent;
    }, log),
  ).rejects.toBe(permanent);
  let now = 0;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(Bun, "sleep").mockImplementation((async () => {
    now += 120_000;
  }) as typeof Bun.sleep);
  let attempts = 0;
  const full = { code: "ERR_POSTGRES_SERVER_ERROR", errno: "XX000", message: "(EMAXCONN) max clients reached" };
  await expect(
    retryDatabaseBoot(async () => {
      attempts++;
      throw full;
    }, log),
  ).rejects.toBe(full);
  expect(attempts).toBe(2);
});

test("deferred MCP startup leaves background SQL idle until boot admission succeeds", async () => {
  const sql = { query: async <T>() => ({ rows: [] as T[] }) };
  const interval = spyOn(globalThis, "setInterval");
  const mcp = createMcpHttpIntegration({
    sql,
    authStore: createSqlAuthStore(sql),
    deferBackground: true,
    encryptionKey: undefined,
    publicUrl: "https://gateway.example",
    supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
  });
  try {
    expect(interval).not.toHaveBeenCalled();
    await mcp.drainInvalidations();
    expect(interval).not.toHaveBeenCalled();
    mcp.startBackground();
    mcp.startBackground();
    expect(interval).toHaveBeenCalledTimes(1);
  } finally {
    await mcp.close();
  }
});
