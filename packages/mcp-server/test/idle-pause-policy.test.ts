import { expect, test } from "bun:test";
import { idlePauseDelayMs } from "../src/idle-pause-policy.ts";

test("one server setting resolves default/overridden idle delay to worker milliseconds", () => {
  for (const [configured, expected] of [
    [undefined, 600_000],
    ["10", 600_000],
    ["1", 60_000],
    ["0.5", 30_000],
  ] as const)
    expect(idlePauseDelayMs({ ARMADA_RUNTIME_IDLE_MINUTES: configured })).toBe(expected);
});

test("invalid idle configuration refuses startup without echoing environment values", () => {
  for (const configured of ["", "0", "-1", "not-a-delay", "Infinity", "1e99", "0.000001"]) {
    expect(() => idlePauseDelayMs({ ARMADA_RUNTIME_IDLE_MINUTES: configured })).toThrow(
      "positive whole number of milliseconds",
    );
  }
  let caught: unknown;
  try {
    idlePauseDelayMs({ ARMADA_RUNTIME_IDLE_MINUTES: "private-value" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain("private-value");
});
