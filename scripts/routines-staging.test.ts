import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Offline stdlib tests exercise the coordinator client, never live staging or real clocks.
test("routine staging script validates proof, cleanup and credential-safe HTTP", () => {
  const result = Bun.spawnSync(
    ["python3", "-m", "unittest", "discover", "-s", "scripts/routines", "-p", "test_staging_check.py"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  expect(result.exitCode).toBe(0);
});
