import { describe, expect, test } from "bun:test";
import type { SandboxListMetadata } from "@armada/core";
import {
  filterSandboxes,
  filtersToSearch,
  parseSandboxFilters,
  sandboxFacetCounts,
  sortSandboxes,
} from "../src/lib/sandbox-filters.ts";

const ALICE = "00000000-0000-4000-8000-000000000001";
function row(id: string, overrides: Partial<SandboxListMetadata> = {}): SandboxListMetadata {
  return {
    id,
    orgId: "org",
    ownerId: ALICE,
    provider: "boat",
    providerSandboxId: `bx_${id}`,
    boatId: `bx_${id}`,
    harness: "claude",
    model: "opus",
    reasoningEffort: null,
    status: "running",
    createdAt: "2026-11-08T10:00:00Z",
    stoppedAt: null,
    expiresAt: null,
    effectiveTtlSeconds: null,
    machineSize: null,
    displayLabel: `Sandbox ${id}`,
    canOpen: true,
    canManage: true,
    ...overrides,
  };
}
const rows = [
  row("run"),
  row("fail", { provider: "modal", harness: "codex", status: "failed", model: "gpt" }),
  row("other", { ownerId: "bob" }),
  row("gone", { status: "deleted" }),
];

describe("sandbox filters", () => {
  test("URL roundtrip preserves repeated facets, search, sort and page; invalid input is normalized", () => {
    const filters = parseSandboxFilters({
      status: ["running", "failed", "running", "exploded"],
      provider: ["boat", "invalid"],
      harness: "codex",
      owner: "me",
      model: "gpt",
      q: " bx_ ",
      sort: "oldest",
      page: "3",
    });
    const search = filtersToSearch(filters);
    expect(search).toBe(
      "?q=bx_&status=running&status=failed&provider=boat&harness=codex&model=gpt&owner=me&sort=oldest&page=3",
    );
    const params: Record<string, string[]> = {};
    for (const [key, value] of new URLSearchParams(search)) {
      params[key] ??= [];
      params[key].push(value);
    }
    expect(parseSandboxFilters(params)).toEqual(filters);
    expect(
      parseSandboxFilters({ owner: "someone", page: "3junk", sort: "wrong", size: "huge", golden: "hidden" }),
    ).toEqual(parseSandboxFilters({}));
    expect(filtersToSearch(parseSandboxFilters({}))).toBe("");
    for (const page of ["0", "-1", "1.5", "Infinity", "9007199254740992"])
      expect(parseSandboxFilters({ page }).page).toBe(1);
  });

  test("search and multi-facet intersection use all metadata rows, mine is scoped, deleted is opt-in", () => {
    expect(filterSandboxes(rows, parseSandboxFilters({}), ALICE).map((row) => row.id)).toEqual([
      "run",
      "fail",
      "other",
    ]);
    expect(
      filterSandboxes(rows, parseSandboxFilters({ status: ["running", "failed"], owner: "me" }), ALICE).map(
        (row) => row.id,
      ),
    ).toEqual(["run", "fail"]);
    expect(
      filterSandboxes(
        rows,
        parseSandboxFilters({ q: "BX_FAIL", provider: "modal", harness: "codex", model: "gpt" }),
        ALICE,
      ).map((row) => row.id),
    ).toEqual(["fail"]);
    expect(filterSandboxes(rows, parseSandboxFilters({ q: "sandbox run" }), ALICE).map((row) => row.id)).toEqual([
      "run",
    ]);
    expect(filterSandboxes(rows, parseSandboxFilters({ status: "deleted" }), ALICE).map((row) => row.id)).toEqual([
      "gone",
    ]);
    expect(filterSandboxes(rows, parseSandboxFilters({ q: "no match" }), ALICE)).toEqual([]);
  });

  test("facet counts ignore their own selection but honor search and all other facets", () => {
    const counts = sandboxFacetCounts(rows, parseSandboxFilters({ status: "running", owner: "me" }), ALICE);
    expect([...counts.status]).toEqual([
      ["running", 1],
      ["failed", 1],
      ["deleted", 1],
    ]);
    expect([...counts.provider]).toEqual([
      ["boat", 1],
      ["modal", 0],
    ]);
    expect(counts.owner.get(ALICE)).toBe(1);
    expect(counts.owner.get("bob")).toBe(1);
  });

  test("attention puts failures and blocked work before ready results and running machines, with stable ties", () => {
    const inventory = [
      row("z"),
      row("a"),
      row("ready", { status: "ready", taskOutcome: { state: "ready" } }),
      row("blocked", { status: "stopped", taskOutcome: { state: "blocked", reason: "Need input" } }),
    ];
    expect(sortSandboxes(inventory, "attention").map((row) => row.id)).toEqual(["blocked", "ready", "a", "z"]);
    expect(
      sortSandboxes([row("old"), row("new", { createdAt: "2026-11-09T10:00:00Z" })], "newest").map((row) => row.id),
    ).toEqual(["new", "old"]);
    expect(
      sortSandboxes([row("old"), row("new", { createdAt: "2026-11-09T10:00:00Z" })], "oldest").map((row) => row.id),
    ).toEqual(["old", "new"]);
  });
});
