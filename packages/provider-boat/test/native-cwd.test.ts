import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nativeCwdInstallScript } from "../src/native-cwd.ts";

function install(path: string, command: string) {
  return spawnSync("bash", ["-c", nativeCwdInstallScript(path, command)], { encoding: "utf8" });
}

test("preserves Boat's native executable and atomically installs an idempotent cwd wrapper", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-boat-native-cwd-"));
  try {
    const bin = join(base, "usr", "local", "bin");
    const repoB = join(base, "repoB");
    const output = join(base, "output");
    mkdirSync(bin, { recursive: true });
    mkdirSync(repoB);
    const original = join(bin, "codex-bin");
    writeFileSync(
      original,
      `#!/bin/sh\nprintf '%s\\n' "$PWD" > ${JSON.stringify(output)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(output)}\n`,
    );
    chmodSync(original, 0o755);
    const path = join(bin, "codex");
    symlinkSync(original, path);
    const command = `cd -- ${JSON.stringify(repoB)} && exec ${JSON.stringify(`${path}.armada-original`)} "$@"`;

    expect(install(path, command).status).toBe(0);
    expect(install(path, command).status).toBe(0);
    const result = spawnSync(path, ["--model", "x"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8").trim().split("\n")).toEqual([repoB, "--model", "x"]);
    expect(readFileSync(`${path}.armada-original`, "utf8")).toContain("$PWD");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fails before prompt when Boat's native executable is unavailable", () => {
  const result = install("/definitely/missing/codex", "exec true");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("native harness is unavailable");
});
