import { expect, test } from "bun:test";
import { parseMigrationHistory, stagingMigrationDecision } from "./staging-migration-history";

const a = "20261114110000";
const b = "20261115110000";
const c = "20261115120000";
test("staging applies ordinary histories but skips only complete known forward extensions", () => {
  expect(stagingMigrationDecision([a], [], [a, b])).toBe("apply");
  expect(stagingMigrationDecision([a], [a], [a, b])).toBe("apply");
  expect(stagingMigrationDecision([a], [a, b, c], [a, b, c])).toBe("skip");
  for (const [local, remote, main] of [
    [[a], [a, b], [a]], // unknown
    [[b], [a, b], [a, b]], // not strictly newer
    [
      [a, b],
      [a, c],
      [a, b, c],
    ], // missing release migration
    [[], [a], [a]], // no release prefix
    [[a], [a, a], [a]], // duplicate
    [[a], ["invalid"], [a]],
  ] as [string[], string[], string[]][]) {
    expect(() => stagingMigrationDecision(local, remote, main)).toThrow();
  }
});

test("pinned CLI history table parsing rejects missing or unexpected output", () => {
  const header = " Local | Remote | Time (UTC)\n -------|--------|--------\n";
  expect(parseMigrationHistory(`${header} ${a} | ${a} | time\n | ${b} | time\n`)).toEqual({
    local: [a],
    remote: [a, b],
  });
  expect(parseMigrationHistory(header)).toEqual({ local: [], remote: [] });
  for (const output of ["", "error", `${header}broken`, `${header} | | `])
    expect(() => parseMigrationHistory(output)).toThrow();
});
