import { expect, test } from "bun:test";
import { checkProcessTests, processRules } from "./process-tests.ts";

test.each([
  ["Bun . spawn(['git']);", "Bun.spawn"],
  ["Bun['spawnSync'](['git']);", "Bun.spawnSync"],
  ["spawnSync('git');", "spawnSync"],
  ["import { spawn as run } from 'node:child_process';", "child_process"],
  ["await import('child_process');", "child_process"],
  ["require('node:child_process');", "child_process"],
  ["$\x60git status\x60;", "Bun shell template"],
  ["new Worker('./worker.ts');", "new Worker"],
])("reports the rule for %s", (source, rule) => {
  expect(processRules("suite.test.ts", source)).toEqual([rule]);
});

test("ignores inert mentions of process APIs", () => {
  const source = `
    // Bun.spawn(['git'])
    const fixture = "new Worker('./worker.ts')";
    import type { ChildProcess } from 'node:child_process';
  `;
  expect(processRules("suite.test.ts", source)).toEqual([]);
});

test("reports unlisted spawns and stale exceptions by path", () => {
  const sources = [
    ["added.test.ts", "Bun.spawn(['git']);"],
    ["kept.test.ts", "Bun.spawn(['git']);"],
    ["rewritten.test.ts", "expect(true).toBe(true);"],
  ] as const;
  expect(checkProcessTests(sources, new Set(["kept.test.ts", "rewritten.test.ts", "deleted.test.ts"]))).toEqual([
    "added.test.ts: process-spawning test matched Bun.spawn",
    "deleted.test.ts: remove the unused process-test allowlist entry",
    "rewritten.test.ts: remove the unused process-test allowlist entry",
  ]);
});

test("rejects a new exception even when it matches a spawning file", () => {
  const sources = [["new.test.ts", "Bun.spawn(['git']);"]] as const;
  expect(checkProcessTests(sources, new Set(["new.test.ts"]), new Set())).toEqual([
    "new.test.ts: process-test allowlist entries can only be removed",
  ]);
});
