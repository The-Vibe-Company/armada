import { expect, test } from "bun:test";
import { snapshotUpdateAvailable } from "../src/snapshot-update.ts";

test("snapshot update offers require a known newer stable server release, not string ordering or mere mismatch", () => {
  for (const [built, current, expected] of [
    ["2.9.0", "2.10.0", true],
    ["2.28.0", "2.28.1", true],
    ["2.28.0", "3.0.0", true],
    ["2.28.0", "2.28.0", false],
    ["3.0.0", "2.29.0", false],
    [null, "2.28.0", false],
    ["2.27.0", null, false],
    ["2.27.0", "2.28.0-rc.1", false],
    ["unknown", "2.28.0", false],
  ] as const)
    expect(snapshotUpdateAvailable(built, current)).toBe(expected);
});
