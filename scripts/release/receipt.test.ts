import { expect, test } from "bun:test";
import { migrationChanges, protocolChange, surfaceBreaks } from "./receipt";

test("migration receipt includes SQL applied in this attempt and by a prior attempt", () => {
  const baseline = "20261117090000";
  const alreadyApplied = "20261118090000";
  const newlyApplied = "20261119090000";
  expect(
    migrationChanges(
      [baseline],
      [baseline, alreadyApplied],
      [baseline, alreadyApplied, newlyApplied],
      [`supabase/migrations/${alreadyApplied}_add.sql`],
    ),
  ).toEqual([alreadyApplied, newlyApplied]);
});

test.each([
  ["PROTOCOL_VERSION", 1, 2, 1],
  ["DOCKER_HOST_PROTOCOL", 2, 2, 2],
  ["DOCKER_HOST_PROTOCOL", null, 1, null],
] as const)("%s records the two tag values (%s to %s)", (name, previous, current, expectedFrom) => {
  expect(
    protocolChange(
      previous === null ? "" : `export const ${name} = ${previous};`,
      `export const ${name} = ${current};`,
      name,
    ),
  ).toEqual({ from: expectedFrom, to: current });
});

test("surface evidence records breaking commits and removed operations and fields", () => {
  const previous = {
    paths: {
      "/items": {
        get: { responses: { "200": { content: { json: { schema: { properties: { id: {}, title: {} } } } } } } },
        delete: {},
      },
    },
  };
  const current = {
    paths: {
      "/items": {
        get: { responses: { "200": { content: { json: { schema: { properties: { id: {}, state: {} } } } } } } },
      },
    },
  };
  expect(
    surfaceBreaks(previous, current, [
      "feat(api)!: retire a route",
      "chore: publish\n\nBREAKING CHANGE: remove an SDK method",
      "fix: correct a typo",
    ]),
  ).toEqual([
    "commit: feat(api)!: retire a route",
    "commit: chore: publish",
    "GET /items/responses/200/content/json/schema/properties/title",
    "DELETE /items",
  ]);
});
