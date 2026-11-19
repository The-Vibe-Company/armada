import { expect, test } from "bun:test";
import { planRenumber } from "./renumber-pending.ts";

const now = Date.parse("2026-11-17T07:00:00Z");

function inventory(...names: string[]) {
  return new Map(names.map((name) => [`supabase/migrations/${name}`, name.slice(0, 14)]));
}

test("renumbers pending migrations above main in order without renaming base files", () => {
  const base = inventory("20261117080000_base.sql");
  const head = inventory("20261117010001_second.sql", "20261117080000_base.sql", "20261117010000_x.sql");
  expect(planRenumber(base, head, now)).toEqual([
    { from: "supabase/migrations/20261117010000_x.sql", to: "supabase/migrations/20261117080001_x.sql" },
    { from: "supabase/migrations/20261117010001_second.sql", to: "supabase/migrations/20261117080002_second.sql" },
  ]);
});

test("refuses a missing base migration instead of treating its replacement as pending", () => {
  const base = inventory("20261117080000_base.sql");
  expect(() => planRenumber(base, inventory("20261117080001_base.sql"), now)).toThrow("Base migration missing");
});

test("skips the rounded second at a minute boundary", () => {
  const base = inventory("20261117080059_base.sql");
  const head = inventory("20261117080059_base.sql", "20261117010000_x.sql");
  expect(planRenumber(base, head, now)[0]?.to).toBe("supabase/migrations/20261117080101_x.sql");
});

test("refuses a plan when the next version would exceed the guard's future window", () => {
  const base = inventory("20261118065959_base.sql");
  const head = inventory("20261118065959_base.sql", "20261117010000_x.sql");
  expect(() => planRenumber(base, head, now)).toThrow("within 24 hours");
});
