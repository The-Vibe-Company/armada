import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCwdCommand, nativeCwdInstallScript } from "../src/native-cwd.ts";

function install(path: string, harness: "codex" | "claude", cwd: string, argv: readonly string[] = []) {
  return spawnSync("bash", ["-c", nativeCwdInstallScript(path, nativeCwdCommand(path, harness, cwd, argv))], {
    encoding: "utf8",
  });
}

for (const harness of ["codex", "claude"] as const) {
  test(`composes the ${harness} VM installer and wrapper without recursion`, () => {
    const base = mkdtempSync(join(tmpdir(), "armada-boat-native-cwd-"));
    try {
      const bin = join(base, "bin");
      const cwd = join(base, "repo with ' quote");
      const output = join(base, "output");
      mkdirSync(bin, { recursive: true });
      mkdirSync(cwd);
      const path = join(bin, harness);
      const native = `${path}-native`;
      writeFileSync(
        native,
        `#!/bin/sh\nprintf '%s\\n' "$PWD" > ${JSON.stringify(output)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(output)}\n`,
      );
      chmodSync(native, 0o755);
      symlinkSync(native, path);
      const argv =
        harness === "codex"
          ? ["--model", "gpt", "-C", "/bad", "--cd=/also-bad", "--", "-C", "/literal"]
          : ["--model", "sonnet"];
      expect(install(path, harness, cwd, argv).status).toBe(0);
      expect(install(path, harness, cwd, argv).status).toBe(0);
      expect(spawnSync(path, [], { encoding: "utf8" }).status).toBe(0);
      expect(readFileSync(output, "utf8").trim().split("\n")).toEqual(
        harness === "codex" ? [cwd, "--model", "gpt", "--", "-C", "/literal"] : [cwd, "--model", "sonnet"],
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
