import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@armada/core";
import { hostTarget, TARGETS } from "../../../scripts/build.ts";
import { NPM_PACKAGE, platformPackage, stageNpm } from "../../../scripts/npm.ts";

let dir: string;
const runtime = Bun.which("node") ?? process.execPath;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "armada-npm-"));
  mkdirSync(join(dir, "binaries"));
  // A stand-in for the compiled binary: it echoes its arguments and exits 3.
  writeFileSync(join(dir, "binaries", `armada-${hostTarget()}`), '#!/bin/sh\necho "args: $*"\nexit 3\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Lays the staged packages out as npm installs them, and returns the main package's bin. */
function install(root: string, withPlatform: boolean): string {
  const staged = stageNpm({ binaries: join(dir, "binaries"), out: join(dir, "npm"), targets: [hostTarget()] });
  for (const { name, dir: source } of staged) {
    if (!withPlatform && name !== NPM_PACKAGE) continue;
    cpSync(source, join(root, "node_modules", name), { recursive: true });
  }
  return join(root, "node_modules", NPM_PACKAGE, "bin/armada.cjs");
}

test("the main package lists every platform binary at its own version", async () => {
  const staged = stageNpm({ binaries: join(dir, "binaries"), out: join(dir, "npm"), targets: [hostTarget()] });
  expect(staged.map((item) => item.name)).toEqual([platformPackage(hostTarget()), NPM_PACKAGE]);
  const main = await Bun.file(join(dir, "npm/armada/package.json")).json();
  expect(main.version).toBe(VERSION);
  expect(main.bin).toEqual({ armada: "bin/armada.cjs" });
  expect(main.optionalDependencies).toEqual(Object.fromEntries(TARGETS.map((t) => [platformPackage(t), VERSION])));
  const platform = await Bun.file(join(dir, `npm/armada-${hostTarget()}/package.json`)).json();
  expect([platform.os, platform.cpu]).toEqual([[process.platform], [process.arch]]);
});

test("the launcher runs the platform binary with the arguments and its exit code", () => {
  const bin = install(join(dir, "full"), true);
  const result = Bun.spawnSync([runtime, bin, "launch", "monka", "--json"]);
  expect(result.stdout.toString()).toBe("args: launch monka --json\n");
  expect(result.exitCode).toBe(3);
});

test("the launcher names the missing platform package", () => {
  const bin = install(join(dir, "bare"), false);
  const result = Bun.spawnSync([runtime, bin, "--version"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(`${platformPackage(hostTarget())}@${VERSION} is not installed`);
});
