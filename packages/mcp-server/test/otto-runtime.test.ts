import { expect, test } from "bun:test";
import { createOttoRuntime } from "../src/otto/runtime.ts";

test("Otto retains independent explicit repository bindings and rejects ambiguous configuration", () => {
  const sql = {
    async query() {
      throw Error("No I/O at setup");
    },
  };
  const orgId = "00000000-0000-0000-0000-000000000001";
  expect(createOttoRuntime(sql, {})).toBeUndefined();
  expect(createOttoRuntime(sql, { ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORY: "example/web" })?.scopes).toEqual([
    { orgId, repository: "example/web" },
  ]);
  expect(
    createOttoRuntime(sql, { ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORIES: "example/web,example/skills" })
      ?.scopes,
  ).toEqual([
    { orgId, repository: "example/web" },
    { orgId, repository: "example/skills" },
  ]);
  for (const repositories of ["example/web,EXAMPLE/web", "example/web,", "not-a-repository"])
    expect(() =>
      createOttoRuntime(sql, { ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORIES: repositories }),
    ).toThrow();
});
