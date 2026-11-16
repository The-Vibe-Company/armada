import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REQUIRED_MIGRATION } from "../packages/mcp-server/src/required-migration.ts";
import { compile, hostTarget } from "./build.ts";

test("standalone builds freeze required migration without repository files at runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "armada-migration-build-"));
  try {
    const entry = join(root, "entry.ts");
    writeFileSync(
      entry,
      `import { REQUIRED_MIGRATION } from ${JSON.stringify(resolve(import.meta.dir, "../packages/mcp-server/src/required-migration.ts"))}; console.log(REQUIRED_MIGRATION);`,
    );
    const binary = compile(hostTarget(), join(root, "probe"), entry);
    rmSync(entry);
    const result = Bun.spawnSync([binary], {
      cwd: root,
      env: { ARMADA_REQUIRED_MIGRATION: "20000101000000" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(REQUIRED_MIGRATION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
