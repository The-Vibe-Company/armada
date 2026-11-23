import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../../packages/core/src/golden-store.ts";
import { parseNativeDrainArgs, runNativeDrain } from "./drain-native.ts";

const db = new PGlite();
const connection = (driver: Pick<PGlite, "query">) =>
  ({
    query: async <T>(statement: string, params?: unknown[]) => {
      const { rows } = await driver.query<T>(statement, params);
      return { rows };
    },
  }) satisfies Sql;
const sql: Sql = { ...connection(db), transaction: (work) => db.transaction((tx) => work(connection(tx))) };
const run = (...args: string[]) => runNativeDrain(parseNativeDrainArgs(args), sql);

beforeAll(async () => {
  await db.exec(`
    create table public.sandboxes (
      id text, provider text, status text, boat_runtime boolean, runtime_transport text, deleted_at timestamptz,
      org_id text default 'private-org'
    );
    create table public.members (org_id text, user_id uuid, role text);
    insert into public.sandboxes (id, provider, status, boat_runtime, runtime_transport, deleted_at) values
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
  expect(await run("--provider", "boat", "--dry-run")).toEqual({
    provider: "boat",
    mode: "dry-run",
    total: 0,
    byStatus: { starting: 0, ready: 0, running: 0, stopping: 0, stopped: 0, failed: 0 },
  });
});

test("real drain reports failed preservation, keeps the row, and skips deleted rows on replay", async () => {
  const actorId = crypto.randomUUID();
  const request = parseNativeDrainArgs(["--provider", "boat"]);
  await db.query("insert into public.members values ('private-org', $1, 'admin')", [actorId]);
  await db.exec(`
    insert into public.sandboxes (id, provider, status, boat_runtime, runtime_transport, deleted_at) values
      ('archived-id', 'boat', 'stopped', false, null, null),
      ('unproven-id', 'boat', 'stopped', false, null, null);
  `);
  let proofAvailable = false;
  const calls: string[] = [];
  const operation = {
    actorId,
    async remove({ id, role }: { id: string; role: string | null }) {
      calls.push(id);
      expect(role).toBe("admin");
      if (id === "unproven-id" && !proofAvailable) throw new Error("Unverified work for unproven-id");
      await db.query("update public.sandboxes set status='deleted', deleted_at=now() where id=$1", [id]);
      return id === "archived-id" ? ("with-proof" as const) : ("without-proof" as const);
    },
  };
  expect(await runNativeDrain(request, sql, operation)).toEqual({
    provider: "boat",
    mode: "drain",
    total: 2,
    deleted: 1,
    deletedWithProof: 1,
    deletedWithoutProof: 0,
    alreadyDeleted: 0,
    failed: 1,
  });
  expect(await run("--provider", "boat", "--dry-run")).toMatchObject({ total: 1, byStatus: { stopped: 1 } });

  proofAvailable = true;
  expect(await runNativeDrain(request, sql, operation)).toMatchObject({
    total: 1,
    deleted: 1,
    deletedWithoutProof: 1,
    failed: 0,
  });
  expect(await runNativeDrain(request, sql, operation)).toMatchObject({ total: 0, deleted: 0, failed: 0 });
  expect(calls).toEqual(["archived-id", "unproven-id", "unproven-id"]);
});

test("the retired Modal drain is rejected by the command parser", () => {
  expect(() => parseNativeDrainArgs(["--provider", "modal"])).toThrow("Usage:");
});
