import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { destructiveStatements, dropSafety } from "./check-migrations";

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

test("finds top-level drops and renames, including quoted names and multi-object statements", () => {
  expect(
    destructiveStatements(String.raw`
      -- DROP TABLE ignored;
      /* /* nested */ DROP TYPE ignored; */
      select 'DROP TYPE ignored;';
      select ${"$é$"}ignored; DROP TABLE ignored; ${"$é$"};
      do $body$ begin raise notice 'DROP TABLE ignored;'; end $body$;
      DROP TABLE IF EXISTS postgres.public.OLD_TABLE, "old.schema"."Old Table",
        public.U&"retired!005fitems" UESCAPE '!' CASCADE;
      drop view public.report;
      drop function public.old_lookup(numeric(10, 2), text), public.old_count();
      drop type public.report_state;
      drop trigger old_trigger on public.sandboxes;
      alter table only public.old_rows rename to new_rows;
      -- contract: last-used-in v2.57.1
      alter table postgres.public.sandboxes drop column if exists foo cascade, drop bar;
      alter table public.sandboxes rename other to replacement;
      -- contract: last-used-in v2.57.1
      alter type public.state rename value U&'ol\0064; value' to 'new';
      alter type public.mode rename value 'old'
        ' mode' to 'new';
      alter table public.sandboxes drop constraint unused_check;
    `),
  ).toEqual([
    ...[
      "old_table",
      "Old Table",
      "retired_items",
      "report",
      "old_lookup",
      "old_count",
      "report_state",
      "old_trigger",
      "old_rows",
    ].map((name) => ({ kind: "object" as const, name })),
    { kind: "column", name: "sandboxes.foo", lastUsedIn: "v2.57.1" },
    { kind: "column", name: "sandboxes.bar", lastUsedIn: "v2.57.1" },
    { kind: "column", name: "sandboxes.other", lastUsedIn: undefined },
    { kind: "enum value", name: String.raw`state.U&'ol\0064; value'`, lastUsedIn: "v2.57.1" },
    { kind: "enum value", name: "mode.'old'", lastUsedIn: undefined },
  ]);
});

test("object drops require both the base and release to be clean", () => {
  const statements = destructiveStatements("drop table public.retired_items;");
  const file = "packages/mcp-server/src/items.ts";
  for (const refWithReference of ["base", "v2.57.1", undefined]) {
    const files = new Map(refWithReference ? [[refWithReference, new Map([["retired_items", [file]]])]] : []);
    expect(
      dropSafety(statements, {
        base: "base",
        latestRelease: "v2.57.1",
        packageVersion: "v2.57.2",
        references: (name, ref) => files.get(ref)?.get(name) ?? [],
      }),
    ).toEqual(refWithReference ? [`retired_items is still referenced at ${refWithReference}: ${file}`] : []);
  }
});

test("column drops require an adjacent contract version covered by the release and older than the candidate", () => {
  const header = "-- contract: last-used-in v2.57.1";
  for (const { prefix, latestRelease, packageVersion, allowed } of [
    { prefix: "", latestRelease: "v2.57.1", packageVersion: "v2.57.2", allowed: false },
    { prefix: `${header}\n\n`, latestRelease: "v2.57.1", packageVersion: "v2.57.2", allowed: false },
    { prefix: `${header}\n`, latestRelease: "v2.57.0", packageVersion: "v2.57.2", allowed: false },
    { prefix: `${header}\n`, latestRelease: "v2.57.1", packageVersion: "v2.57.1", allowed: false },
    { prefix: `${header}\n`, latestRelease: "v2.57.1", packageVersion: "v2.57.2", allowed: true },
    { prefix: `${header}\r\n`, latestRelease: "v2.57.10", packageVersion: "v2.58.0", allowed: true },
  ]) {
    const errors = dropSafety(destructiveStatements(`${prefix}alter table public.sandboxes drop column foo;`), {
      base: "base",
      latestRelease,
      packageVersion,
      references: () => {
        throw new Error("Column names must not be searched");
      },
    });
    expect(errors).toHaveLength(allowed ? 0 : 1);
    if (!allowed) expect(errors[0]).toContain("column sandboxes.foo requires -- contract: last-used-in");
  }
});
