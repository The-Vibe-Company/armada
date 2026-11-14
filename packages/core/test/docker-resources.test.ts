import { expect, test } from "bun:test";
import { dockerResourcePolicy, parseDockerMemory } from "../src/docker-resource-policy.ts";
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

test("manual policy fits hardware, recomputes capacity and parses exact memory units", () => {
  const machine = { cpus: 8, memoryBytes: 26 * GIB };
  expect(dockerResourcePolicy(machine, { cpus: 1, memoryBytes: 2 * GIB, maxSandboxes: 12 })).toMatchObject({
    perSandbox: { cpus: 1, memoryBytes: 2 * GIB, pids: 4096 },
    capacity: 12,
    mode: "manual",
  });
  expect(dockerResourcePolicy(machine, { memoryBytes: 2 * GIB }).capacity).toBe(8);
  for (const patch of [
    { cpus: 9 },
    { cpus: 0.001 },
    { memoryBytes: 27 * GIB },
    { maxSandboxes: 7 },
    { maxSandboxes: 1.1 },
  ])
    expect(() => dockerResourcePolicy(machine, patch)).toThrow();
  expect(parseDockerMemory("4g")).toBe(4 * GIB);
  expect(parseDockerMemory("512MiB")).toBe(GIB / 2);
  expect(parseDockerMemory("1.5g")).toBe(1.5 * GIB);
  for (const raw of ["-1g", "unlimited", "1", "4foo", "Infinity", "0.000000001g"])
    expect(() => parseDockerMemory(raw)).toThrow();
});
