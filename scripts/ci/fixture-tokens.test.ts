import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactKnownTokens } from "../../packages/core/src/token-redaction.ts";

// Repository policy: fixtures are inert; scanner-positive bytes are built at runtime.
test("test sources and fixtures contain no token-shaped literals", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const paths = new Set<string>();
  for (const pattern of [
    "{packages,apps}/*/{test,e2e}/**/*.{ts,json,txt,sh,md}",
    "{packages,apps}/*/src/**/*.test.ts",
    "scripts/**/*.{test,release}.ts",
  ]) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) paths.add(path);
  }
  const violations: string[] = [];
  for (const path of paths) {
    const source = readFileSync(`${root}/${path}`, "utf8");
    // Service tokens are validated by auth, not the output redactor. Anthropic
    // fixtures must also avoid plausible pasted credential strings.
    const otherToken = /\b(?:armada_(?:sk|mcp|mrt)_[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{15,})/;
    if (redactKnownTokens(source) !== source || otherToken.test(source)) violations.push(path);
  }
  expect(paths.size).toBeGreaterThan(0);
  expect(violations.sort()).toEqual([]);
});
