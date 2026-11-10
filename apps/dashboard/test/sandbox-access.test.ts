import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "@armada/core";
import { parseSandboxListMetadata } from "../src/lib/sandbox-access.ts";

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
  const [parsed] = parseSandboxListMetadata([
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

test("a row that does not match the contract fails the read instead of being guessed", () => {
  for (const broken of [
    { ...row(), canOpen: "true" },
    { ...row(), machineSize: "huge" },
    { ...row(), provider: "aws" },
    { ...row(), status: "exploded" },
    { ...row(), createdAt: "yesterday" },
    (({ stoppedAt: _, ...rest }) => rest)(row()),
    (({ boatId: _, ...rest }) => rest)(row()),
    { ...row(), preservationNote: 7 },
  ])
    expect(() => parseSandboxListMetadata([broken])).toThrow("did not match its contract");
  expect(() => parseSandboxListMetadata({ rows: [] })).toThrow("did not match its contract");
});

test("the outcome and the preservation receipt are read, and an outcome off the contract is no outcome", () => {
  const ready = { state: "ready", prNumber: 12, prUrl: "https://github.com/acme/web/pull/12" } as const;
  const note = "unpushed work could not be preserved (timeout)";
  expect(parseSandboxListMetadata([{ ...row(), taskOutcome: ready, preservationNote: note }])[0]).toMatchObject({
    taskOutcome: ready,
    preservationNote: note,
  });
  const [odd] = parseSandboxListMetadata([{ ...row(), taskOutcome: { state: "done" }, preservationNote: undefined }]);
  expect(odd).toMatchObject({ taskOutcome: null, preservationNote: null });
});
