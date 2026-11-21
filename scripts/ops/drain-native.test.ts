import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { SandboxState } from "../../packages/core/src/provider.ts";
import { runNativeDrain } from "./drain-native.ts";

const db = new PGlite();
const run = (...args: string[]) =>
  runNativeDrain(
    args,
    async (statement, provider) =>
      (await db.query<{ status: SandboxState; count: number }>(statement, [provider])).rows,
  );

beforeAll(async () => {
  await db.exec(`
    create table public.sandboxes (
      id text, provider text, status text, boat_runtime boolean, runtime_transport text, deleted_at timestamptz
    );
    insert into public.sandboxes values
      ('private-id', 'modal', 'running', false, null, null),
      ('private-id', 'modal', 'running', false, null, null),
      ('private-id', 'modal', 'stopped', false, null, null),
      ('private-id', 'modal', 'failed', false, null, null),
      ('private-id', 'modal', 'deleted', false, null, now()),
      ('private-id', 'modal', 'stopped', false, null, now()),
      ('private-id', 'modal', 'ready', false, 'dialout', null),
      ('private-id', 'boat', 'ready', true, null, null),
      ('private-id', 'docker', 'ready', false, null, null);
  `);
});

afterAll(() => db.close());

test("dry-run reports only live records on the selected persisted native route, including stopped rows", async () => {
  expect(await run("--provider", "modal", "--dry-run")).toEqual({
    provider: "modal",
    mode: "dry-run",
    total: 4,
    byStatus: { starting: 0, ready: 0, running: 2, stopping: 0, stopped: 1, failed: 1 },
  });
  expect(await run("--provider", "boat", "--dry-run")).toEqual({
    provider: "boat",
    mode: "dry-run",
    total: 0,
    byStatus: { starting: 0, ready: 0, running: 0, stopping: 0, stopped: 0, failed: 0 },
  });
});

test("rejects destructive invocation before querying the database", async () => {
  await expect(
    runNativeDrain(["--provider", "modal"], async () => {
      throw new Error("Database was unexpectedly queried.");
    }),
  ).rejects.toThrow("Destructive drain is unavailable");
});
