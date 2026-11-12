import { afterAll, expect, test } from "bun:test";
import type { OttoPage, OttoResource, OttoTask } from "@armada/core";
import type { Sql } from "@armada/core/server";
import { createOttoApi } from "../src/otto/api.ts";
import { createOttoObserver } from "../src/otto/observation.ts";
import { database } from "./support.ts";

const fixture = database();
afterAll(async () => (await fixture).db.close());
test("API scopes membership and private workers; incomplete listings never retire known PRs", async () => {
  const { db, people } = await fixture;
  const sql: Sql = { query: (q, p) => db.query(q, p) };
  const scope = { orgId: people.org, repository: "example/web" };
  const observer = createOttoObserver(sql, scope);
  await observer.fact("pr:17", "pr.open", "true", "github.reconcile", "initial", "partial", {
    number: 17,
    title: "Known PR",
    head: { repo: "example/web", ref: "codex/17-feature", sha: "a".repeat(40) },
  });
  await observer.fact("repository", "repository.open_prs", "unknown", "github.reconcile", "partial", "partial", {
    numbers: [],
  });
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,visibility,access_owner_id,resource_project)
 select $1,id,org_id,owner_id,'otto-private','codex','running','private',owner_id,$3::jsonb from goldens where owner_id=$2 and visibility='private' limit 1`,
    [
      crypto.randomUUID(),
      people.owner,
      JSON.stringify({ version: 1, url: "https://github.com/example/web.git", branch: "codex/17-feature", dir: "web" }),
    ],
  );
  const api = createOttoApi(sql, scope, async () => ({
    ok: true,
    caller: { userId: people.member, orgs: [{ orgId: people.org, role: "member" }], via: "service" },
  }));
  const get = async (view: string, org = people.org) => {
    const response = await api(new Request(`https://armada.example/api/v1/otto/${view}?org_id=${org}`));
    if (!response) throw Error("route_missing");
    return response;
  };
  expect((await get("resources", people.otherOrg)).status).toBe(404);
  const resources = (await (await get("resources")).json()) as OttoPage<OttoResource>;
  expect(resources.completeness).toBe("unknown");
  expect(resources.items).toHaveLength(1);
  expect(resources.items[0]?.externalId).toBe("17");
  expect(resources.items[0]?.owner.state).toBe("unknown");
  const summary = (await (await get("summary")).json()) as OttoPage<{
    openPrCount: number | null;
    orphanCount: number | null;
  }>;
  expect(summary.items[0]?.openPrCount).toBeNull();
  expect(summary.items[0]?.orphanCount).toBeNull();
  const tasks = (await (await get("tasks")).json()) as OttoPage<OttoTask>;
  expect(tasks.items[0]).toMatchObject({ issueNumber: 17, state: "unknown" });
  const noAuth = createOttoApi(sql, scope, async () => ({ ok: false }));
  expect((await noAuth(new Request(`https://armada.example/api/v1/otto/facts?org_id=${people.org}`)))?.status).toBe(
    401,
  );
});
