import { expect, test } from "bun:test";
import { join } from "node:path";

test("sandbox staging runner's offline safety contracts", () => {
  const result = Bun.spawnSync(
    ["python3", "-m", "unittest", "discover", "-s", join(import.meta.dir), "-p", "test_*.py"],
    {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
