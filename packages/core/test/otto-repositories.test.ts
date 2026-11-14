import { expect, test } from "bun:test";
import type { Sql } from "../src/server.ts";
import { canonicalOttoRepository, isOttoUuid, ottoRepositoryScopes, resolveOttoRepositories } from "../src/server.ts";

const orgId = "11111111-1111-4111-8111-111111111111";

test("Otto resolves the same repository identity from snapshot URLs and observation configuration", () => {
  const scopes = ottoRepositoryScopes({
    ARMADA_OTTO_ORG_ID: orgId,
    ARMADA_OTTO_REPOSITORIES: "The-Vibe-Company/Armada, owner/other",
  });
  expect(scopes.map((scope) => scope.repository)).toEqual(["The-Vibe-Company/Armada", "owner/other"]);
  for (const value of [
    "https://github.com/The-Vibe-Company/Armada.git",
    "git@github.com:The-Vibe-Company/Armada.git",
    "The-Vibe-Company/Armada",
  ])
    expect(canonicalOttoRepository(value)).toBe(canonicalOttoRepository(scopes[0]!.repository));
  expect(canonicalOttoRepository("https://other.test/owner/repo")).toBeNull();
  expect(() =>
    ottoRepositoryScopes({ ARMADA_OTTO_ORG_ID: orgId, ARMADA_OTTO_REPOSITORIES: "Owner/Repo,owner/repo" }),
  ).toThrow();
  expect(isOttoUuid("------------------------------------")).toBe(false);
});

test("connected repository resolution intersects visible snapshot rows with configured observation scope", async () => {
  const sql: Sql = {
    query: async <T>() => ({
      rows: [
        {
          config: {
            repos: [
              { url: "https://github.com/Owner/Repo.git" },
              { url: "git@github.com:Owner/Repo.git" },
              { url: "https://github.com/Owner/Other" },
            ],
          },
        },
        { config: {} },
      ] as T[],
    }),
  };
  const caller = { userId: "owner", orgs: [{ orgId }] };
  expect(await resolveOttoRepositories(sql, caller, orgId)).toEqual(["owner/other", "owner/repo"]);
  expect(await resolveOttoRepositories(sql, caller, orgId, [{ orgId, repository: "owner/repo" }])).toEqual([
    "owner/repo",
  ]);
  expect(await resolveOttoRepositories(sql, caller, orgId, [])).toEqual([]);
  expect(
    await resolveOttoRepositories(
      {
        query: async () => {
          throw Error("must not query");
        },
      },
      { ...caller, orgs: [] },
      orgId,
    ),
  ).toEqual([]);
});
