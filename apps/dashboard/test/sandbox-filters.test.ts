import { describe, expect, test } from "bun:test";
import { filtersToSearch, parseSandboxFilters } from "../src/lib/sandbox-filters.ts";

const GOLDEN = "00000000-0000-4000-8000-000000000020";

describe("sandbox filters", () => {
  test("known values are read off the URL and anything else is ignored", () => {
    expect(
      parseSandboxFilters({ status: "running", harness: "codex", golden: GOLDEN, owner: "me", page: "3" }),
    ).toEqual({
      status: "running",
      harness: "codex",
      golden: GOLDEN,
      owner: "me",
      page: 3,
    });
    expect(
      parseSandboxFilters({
        status: "exploded",
        harness: "vim",
        golden: "x'; drop table",
        owner: "someone",
        page: "-4",
      }),
    ).toEqual({
      status: null,
      harness: null,
      golden: null,
      owner: null,
      page: 1,
    });
    expect(parseSandboxFilters({ status: ["failed", "running"] }).status).toBe("failed");
  });

  test("filters go back into a query string, without the defaults", () => {
    expect(filtersToSearch({})).toBe("");
    expect(filtersToSearch({ status: "failed", page: 1 })).toBe("?status=failed");
    expect(filtersToSearch({ harness: "claude", page: 2 })).toBe("?harness=claude&page=2");
  });
});
