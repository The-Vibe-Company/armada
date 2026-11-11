import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Git credential test cannot consult host configuration or expose host tokens in its output", () => {
  const root = mkdtempSync(join(tmpdir(), "hostile-git-"));
  // Synthetic only: never read a live host credential to test non-disclosure.
  const canary = "ghp_" + "z".repeat(36);
  try {
    writeFileSync(join(root, "git"), `#!/bin/sh
printf '%s\\n' '${canary}' >&2
printf '%s\\n' '${canary}'
exit 1
`, { mode: 0o700 });
    const config = join(root, "host.gitconfig");
    writeFileSync(config, `[credential]\n helper = "!echo password=${canary}"\n`);
    const result = Bun.spawnSync(
      [process.execPath, "test", resolve("packages/core/test/github.test.ts"), "--test-name-pattern", "sets the identity"],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          HOME: root,
          XDG_CONFIG_HOME: root,
          GH_TOKEN: canary,
          GITHUB_TOKEN: canary,
          GIT_CONFIG_SYSTEM: config,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: `!echo password=${canary}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = result.stdout.toString() + result.stderr.toString();
    // Boolean assertions prevent this guard itself from printing captured credentials.
    expect(output.includes(canary)).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(config, "utf8").includes(canary)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
