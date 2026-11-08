import { describe, expect, test } from "bun:test";
import { explainDbError, isUuid } from "../src/lib/action.ts";

describe("action errors", () => {
  test("a row level security denial is one sentence, whatever Postgres says", () => {
    expect(
      explainDbError({ code: "42501", message: 'new row violates row-level security policy for table "credentials"' }),
    ).toBe("You are not allowed to do that.");
    expect(explainDbError({ message: "permission denied for table orgs" })).toBe("You are not allowed to do that.");
  });

  test("a duplicate names what already exists", () => {
    expect(
      explainDbError({ code: "23505", message: 'duplicate key value violates unique constraint "members_pkey"' }),
    ).toBe("They are already a member of this org.");
    expect(explainDbError({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(
      "That already exists.",
    );
  });

  test("the messages the dashboard functions raise reach the person, other failures do not leak", () => {
    expect(
      explainDbError({ code: "P0002", message: "no account for that email: the person signs in to Armada once first" }),
    ).toContain("signs in to Armada once first");
    expect(explainDbError({ code: "23514", message: "an org keeps at least one admin" })).toBe(
      "an org keeps at least one admin",
    );
    expect(explainDbError({ code: "23514", message: 'violates check constraint "orgs_name_chk"' })).toBe(
      "The name must be between 1 and 120 characters.",
    );
    expect(explainDbError({ code: "XX000", message: 'relation "secret_table" is broken' })).toBe(
      "Something went wrong. Try again.",
    );
  });

  test("ids from a form are checked before they reach a query", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isUuid("1 or 1=1")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
