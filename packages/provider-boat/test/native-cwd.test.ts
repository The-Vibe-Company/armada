import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCwdCommand, nativeCwdInstallScript } from "../src/native-cwd.ts";

function install(path: string, harness: "codex" | "claude", cwd: string) {
  return spawnSync("bash", ["-c", nativeCwdInstallScript(path, nativeCwdCommand(path, harness, cwd))], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

for (const harness of ["codex", "claude"] as const) {
  test(`installs the ${harness} VM wrapper and preserves dynamic argv without recursion`, () => {
    const base = mkdtempSync(join(tmpdir(), "armada-boat-native-cwd-"));
    try {
      const bin = join(base, "bin with ' quote");
      const cwd = join(base, "repo with ' quote $ and ` shell");
      const output = join(base, "output");
      mkdirSync(bin, { recursive: true });
      mkdirSync(cwd);
      const path = join(bin, harness);
      const native = `${path}-native`;
      writeFileSync(
        native,
        `#!/bin/sh
printf '%s\\0' invocation "$PWD" >> ${JSON.stringify(output)}
for arg do printf '%s\\0' "$arg" >> ${JSON.stringify(output)}; done
exit 23
`,
      );
      chmodSync(native, 0o755);
      symlinkSync(native, path);
      expect(install(path, harness, base).status).toBe(0);
      expect(install(path, harness, cwd).status).toBe(0);
      expect(install(path, harness, cwd).status).toBe(0);

      // Boat supplies these only when it starts the installed native agent.
      const common = ["--model", "runtime-model", "--protocol", "stream", "", "a ' quote", "$(exit 99)", "line\nbreak"];
      const overrides = ["-C", "/bad", "--cd", "/also-bad", "--cd=/third-bad"];
      const literal = ["--", "-C", "/literal", "--cd=/literal-too"];
      const runtimeArgs = [...common, ...overrides, ...literal];
      const run = (args: string[]) =>
        spawnSync(path, args, {
          encoding: "utf8",
          timeout: 5_000,
          cwd: base,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
      expect(run(runtimeArgs).status).toBe(23);
      // A later invocation must not replay the earlier runtime arguments.
      expect(run(["--model=second-model", "--json", "-C"]).status).toBe(23);
      expect(readFileSync(output, "utf8").split("\0")).toEqual([
        "invocation",
        cwd,
        ...common,
        ...(harness === "claude" ? overrides : []),
        ...literal,
        "invocation",
        cwd,
        "--model=second-model",
        "--json",
        ...(harness === "claude" ? ["-C"] : []),
        "",
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
