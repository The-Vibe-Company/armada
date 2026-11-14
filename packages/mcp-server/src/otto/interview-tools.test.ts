import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import type { Caller } from "../caller.ts";
import { interviewCapability } from "./engine-session.ts";
import { interviewStore } from "./interview.ts";
import { createOttoInterviewRoute, createOttoRepositoryFileReader } from "./interview-tools.ts";

let db: PGlite;
const orgId = "11111111-1111-4111-8111-111111111111",
  ownerId = "22222222-2222-4222-8222-222222222222",
  objectiveId = "33333333-3333-4333-8333-333333333333",
  goldenId = "44444444-4444-4444-8444-444444444444",
  sandboxId = "55555555-5555-4555-8555-555555555555";
const key = Buffer.alloc(32, 3).toString("base64"),
  scope = { orgId, ownerId, objectiveId };
const caller: Caller = { userId: ownerId, orgs: [{ orgId, role: "admin" }], via: "supabase" };
const sql: Sql = { query: (text, params) => db.query(text, params) };
const reader = { credentials: async () => [], orgBoatKey: async () => null };
beforeAll(async () => {
  db = await openMigratedDatabase();
  await db.query("insert into auth.users(id) values($1)", [ownerId]);
  await db.query("insert into public.orgs(id,name) values($1,'Interview API')", [orgId]);
  await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [orgId, ownerId]);
  await db.query(
    "insert into public.otto_objectives(id,org_id,owner_id,repository,request) values($1,$2,$3,'owner/repo','Investigate the code')",
    [objectiveId, orgId, ownerId],
  );
  await db.query(
    "insert into public.goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'Interview fixture','private',$4::jsonb)",
    [
      goldenId,
      orgId,
      ownerId,
      JSON.stringify({ repos: [{ url: "https://github.com/owner/repo", dir: "repo", branch: "main" }], init: [] }),
    ],
  );
  await db.query(
    "insert into public.sandboxes(id,org_id,owner_id,golden_id,provider_sandbox_id,boat_id,harness,status,expires_at) values($1,$2,$3,$4,'fixture_sandbox','fixture_sandbox','codex','ready','2099-01-01')",
    [sandboxId, orgId, ownerId, goldenId],
  );
  await interviewStore(sql, scope).start(
    { harness: "codex", model: "gpt-6.1-sol", credentialId: "account_reference" },
    goldenId,
  );
  await interviewStore(sql, scope).bindSession(sandboxId);
});
afterAll(async () => {
  await db?.close();
});
function request(method = "GET", suffix = "", token?: string, body?: unknown) {
  return new Request(`https://fixture.invalid/api/v1/otto/interviews/${objectiveId}${suffix}?org_id=${orgId}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("interview HTTP separates owner sessions from agent authority and restores PostgreSQL JSON snapshots", async () => {
  for (const via of ["service", "mcp"] as const) {
    const route = createOttoInterviewRoute({
      sql,
      reader,
      key,
      authenticate: async () => ({ ok: true, caller: { ...caller, via } }),
    });
    expect((await route(request()))?.status).toBe(403);
  }
  const route = createOttoInterviewRoute({ sql, reader, key, authenticate: async () => ({ ok: true, caller }) });
  const response = await route(request());
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    interview: { revision: 2, sandboxId, engine: { harness: "codex" } },
    effects: [],
  });
  const denied = createOttoInterviewRoute({
    sql,
    reader,
    key,
    authenticate: async () => ({ ok: true, caller: { ...caller, userId: goldenId } }),
  });
  expect((await denied(request()))?.status).toBe(404);
});

test("bound MCP capability publishes sourced rounds but cannot invoke worker or general server tools", async () => {
  const route = createOttoInterviewRoute({ sql, reader, key, authenticate: async () => ({ ok: false }) });
  const token = interviewCapability(key, scope, sandboxId);
  const rpc = (name: string, args: unknown) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect((await route(request("POST", "/tools", "not_a_capability", rpc("read_interview", {}))))?.status).toBe(403);
  expect((await route(request("POST", "/tools", token, rpc("launch", {}))))?.status).toBe(400);
  const response = await route(
    request(
      "POST",
      "/tools",
      token,
      rpc("publish_round", {
        revision: 2,
        round: {
          decisions: [
            {
              id: "scope",
              question: "Which scope?",
              recommendation: "Web",
              answer: null,
              source: null,
              reversible: true,
              dependsOn: [],
            },
          ],
          assumptions: [],
          frontier: ["scope"],
        },
      }),
    ),
  );
  expect(response?.status).toBe(200);
  const json = (await response?.json()) as { result: { isError?: boolean } };
  expect(json.result.isError).not.toBe(true);
  expect((await interviewStore(sql, scope).read())?.round?.frontier).toEqual(["scope"]);
  await db.query("update public.sandboxes set status='stopped',stopped_at=now() where id=$1", [sandboxId]);
  expect((await route(request("POST", "/tools", token, rpc("read_interview", {}))))?.status).toBe(403);
});

test("repository facts use GitHub content envelopes while server authorization never crosses the tool response", async () => {
  const received: string[] = [];
  const read = createOttoRepositoryFileReader(
    async () => ({
      status: "connected",
      token: "fixture_server_only",
      identity: { login: "fixture_owner", id: 1, name: "Fixture Owner", email: "fixture@example.invalid" },
    }),
    async (_url, init) => {
      received.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({
        type: "file",
        encoding: "base64",
        size: 5,
        name: "README.md",
        path: "README.md",
        sha: "blob_reference",
        content: Buffer.from("Facts").toString("base64"),
        html_url: "https://github.com/owner/repo/blob/main/README.md",
      });
    },
  );
  const result = await read(caller, "owner/repo", "README.md");
  expect(received).toEqual(["Bearer fixture_server_only"]);
  expect(result).toEqual({ text: "Facts", source: "https://github.com/owner/repo/blob/main/README.md" });
  expect(JSON.stringify(result)).not.toContain("fixture_server_only");
});
