import { expect, test } from "bun:test";
import { dockerResourceArgs, dockerResourceLimits, GIB } from "../src/docker-resources.ts";

test("Docker defaults shrink to fit and disable extra swap while bounding processes", () => {
  expect(dockerResourceLimits({ cpus: 16, memoryBytes: 32 * GIB })).toEqual({
    cpus: 2,
    memoryBytes: 4 * GIB,
    pids: 4096,
  });
  expect(dockerResourceArgs({ cpus: 1, memoryBytes: GIB })).toEqual([
    "--cpus",
    "1",
    "--memory",
    String(GIB),
    "--memory-swap",
    String(GIB),
    "--pids-limit",
    "4096",
  ]);
  for (const resources of [
    { cpus: 0, memoryBytes: GIB },
    { cpus: NaN, memoryBytes: GIB },
    { cpus: 2, memoryBytes: 0 },
  ])
    expect(() => dockerResourceLimits(resources)).toThrow();
});
