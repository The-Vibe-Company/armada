import { expect, test } from "bun:test";
import { GIB } from "../../core/src/docker-resources.ts";
import { dockerHostCapacity } from "../src/docker-capacity.ts";

test("automatic Docker capacity respects memory reserve, 2x CPU and small/unknown hosts", () => {
  expect(dockerHostCapacity(null)).toBeNull();
  for (const [cpus, memory, expected] of [
    [16, 26, 6],
    [2, 64, 2],
    [8, 10, 2],
    [1, 1, 1],
    [2, 2, 1],
    [4, 6, 1],
  ])
    expect(dockerHostCapacity({ cpus: cpus!, memoryBytes: memory! * GIB })).toBe(expected!);
});
