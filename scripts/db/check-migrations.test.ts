import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("migration CLI rejects collisions and non-increasing additions against the current base", () => {
  const script = resolve(import.meta.dir, "check-migrations.ts");
  const cases = [
    { files: ["20261112000001_next.sql"], ok: true },
    { files: [], ok: true },
    { files: ["20261112000001_a.sql", "20261112000001_b.sql"], ok: false, message: "Duplicate migration version" },
    { files: ["20261112000000_equal.sql"], ok: false, message: "strictly greater" },
    { files: ["20261111000000_old.sql"], ok: false, message: "strictly greater" },
    { files: ["bad.sql"], ok: false, message: "Invalid migration filename" },
  ];
  for (const scenario of cases) {
    const cwd = mkdtempSync(join(tmpdir(), "migration-guard-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    try {
      git("init");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Test");
      mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
      writeFileSync(join(cwd, "supabase/migrations/20261112000000_base.sql"), "-- base");
      git("add", ".");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      for (const file of scenario.files) writeFileSync(join(cwd, "supabase/migrations", file), "-- new");
      git("add", ".");
      git("commit", "--allow-empty", "-m", "candidate");
      const result = spawnSync(process.execPath, [script, base], { cwd, encoding: "utf8" });
      expect(result.status).toBe(scenario.ok ? 0 : 1);
      if (scenario.message) expect(result.stderr).toContain(scenario.message);
      // A concurrent merge advances main past the previously valid candidate.
      if (scenario.ok && scenario.files.length) {
        const candidate = git("rev-parse", "HEAD");
        git("checkout", "--detach", base);
        writeFileSync(join(cwd, "supabase/migrations/20261112000002_concurrent.sql"), "-- main advanced");
        git("add", ".");
        git("commit", "-m", "advance base");
        const advanced = spawnSync(process.execPath, [script, "HEAD", candidate], { cwd, encoding: "utf8" });
        expect(advanced.status).toBe(1);
        expect(advanced.stderr).toContain("strictly greater");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
