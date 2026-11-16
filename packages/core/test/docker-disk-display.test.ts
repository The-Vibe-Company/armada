import { expect, test } from "bun:test";
import { dockerHostDiskDisplay } from "../src/docker-disk-display.ts";

const GiB = 1024 ** 3;
test("Docker storage distinguishes unknown telemetry, unreadable storage and low or sufficient headroom", () => {
  expect(dockerHostDiskDisplay({})).toBe("Unknown — upgrade the host and wait for check-in");
  expect(dockerHostDiskDisplay({ disk: null })).toBe("Unknown — upgrade the host and wait for check-in");
  expect(dockerHostDiskDisplay({ disk: { freeBytes: null, floorBytes: 10 * GiB } })).toBe(
    "Unavailable — cannot verify Docker storage (10 GiB minimum)",
  );
  expect(dockerHostDiskDisplay({ disk: { freeBytes: 0, floorBytes: 10 * GiB } })).toBe(
    "0 GiB free · 10 GiB minimum · launches blocked",
  );
  expect(dockerHostDiskDisplay({ disk: { freeBytes: 10 * GiB, floorBytes: 10 * GiB } })).toBe(
    "10 GiB free · 10 GiB minimum",
  );
});
