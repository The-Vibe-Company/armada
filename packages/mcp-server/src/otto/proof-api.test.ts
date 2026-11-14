import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import { createOttoProofApi } from "./proof-api.ts";

test("proof reads require exact organization, repository and membership before journal access", async () => {
  let reads = 0;
  const sql = {
    query: async () => {
      reads++;
      return { rows: [] };
    },
  } as unknown as Sql;
  const scope = { orgId: "org_one", repository: "owner/repo" };
  const url = "https://armada.test/api/v1/otto/evidence?org_id=org_one&repository=owner/repo&number=12";
  const member = { ok: true, caller: { orgs: [{ orgId: "org_one" }] } } as unknown as CallerResult;
  const route = createOttoProofApi(
    sql,
    [scope, { orgId: "org_one", repository: "owner/skills" }],
    async () => member,
    undefined,
    async () => true,
  );
  expect((await route(new Request(url.replace("owner/repo", "other/repo"))))?.status).toBe(404);
  expect((await route(new Request(url.replace("org_one", "org_two"))))?.status).toBe(404);
  expect(
    (
      await createOttoProofApi(
        sql,
        scope,
        async () => ({ ok: true, caller: { orgs: [] } }) as unknown as CallerResult,
      )(new Request(url))
    )?.status,
  ).toBe(404);
  expect(
    (
      await createOttoProofApi(
        sql,
        scope,
        async () => member,
        undefined,
        async () => false,
      )(new Request(url))
    )?.status,
  ).toBe(404);
  expect(reads).toBe(0);
  const response = await route(new Request(url));
  expect(response?.status).toBe(200);
  expect(((await response!.json()) as { requiredChecks: string }).requiredChecks).toBe("unknown");
  expect(reads).toBe(1);
  expect((await route(new Request(url.replace("owner/repo", "owner/skills"))))?.status).toBe(200);
  expect(reads).toBe(2);
});
