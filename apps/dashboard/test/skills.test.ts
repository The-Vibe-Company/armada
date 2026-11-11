import { expect, test } from "bun:test";
import { installedSkills, skillPinProblem } from "../src/lib/skills.ts";

test("additional skills require distinct exact pins, exclude Armada tools and cap the selection", () => {
  expect(skillPinProblem(["team/review@1.2.3", "testing@2.0.0-beta.1"])).toBeNull();
  expect(skillPinProblem([])).toBeNull();
  for (const pin of [
    "review",
    "review@latest",
    "review@^1.0.0",
    "team/review@1",
    "../review@1.0.0",
    `${"a".repeat(251)}@1.0.0`,
  ]) {
    expect(skillPinProblem([pin])).not.toBeNull();
  }
  for (const pins of [
    ["armada-tools@1.0.0"],
    ["team/armada-tools@1.0.0"],
    ["review@1.0.0", "team/review@2.0.0"],
    ["review@1.0.0", "review@2.0.0"],
    Array.from({ length: 21 }, (_, index) => `skill-${index}@1.0.0`),
  ])
    expect(skillPinProblem(pins)).not.toBeNull();
});

test("installed receipt projection uses recorded pins, not internal identity or invented catalog metadata", () => {
  const checksum = `sha256:${"a".repeat(64)}`;
  expect(
    installedSkills([
      {
        reference: "team/testing@1.2.3",
        version: "1.2.3",
        checksum,
        origin: "https://skillpack.app/v1",
        skillId: "hidden-id",
        workspaceId: "hidden-workspace",
        name: "Not a recorded display name",
      },
      {
        reference: "review@2.0.0",
        version: "2.0.0",
        workspaceId: "hidden-workspace",
        checksum: "unverified",
        origin: "https://example.test/?token=hidden",
      },
    ]),
  ).toEqual([
    { reference: "team/testing", version: "1.2.3", visibility: "public", checksum, origin: "https://skillpack.app/v1" },
    { reference: "review", version: "2.0.0", visibility: "private", checksum: null, origin: null },
  ]);
});

test("malformed, mismatched and duplicate stored receipts cannot break the details or claim another version", () => {
  for (const value of [null, {}, "[]"]) expect(installedSkills(value)).toEqual([]);
  expect(
    installedSkills([
      null,
      [],
      {},
      { reference: "review@latest", version: "latest" },
      { reference: "review@1.0.0", version: "2.0.0" },
      { reference: "team/testing@1.2.3", version: "1.2.3" },
      { reference: "team/testing@1.2.3", version: "1.2.3" },
    ]),
  ).toEqual([{ reference: "team/testing", version: "1.2.3", visibility: "public", checksum: null, origin: null }]);
});
