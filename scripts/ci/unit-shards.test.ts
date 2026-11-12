import { expect, test } from "bun:test";
import { planShards, SHARD_COUNT, validatePlan } from "./unit-shards.ts";

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
