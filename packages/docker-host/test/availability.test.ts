import { expect, test } from "bun:test";
import { availableForArmada, parseArmadaUsage, smoothHeadroom } from "../src/availability.ts";

const GIB = 1024 ** 3;

test("headroom credits Armada working set and CPU, excludes external use and never exceeds hardware", () => {
  const own = parseArmadaUsage("2GiB / 4GiB|150.00%\n512MiB / 4GiB|50.00%");
  expect(own).toEqual({ cpus: 2, memoryBytes: 2.5 * GIB });
  expect(availableForArmada({ cpus: 8, memoryBytes: 32 * GIB }, 10 * GIB, 5, own)).toEqual({
    availableCpus: 5,
    availableMemoryBytes: 12.5 * GIB,
  });
  expect(availableForArmada({ cpus: 2, memoryBytes: 4 * GIB }, 4 * GIB, 0, own)).toEqual({
    availableCpus: 2,
    availableMemoryBytes: 4 * GIB,
  });
  expect(() => parseArmadaUsage("unknown|?")).toThrow();
});

test("availability drops immediately and recovers gradually without permanently losing a boundary slot", () => {
  const high = { availableCpus: 8, availableMemoryBytes: 32 * GIB };
  const low = { availableCpus: 2, availableMemoryBytes: 8 * GIB };
  expect(smoothHeadroom(high, low)).toEqual(low);
  let value = smoothHeadroom(low, high);
  expect(value).toEqual({ availableCpus: 3.5, availableMemoryBytes: 14 * GIB });
  for (let i = 0; i < 40; i++) value = smoothHeadroom(value, high);
  expect(value).toEqual(high);
});
