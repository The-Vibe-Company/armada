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
  const source = "const db = await migratedDatabase();";
  const sources = Object.fromEntries(
    files.map((file, i) => [file, i < sql.length ? source : `${source} ${unsafe[i - sql.length] ?? ""}`]),
  );
  const batches = workerBatches(files, sources);
  expect(batches.flat().sort()).toEqual([...files].sort());
  expect(batches.slice(0, 2).map((batch) => batch.length)).toEqual([12, 3]);
  expect(batches.slice(2).every((batch) => batch.length === 1)).toBe(true);
});
