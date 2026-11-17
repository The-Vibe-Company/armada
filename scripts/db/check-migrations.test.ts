import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("migration CLI rejects collisions, placeholder versions and non-increasing additions against the current base", () => {
  const script = resolve(import.meta.dir, "check-migrations.ts");
  // The guard's clock is fixed; new versions may lead it by at most 24 hours.
  const cases: {
    files: string[];
    ok: boolean;
    message?: string;
    suggestion?: string;
    raced?: boolean;
    emptyBase?: boolean;
    baseFile?: string;
    now?: string;
    applySuggestions?: boolean;
  }[] = [
    { files: ["20261112000001_next.sql"], ok: true, raced: true },
    { files: [], ok: true },
    { files: ["20261113115959_window_edge.sql"], ok: true },
    {
      files: ["20261112120100_rounded.sql", "20261112120159_other.sql"],
      ok: false,
      message: "minute-rounded version",
      // The rename keeps the rounded file ahead of the one that follows it.
      suggestion: "20261112120001 for supabase/migrations/20261112120100_rounded.sql",
    },
    {
      files: ["20261112115900_first.sql", "20261112120000_second.sql", "20261113115959_last.sql"],
      ok: false,
      message: "minute-rounded version",
      suggestion: "20261112120002 for supabase/migrations/20261112120000_second.sql",
    },
    {
      // A rounded file squeezed against the base with no free second left.
      files: ["20261112005959_kept.sql", "20261112010000_rounded.sql", "20261112010001_after.sql"],
      ok: false,
      message:
        "No free version for supabase/migrations/20261112010000_rounded.sql within 24 hours of the current UTC time between supabase/migrations/20261112005959_kept.sql and supabase/migrations/20261112010001_after.sql",
    },
    {
      // Without a base migration, the rename sits between neighbours rather
      // than above the newest candidate, and no base is blamed.
      emptyBase: true,
      files: ["20261112120100_rounded.sql", "20261113115959_late.sql"],
      ok: false,
      message: "minute-rounded version",
      suggestion: "20261112120001 for supabase/migrations/20261112120100_rounded.sql",
    },
    {
      // Two rejected files in a tight gap below a kept one: both renames are
      // allocated together and pack against the kept file, in order.
      now: "2026-11-12T12:02:00Z",
      baseFile: "20261112115957_base.sql",
      files: ["20261112120000_first.sql", "20261112120100_second.sql", "20261112120201_keep.sql"],
      ok: false,
      message: "minute-rounded version",
      suggestion: "20261112120158 for supabase/migrations/20261112120000_first.sql",
      applySuggestions: true,
    },
    {
      // The gap holds both renames only if the first goes below now.
      baseFile: "20261112115800_base.sql",
      files: ["20261112115900_first.sql", "20261112120000_second.sql", "20261112120002_keep.sql"],
      ok: false,
      message: "minute-rounded version",
      suggestion: "20261112115959 for supabase/migrations/20261112115900_first.sql",
      applySuggestions: true,
    },
    {
      files: ["99999999999999_placeholder.sql"],
      ok: false,
      message: "valid UTC timestamp",
      suggestion: "20261112120001",
    },
    {
      files: ["99991231235959_placeholder.sql"],
      ok: false,
      message: "more than 24 hours ahead of the current UTC time. Use a version no later than 20261113120000.",
      suggestion: "20261112120001",
    },
    { files: ["20261113120001_past_window.sql"], ok: false, message: "more than 24 hours ahead" },
    { files: ["20261112000001_a.sql", "20261112000001_b.sql"], ok: false, message: "Duplicate migration version" },
    { files: ["20261112000000_equal.sql"], ok: false, message: "strictly greater" },
    { files: ["20261111000000_old.sql"], ok: false, message: "strictly greater" },
    { files: ["bad.sql"], ok: false, message: "Invalid migration filename" },
  ];
  for (const scenario of cases) {
    const env = { ...process.env, MIGRATION_GUARD_NOW: scenario.now ?? "2026-11-12T12:00:00Z" };
    const cwd = mkdtempSync(join(tmpdir(), "migration-guard-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    try {
      git("init");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Test");
      mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
      if (!scenario.emptyBase)
        writeFileSync(join(cwd, "supabase/migrations", scenario.baseFile ?? "20261112000000_base.sql"), "-- base");
      git("add", ".");
      git("commit", "--allow-empty", "-m", "base");
      const base = git("rev-parse", "HEAD");
      for (const file of scenario.files) writeFileSync(join(cwd, "supabase/migrations", file), "-- new");
      git("add", ".");
      git("commit", "--allow-empty", "-m", "candidate");
      const result = spawnSync(process.execPath, [script, base], { cwd, env, encoding: "utf8" });
      expect(result.status).toBe(scenario.ok ? 0 : 1);
      if (scenario.message) expect(result.stderr).toContain(scenario.message);
      if (scenario.suggestion) expect(result.stderr).toContain(`Use migration version ${scenario.suggestion}`);
      if (!scenario.ok) expect(result.stderr).not.toContain("a base migration is too far ahead");
      // Applying every suggested rename passes the guard and keeps the
      // original order of the unapplied migrations.
      if (scenario.applySuggestions) {
        const renames = [
          ...result.stderr.matchAll(/Use migration version (\d{14}) for supabase\/migrations\/(\d{14})_(.+)\.sql/g),
        ];
        expect(renames.length).toBeGreaterThan(0);
        for (const [, version, , name] of renames) {
          const file = scenario.files.find((candidate) => candidate.endsWith(`_${name}.sql`)) as string;
          git("mv", `supabase/migrations/${file}`, `supabase/migrations/${version}_${name}.sql`);
        }
        git("commit", "-m", "apply suggestions");
        const rerun = spawnSync(process.execPath, [script, base], { cwd, env, encoding: "utf8" });
        expect(rerun.stderr).toBe("");
        expect(rerun.status).toBe(0);
        const order = (names: string[]) => names.sort().map((file) => file.replace(/^\d{14}_/, ""));
        expect(
          order(
            git("ls-files", "supabase/migrations")
              .split("\n")
              .map((path) => path.split("/").at(-1) as string),
          ),
        ).toEqual(order([scenario.baseFile ?? "20261112000000_base.sql", ...scenario.files]));
      }
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
