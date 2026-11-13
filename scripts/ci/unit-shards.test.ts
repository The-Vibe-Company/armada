import { expect, test } from "bun:test";
import { planShards, SHARD_COUNT, validatePlan, workerBatches } from "./unit-shards.ts";

test("balanced shards include new files exactly once without depending on discovery order", () => {
  const files = [
    "slow.test.ts",
    "medium.test.ts",
    "small.test.ts",
    ...Array.from({ length: SHARD_COUNT }, (_, i) => `new-${i}.test.ts`),
  ];
  const weights = { "slow.test.ts": 10, "medium.test.ts": 8, "small.test.ts": 6 };
  const plan = planShards(files, weights);
  expect(plan).toEqual(planShards([...files].reverse(), weights));
  expect(plan.flat().sort()).toEqual([...files].sort());
  expect(plan.find((shard) => shard.includes("slow.test.ts"))).toEqual(["slow.test.ts"]);
  const sql = Array.from({ length: 12 }, (_, i) => `packages/mcp-server/test/atomic-${i}.test.ts`);
  const sources = Object.fromEntries(sql.map((file) => [file, "await migratedDatabase()"]));
  const observations = Array.from({ length: 6 }, (_, i) => ({ files: sql.slice(i * 2, i * 2 + 2), seconds: 10 }));
  const atomic = planShards(sql, {}, sources, observations);
  expect(atomic).toEqual(planShards([...sql].reverse(), {}, sources, observations));
  expect(observations.every(({ files }) => atomic.some((shard) => files.every((file) => shard.includes(file))))).toBe(
    true,
  );
});

test("coverage guard refuses missing, duplicate, foreign and empty shard assignments", () => {
  const files = Array.from({ length: SHARD_COUNT }, (_, i) => `file-${i}`);
  const valid = files.map((file) => [file]);
  for (const invalid of [
    [...valid.slice(0, -1), []],
    [...valid.slice(0, -1), [files[0]!]],
    [...valid.slice(0, -1), ["foreign"]],
    [files],
  ])
    expect(() => validatePlan(files, invalid)).toThrow("exactly one");
});

test("SQL worker merging keeps every file once and leaves native or global-mock suites isolated", () => {
  const sql = Array.from({ length: 15 }, (_, i) => `packages/mcp-server/test/sql-${i}.test.ts`);
  const unsafe = [
    "Bun.spawn",
    "Bun.env",
    "captureGitHubAuditLogs",
    "mock.module",
    "spyOn(",
    "process.env",
    "globalThis.fetch",
    "test.concurrent",
    "CodexDriver",
  ];
  const files = [
    ...sql,
    ...unsafe.map((_, i) => `packages/mcp-server/test/unsafe-${i}.test.ts`),
    "scripts/other.test.ts",
  ];
  const owners = [
    "const db = await migratedDatabase();",
    'import { database, harness } from "./support.ts"; await database();',
    'import { runtimeFixture as fixture } from "./runtime-fixture.ts"; await fixture();',
  ];
  const sources = Object.fromEntries(
    files.map((file, i) => [
      file,
      `${owners[i % owners.length]} ${i < sql.length ? "" : (unsafe[i - sql.length] ?? "")}`,
    ]),
  );
  const batches = workerBatches(files, sources);
  expect(batches.flat().sort()).toEqual([...files].sort());
  expect(batches.slice(0, 2).map((batch) => batch.length)).toEqual([12, 3]);
  expect(batches.slice(2).every((batch) => batch.length === 1)).toBe(true);
  const measured = [{ files: [sql[1]!, sql[3]!], seconds: 1 }];
  expect(workerBatches(files, sources, measured)[0]).toEqual(measured[0]!.files);
  const changed = { ...sources, [sql[1]!]: "Bun.spawn()" };
  expect(workerBatches(files, changed, measured).find((batch) => batch.includes(sql[1]!))).toEqual([sql[1]!]);
});
