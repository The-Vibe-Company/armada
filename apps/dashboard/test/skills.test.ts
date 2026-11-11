import { expect, test } from "bun:test";
import { installedSkills, parseSkillCatalogPage, parseSkillVersions, skillPinProblem } from "../src/lib/skills.ts";

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

const catalogItem = {
  reference: "review-code",
  name: "Code review",
  description: "Review correctness and security",
  visibility: "private",
  versions: ["2.1.0"],
};

test("runtime catalog pages retain only safe metadata and exact source-matched pins", () => {
  const metadata = {
    ...catalogItem,
    body: "hidden body",
    creatorId: "hidden identity",
    versions: ["2.1.0", "2.0.0-beta.1"],
  };
  expect(parseSkillCatalogPage({ items: [metadata], nextOffset: 50, token: "hidden" }, "private", 0)).toEqual({
    items: [
      {
        reference: "review-code",
        name: "Code review",
        description: "Review correctness and security",
        visibility: "private",
        versions: ["2.1.0", "2.0.0-beta.1"],
      },
    ],
    nextOffset: 50,
  });
  expect(parseSkillCatalogPage({ items: [], nextOffset: null }, "private", 10_000)).toEqual({
    items: [],
    nextOffset: null,
  });
  expect(
    parseSkillCatalogPage(
      { items: [{ ...catalogItem, reference: "team/testing", visibility: "public" }], nextOffset: null },
      "public",
      0,
    )?.items[0]?.reference,
  ).toBe("team/testing");
});

test.each([
  ["null response", null],
  ["array response", []],
  ["missing items", { nextOffset: null }],
  ["non-array items", { items: {}, nextOffset: null }],
  ["oversized page", { items: Array(51).fill(catalogItem), nextOffset: null }],
  ["missing cursor", { items: [] }],
  ["non-numeric cursor", { items: [], nextOffset: "50" }],
  ["fractional cursor", { items: [], nextOffset: 50.5 }],
  ["non-monotonic cursor", { items: [], nextOffset: 50 }],
  ["unbounded cursor", { items: [], nextOffset: 10_001 }],
  ...[
    null,
    [],
    {},
    { ...catalogItem, name: 4 },
    { ...catalogItem, name: "" },
    { ...catalogItem, name: "x".repeat(257) },
    { ...catalogItem, description: null },
    { ...catalogItem, description: "x".repeat(8193) },
    { ...catalogItem, reference: "team/review-code" },
    { ...catalogItem, reference: "../review-code" },
    { ...catalogItem, reference: "review-code@2.1.0" },
    { ...catalogItem, reference: "armada-tools" },
    { ...catalogItem, visibility: "public" },
    { ...catalogItem, versions: undefined },
    { ...catalogItem, versions: [] },
    { ...catalogItem, versions: [null] },
    { ...catalogItem, versions: ["latest"] },
    { ...catalogItem, versions: ["^2.0.0"] },
  ].map((item, index) => [`malformed item ${index}`, { items: [item], nextOffset: null }]),
])("runtime catalog parser rejects %s without partial data", (_name, value) => {
  expect(parseSkillCatalogPage(value, "private", 50)).toBeNull();
});

test("runtime versions are exact for the requested reference and exclude unrelated metadata", () => {
  expect(
    parseSkillVersions({ versions: ["2.1.0", "2.0.0-beta.1", "2.1.0"], token: "hidden" }, "private", "review-code"),
  ).toEqual(["2.1.0", "2.0.0-beta.1"]);
  expect(parseSkillVersions({ versions: [] }, "public", "team/testing")).toEqual([]);
  for (const value of [
    null,
    [],
    {},
    { versions: "2.1.0" },
    { versions: ["latest"] },
    { versions: ["^2.0.0"] },
    { versions: [2] },
    { versions: ["2.1.0", null] },
  ]) {
    expect(parseSkillVersions(value, "private", "review-code")).toBeNull();
  }
  expect(parseSkillVersions({ versions: ["2.1.0"] }, "public", "review-code")).toBeNull();
  expect(parseSkillVersions({ versions: ["2.1.0"] }, "private", "team/review-code")).toBeNull();
  expect(parseSkillVersions({ versions: ["2.1.0"] }, "private", "armada-tools")).toBeNull();
});
