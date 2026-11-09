import { expect, test } from "bun:test";
import { statsAccounts } from "../src/lib/stats-db";

test("missing ARMADA_DATABASE_URL provides no privileged stats database", async () => {
  const previous = process.env.ARMADA_DATABASE_URL;
  delete process.env.ARMADA_DATABASE_URL;
  try {
    expect(await statsAccounts()).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.ARMADA_DATABASE_URL;
    else process.env.ARMADA_DATABASE_URL = previous;
  }
});

test("stats client omits pooler-incompatible startup parameters", async () => {
  // Isolate the postgres module mock from other database tests.
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
        import { mock } from "bun:test";
        let options;
        mock.module("postgres", () => ({
          default: (_url, value) => {
            options = value;
            return { unsafe: async () => [] };
          },
        }));
        process.env.ARMADA_DATABASE_URL = "postgres://test:test@pooler.test:5432/postgres";
        const { statsAccounts } = await import("./apps/dashboard/src/lib/stats-db.ts");
        const accounts = await statsAccounts();
        await accounts.client.query("SELECT 1", []);
        console.log(JSON.stringify(options));
      `,
    ],
    { cwd: new URL("../../..", import.meta.url).pathname },
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
});
