import { expect, test } from "bun:test";
import { ControlError } from "../src/lib/control";
import { snapshotActionFailure } from "../src/lib/snapshot-action-errors";

const diagnostic = "HTTP 503: provider_snapshot_id digest sha256:example";

test("snapshot action errors suppress diagnostics and give permission or observation recovery", () => {
  for (const status of [undefined, 400, 401, 403, 404, 409, 503])
    expect(snapshotActionFailure(new ControlError(diagnostic, status, "unavailable"), "remove")).not.toContain(
      diagnostic,
    );
  expect(snapshotActionFailure(new ControlError(diagnostic, 403), "cancel")).toContain("build owner");
  expect(snapshotActionFailure(new ControlError(diagnostic, 401), "find")).toContain("Sign in again");
});

test("only definite missing routes imply unsupported snapshot features", () => {
  expect(snapshotActionFailure(new ControlError("Unknown route.", 404, "not_found"), "size")).toContain(
    "does not offer machine size defaults",
  );
  expect(snapshotActionFailure(new ControlError(diagnostic, 404), "size")).not.toContain("does not offer");
  expect(snapshotActionFailure(new ControlError(diagnostic, 504), "build")).toContain("may still finish");
  expect(
    snapshotActionFailure(new ControlError(diagnostic, 400, undefined, { outcomeUnknown: true }), "build"),
  ).toContain("may still finish");
});

test("reported capacity is actionable without inventing a provider limit or echoing its payload", () => {
  const result = snapshotActionFailure(
    new ControlError(`${diagnostic} golden capacity`, 409, "conflict"),
    "build",
    "boat",
  );
  expect(result).toContain("Rebuild an existing snapshot");
  expect(result).not.toContain(diagnostic);
  expect(result).not.toContain("one snapshot");
});
