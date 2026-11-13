import { expect, test } from "bun:test";
import { sandboxListName } from "../src/lib/sandbox-list-name.ts";

const row = {
  providerSandboxId: null,
  displayLabel: "Sandbox 00000000-0000-4000-8000-000000000030",
  harness: "codex" as const,
  createdAt: "2026-11-08T10:05:03Z",
};

test("list names preserve short aliases but describe opaque identifiers with public agent/time metadata", () => {
  expect(sandboxListName({ ...row, providerSandboxId: "workstation-task" })).toBe("workstation-task");
  for (const providerSandboxId of [null, "x".repeat(150), "sb-00000000-0000-4000-8000-000000000030", "a".repeat(32)])
    expect(sandboxListName({ ...row, providerSandboxId })).toBe("Codex sandbox · Nov 8, 2026, 10:05:03 UTC");
  expect(sandboxListName({ ...row, createdAt: "invalid" })).toBe("Codex sandbox");
});
