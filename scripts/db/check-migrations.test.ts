import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("migration CLI rejects collisions, placeholder versions and non-increasing additions against the current base", () => {
  const script = resolve(import.meta.dir, "check-migrations.ts");
  // The guard's clock is fixed; new versions may lead it by at most 24 hours.
  const env = { ...process.env, MIGRATION_GUARD_NOW: "2026-11-12T12:00:00Z" };
  const renumber = "Renumber each rejected new migration: use distinct valid UTC versions with seconds other than 00";
  const cases: { files: string[]; ok: boolean; message?: string; raced?: boolean; baseFile?: string; also?: string }[] =
    [
      // Main may already hold a version ahead of the clock: the instruction names
      // the base maximum, and a version above it inside the window passes.
      {
        baseFile: "20261112130000_ahead.sql",
        files: ["20261112120001_now.sql"],
        ok: false,
        message: "greater than 20261112130000 (the latest version on",
        also: "and no later than 20261113120000",
      },
      { baseFile: "20261112130000_ahead.sql", files: ["20261112130001_after_base.sql"], ok: true },
      { files: ["20261112000001_next.sql"], ok: true, raced: true },
      { files: [], ok: true },
      { files: ["20261113115959_window_edge.sql"], ok: true },
      { files: ["20261112120100_rounded.sql"], ok: false, message: "minute-rounded version" },
      { files: ["99999999999999_placeholder.sql"], ok: false, message: "valid UTC timestamp" },
      {
        files: ["99991231235959_placeholder.sql"],
        ok: false,
        message: "more than 24 hours ahead of the current UTC time. Use a version no later than 20261113120000.",
      },
      { files: ["20261113120001_past_window.sql"], ok: false, message: "more than 24 hours ahead" },
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
      writeFileSync(join(cwd, "supabase/migrations", scenario.baseFile ?? "20261112000000_base.sql"), "-- base");
      git("add", ".");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      for (const file of scenario.files) writeFileSync(join(cwd, "supabase/migrations", file), "-- new");
      git("add", ".");
      git("commit", "--allow-empty", "-m", "candidate");
      const result = spawnSync(process.execPath, [script, base], { cwd, env, encoding: "utf8" });
      expect(result.status).toBe(scenario.ok ? 0 : 1);
      if (scenario.message) expect(result.stderr).toContain(scenario.message);
      if (scenario.also) expect(result.stderr).toContain(scenario.also);
      if (scenario.message && scenario.message !== "Invalid migration filename")
        expect(result.stderr).toContain(renumber);
      // A concurrent merge advances main past the previously valid candidate.
      if (scenario.raced) {
        const candidate = git("rev-parse", "HEAD");
        git("checkout", "--detach", base);
        writeFileSync(join(cwd, "supabase/migrations/20261112000002_concurrent.sql"), "-- main advanced");
        git("add", ".");
        git("commit", "-m", "advance base");
        const advanced = spawnSync(process.execPath, [script, "HEAD", candidate], { cwd, env, encoding: "utf8" });
        expect(advanced.status).toBe(1);
        expect(advanced.stderr).toContain("strictly greater");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
