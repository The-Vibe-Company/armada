import { expect, test } from "bun:test";
import { parseVmResourceFiles, VM_RESOURCE_MAX_FILE_BYTES } from "../src/vm-resource-reading.ts";

// Synthetic Linux counter syntax, not a recorded provider observation or isolation proof.
const boot = "11111111-2222-3333-4444-555555555555";
const files = [
  boot,
  "10.00 0.00\n",
  "cpu 10 2 5 20 3 1 2 7 100 100\ncpu0 1 0 0 0 0 0 0 0\ncpu1 1 0 0 0 0 0 0 0\n",
  "MemTotal: 16384 kB\nMemAvailable: 8192 kB\n",
  "some avg10=0.00 avg60=0.00 avg300=0.00 total=4200\n",
  "oom_kill 2\n",
  "10.01 0.00\n",
  boot,
] as const;
test("parses guest ticks without USER_HZ inference or guest double counting and preserves memory units", () => {
  expect(parseVmResourceFiles(files)).toEqual({
    version: 1,
    bootId: boot,
    uptimeMs: 10010,
    captureDurationMs: 10,
    cpuTotalTicks: 50,
    cpuBusyTicks: 20,
    cpuStealTicks: 7,
    cpuLogicalCpus: 2,
    memoryTotalBytes: 16777216,
    memoryAvailableBytes: 8388608,
    cpuPressureSomeUsec: 4200,
    oomKills: 2,
  });
});
test.each([
  [0, null],
  [7, "aaaaaaaa-2222-3333-4444-555555555555"],
  [6, "9.99 0\n"],
  [6, "15.01 0\n"],
  [1, "NaN 0\n"],
  [2, "x".repeat(VM_RESOURCE_MAX_FILE_BYTES)],
] as const)("invalid identity, time or read boundary makes entire sample unavailable (%i)", (index, value) => {
  const changed: (string | null)[] = [...files];
  changed[index] = value;
  expect(parseVmResourceFiles(changed)).toBeNull();
});
test("missing optional counters are unavailable rather than zero while observed zeros survive", () => {
  const changed: (string | null)[] = [...files];
  changed[2] = "cpu 0 0 0 100 0 0 0 0\ncpu0 0 0 0 100 0 0 0 0\n";
  changed[3] = "MemTotal: 16384 kB\n";
  changed[4] = null;
  changed[5] = "oom_kill 0\n";
  expect(parseVmResourceFiles(changed)).toMatchObject({
    cpuBusyTicks: 0,
    cpuTotalTicks: 100,
    cpuLogicalCpus: 1,
    memoryTotalBytes: null,
    memoryAvailableBytes: null,
    cpuPressureSomeUsec: null,
    oomKills: 0,
  });
});
test("unsafe integer counters and impossible memory gauge are unavailable", () => {
  const changed: (string | null)[] = [...files];
  changed[2] = "cpu 9007199254740992 0 0 0 0 0 0 0\n";
  changed[3] = "MemTotal: 1 kB\nMemAvailable: 2 kB\n";
  changed[4] = "some total=NaN\n";
  changed[5] = "oom_kill -1\n";
  expect(parseVmResourceFiles(changed)).toMatchObject({
    cpuBusyTicks: null,
    cpuTotalTicks: null,
    memoryTotalBytes: null,
    memoryAvailableBytes: null,
    cpuPressureSomeUsec: null,
    oomKills: null,
  });
});
