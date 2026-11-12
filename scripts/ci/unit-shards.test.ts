import { expect, test } from "bun:test";
import { planShards, validatePlan } from "./unit-shards.ts";

test("balanced shards include new files exactly once without depending on discovery order", () => {
  const files = ["slow.test.ts", "medium.test.ts", "small.test.ts", "new.test.ts", "other.test.ts"];
  const weights = { "slow.test.ts": 10, "medium.test.ts": 8, "small.test.ts": 6 };
  const plan = planShards(files, weights);
  expect(plan).toEqual(planShards([...files].reverse(), weights));
  expect(plan.flat().sort()).toEqual([...files].sort());
  expect(plan.find((shard) => shard.includes("slow.test.ts"))).toEqual(["slow.test.ts"]);
});

test("coverage guard refuses missing, duplicate, foreign and empty shard assignments", () => {
  const files = ["a", "b", "c", "d"];
  for (const invalid of [
    [["a"], ["b"], ["c"], []],
    [["a"], ["b"], ["c"], ["a"]],
    [["a"], ["b"], ["c"], ["foreign"]],
    [["a", "b"], ["c", "d"], [], []],
  ])
    expect(() => validatePlan(files, invalid)).toThrow("exactly one");
});
