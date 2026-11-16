import { expect, test } from "bun:test";
import { type ReleaseReservation, shouldDeferStaging } from "./staging-admission.ts";

const repository = "example/armada";
const reservation = (status: string): ReleaseReservation => ({
  status,
  path: ".github/workflows/release.yml",
  head_repository: { full_name: repository },
});

test("ordinary staging yields to every unfinished release and resumes after any terminal result", () => {
  for (const status of ["queued", "pending", "requested", "waiting", "in_progress"]) {
    expect(shouldDeferStaging([reservation("completed"), reservation(status)], repository)).toBe(true);
  }
  expect(shouldDeferStaging([reservation("completed")], repository)).toBe(false);
  expect(shouldDeferStaging([], repository)).toBe(false);
});

test("only this repository's Release workflow can reserve staging", () => {
  expect(
    shouldDeferStaging(
      [
        { ...reservation("in_progress"), path: ".github/workflows/ci.yml" },
        { ...reservation("queued"), head_repository: { full_name: "other/repository" } },
        { ...reservation("queued"), head_repository: null },
      ],
      repository,
    ),
  ).toBe(false);
});
