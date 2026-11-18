import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNativeCwdWrapper, nativeCwdCommand } from "../src/native-cwd.ts";

test("ordinary Claude needs no Python bridge and managed installation refuses a missing interpreter before mutation", async () => {
  const home = mkdtempSync(join(tmpdir(), "armada-claude-interpreter-"));
  const path = join(home, "claude");
  writeFileSync(`${path}.armada-original`, "#!/bin/sh\nprintf native-without-python", { mode: 0o755 });
  try {
    const ordinary = spawnSync("/bin/bash", ["-c", nativeCwdCommand(path, "claude")], {
      env: { HOME: home, PATH: "/nonexistent" },
      encoding: "utf8",
    });
    expect(ordinary.status).toBe(0);
    expect(ordinary.stdout).toBe("native-without-python");
    await expect(
      installNativeCwdWrapper(
        async (request) => {
          const result = spawnSync("/bin/bash", ["-c", request.command], {
            env: { HOME: home, PATH: "/nonexistent" },
            encoding: "utf8",
          });
          expect(result.stderr).toContain("python3: command not found");
          if (result.status !== 0) throw Error("Interpreter unavailable; install refused");
        },
        "parent",
        "claude",
        undefined,
        true,
      ),
    ).rejects.toThrow("install refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
