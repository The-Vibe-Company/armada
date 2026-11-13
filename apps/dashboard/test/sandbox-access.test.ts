import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "@armada/core";
import { parseSandboxListMetadata, skippedRowsNote } from "../src/lib/sandbox-access.ts";
import { filterSandboxes, parseSandboxFilters, sandboxFacetCounts } from "../src/lib/sandbox-filters.ts";

const ORG = "00000000-0000-4000-8000-000000000011";
const BOB = "00000000-0000-4000-8000-000000000002";

function row(overrides: Partial<SandboxListMetadata> = {}): SandboxListMetadata {
  const id = overrides.id ?? "00000000-0000-4000-8000-000000000031";
  return {
    id,
    orgId: ORG,
    ownerId: BOB,
    provider: "modal",
    providerSandboxId: "sb-modal-1",
    boatId: null,
    harness: "codex",
    model: null,
    reasoningEffort: null,
    status: "running",
    createdAt: "2026-11-08T10:05:00.000Z",
    stoppedAt: null,
    expiresAt: null,
    effectiveTtlSeconds: null,
    machineSize: "large",
    taskOutcome: null,
    preservationNote: null,
    displayLabel: `Sandbox ${id}`,
    canOpen: false,
    canManage: false,
    ...overrides,
  };
}

test("only the contract's fields of a listed sandbox reach the page, with PostgREST timestamps made ISO", () => {
  const listed = row({ expiresAt: "2026-11-08T18:05:00.000Z" });
  // An interior field a producer might return by mistake is dropped, never displayed.
  const {
    rows: [parsed],
  } = parseSandboxListMetadata([
    {
      ...listed,
      createdAt: "2026-11-08T10:05:00+00:00",
      expiresAt: "2026-11-08T19:05:00+01:00",
      goldenId: "g",
      conversationIds: ["c"],
      statusReason: "boom",
      visibility: "private",
    },
  ]);
  expect(parsed).toEqual(listed);
});

test("a row that does not match the contract is left out and reported, never guessed, and the others still show", () => {
  const good = row({ id: "00000000-0000-4000-8000-000000000032" });
  for (const [broken, reason] of [
    [{ ...row(), canOpen: "true" }, "permissions"],
    [{ ...row(), machineSize: "huge" }, "optional fields"],
    [{ ...row(), provider: "aws" }, "provider"],
    [{ ...row(), status: "exploded" }, "status"],
    [{ ...row(), createdAt: "yesterday" }, "identity"],
    [(({ stoppedAt: _, ...rest }) => rest)(row()), "optional fields"],
    [(({ boatId: _, ...rest }) => rest)(row()), "optional fields"],
    [{ ...row(), preservationNote: 7 }, "optional fields"],
  ] as const)
    expect(parseSandboxListMetadata([broken, good])).toEqual({ rows: [good], skipped: [{ id: row().id, reason }] });
  expect(parseSandboxListMetadata(["x"]).skipped).toEqual([{ id: null, reason: "not an object" }]);
  // A response that is not a list at all is still a failed read.
  expect(() => parseSandboxListMetadata({ rows: [] })).toThrow("did not match its contract");
  expect(skippedRowsNote(0)).toBeNull();
  expect(skippedRowsNote(1)).toBe("1 sandbox could not be shown.");
  expect(skippedRowsNote(3)).toBe("3 sandboxes could not be shown.");
});

test("the outcome and the preservation receipt are read, and an outcome off the contract is no outcome", () => {
  const ready = { state: "ready", prNumber: 12, prUrl: "https://github.com/acme/web/pull/12" } as const;
  const note = "unpushed work could not be preserved (timeout)";
  expect(parseSandboxListMetadata([{ ...row(), taskOutcome: ready, preservationNote: note }]).rows[0]).toMatchObject({
    taskOutcome: ready,
    preservationNote: note,
  });
  const {
    rows: [odd],
  } = parseSandboxListMetadata([{ ...row(), taskOutcome: { state: "done" }, preservationNote: undefined }]);
  expect(odd).toMatchObject({ taskOutcome: null, preservationNote: null });
});

test("a sandbox on a Docker host is listed, so one such row no longer fails the whole list", () => {
  const docker: SandboxListMetadata = row({ provider: "docker", providerSandboxId: null, machineSize: null });
  const [listed] = parseSandboxListMetadata([row(), docker]).rows.slice(1);
  expect(listed?.provider).toBe("docker");
  expect(parseSandboxFilters({ provider: ["docker", "aws"] }).provider).toEqual(["docker"]);
});

test("Docker rows filter and count under their own provider value", () => {
  const { rows } = parseSandboxListMetadata([
    row({ id: "00000000-0000-4000-8000-000000000041" }),
    { ...row({ id: "00000000-0000-4000-8000-000000000042" }), provider: "docker" },
  ]);
  const filters = parseSandboxFilters({ provider: "docker" });
  expect(filterSandboxes(rows, filters, BOB).map((item) => item.id)).toEqual(["00000000-0000-4000-8000-000000000042"]);
  expect(sandboxFacetCounts(rows, parseSandboxFilters({}), BOB).provider.get("docker")).toBe(1);
});
