import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@armada/core";
import { compile, hostTarget } from "../../../scripts/build.ts";

let dir: string;
let binary: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "armada-binary-"));
  binary = compile(hostTarget(), join(dir, "armada"));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the compiled binary prints the version", () => {
  const result = Bun.spawnSync([binary, "--version"], { env: {} });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`${VERSION}\n`);
});
