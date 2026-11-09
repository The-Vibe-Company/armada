import { expect, test } from "bun:test";
import { mapSandboxRow, type SandboxRow } from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { SQL } from "bun";
import { sandbox } from "../../provider-boat/test/support.ts";
import { createSqlData } from "../src/data.ts";
import { sqlOver } from "../src/sql.ts";
import { callSharedTool } from "../src/tool-api.ts";

const fixture: SandboxRow = {
  id: "row",
  provider: "boat",
  provider_sandbox_id: "bx_driver",
  golden_id: "golden",
  org_id: "org",
  owner_id: "owner",
  harness: "claude",
  status: "ready",
  conversation_ids: [],
  created_at: "2026-11-09T00:00:00Z",
  stopped_at: null,
  deleted_at: null,
  status_reason: null,
  model: null,
  reasoning_effort: null,
  repository_dir: null,
  expires_at: "2026-11-10T00:00:00Z",
};
test("SQL row decoding normalizes exact safe lifecycle integers and refuses invalid/lossy values", () => {
  for (const value of [
    1,
    "2",
    3n,
    Number.MAX_SAFE_INTEGER,
    String(Number.MAX_SAFE_INTEGER),
    BigInt(Number.MAX_SAFE_INTEGER),
  ]) {
    const row = mapSandboxRow({ ...fixture, lifecycle_generation: value });
    expect(typeof row.lifecycleGeneration).toBe("number");
    expect(row.lifecycleGeneration).toBe(Number(value));
  }
  for (const value of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    " 2",
    "2.0",
    "2e1",
    "+2",
    "02",
    "0",
    "-1",
    "9007199254740993",
    9007199254740993n,
    null,
    true,
  ])
    expect(() => mapSandboxRow({ ...fixture, lifecycle_generation: value } as SandboxRow)).toThrow(
      "lifecycle generation",
    );
  expect(mapSandboxRow(fixture).lifecycleGeneration).toBe(1);
});

// CI provides a migrated THROWAWAY PostgreSQL database. Never use a production URL.
// The actual Bun int8 decoder is essential here: PGlite returns a number and hid #571.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!url)("real Bun.SQL bigint reads complete shared send and stop through the Boat SDK", async () => {
  const client = new SQL(url!, { max: 1 });
  try {
    await client.begin(async (tx) => {
      const sql = sqlOver({ unsafe: (text, params) => tx.unsafe(text, params) });
      const owner = crypto.randomUUID(),
        org = crypto.randomUUID(),
        golden = crypto.randomUUID(),
        id = crypto.randomUUID();
      await sql.query("insert into auth.users(id) values($1)", [owner]);
      await sql.query("insert into orgs(id,name) values($1,'lifecycle-driver')", [org]);
      await sql.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
      await sql.query(
        `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,config)
        values($1::uuid,$2::uuid,$3::uuid,$1::text,'org','boat',$1::text,'{}'::jsonb)`,
        [golden, org, owner],
      );
      const caller = { via: "service" as const, userId: owner, orgs: [{ orgId: org, role: "admin" as const }] };
      const data = createSqlData(sql)(caller);
      await data.sandboxes.insert({
        id,
        provider: "boat",
        providerSandboxId: "bx_23456789",
        goldenId: golden,
        orgId: org,
        ownerId: owner,
        harness: "claude",
        status: "ready",
        model: "claude-sonnet-5",
        reasoningEffort: "high",
      });
      // Start at the exact production failure value, not just the insert default.
      await sql.query("update sandboxes set lifecycle_generation=2 where id=$1", [id]);
      const raw = await tx.unsafe("select lifecycle_generation from sandboxes where id=$1", [id]);
      expect(typeof raw[0].lifecycle_generation).toBe("string");
      expect(raw[0].lifecycle_generation).toBe("2");
      let stopped = false;
      const requests: string[] = [];
      const provider = createBoatProvider({
        apiKey: "test-only-key",
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          const path = new URL(request.url).pathname;
          requests.push(`${request.method} ${path}`);
          if (path.endsWith("/prompt"))
            return Response.json({ ok: true, promptId: "p", conversationId: "c", status: "queued" });
          if (path.endsWith("/stop")) {
            stopped = true;
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true, sandbox: sandbox({ state: stopped ? "archived" : "idle" }) });
        }) as typeof fetch,
      });
      const context = {
        caller,
        data,
        provider: async () => provider,
        launchCredentials: {
          resolve: async () => {
            throw Error("not a launch");
          },
        },
        exposedSecrets: async () => [],
        now: () => new Date(),
        sleep: async () => {},
      };
      const before = await data.sandboxes.get(id);
      await callSharedTool(context, "send", { id, prompt: "continue" });
      expect(before?.lifecycleGeneration).toBe(2);
      expect(typeof before?.lifecycleGeneration).toBe("number");
      const running = await data.sandboxes.get(id);
      expect(running?.status).toBe("running");
      expect(running?.lifecycleGeneration).toBe(4);
      expect(typeof running?.lifecycleGeneration).toBe("number");
      expect(running?.conversationIds).toEqual(["c"]);
      await callSharedTool(context, "stop", { id });
      const ended = await data.sandboxes.get(id);
      expect(ended?.status).toBe("stopped");
      expect(ended?.lifecycleGeneration).toBe(6);
      expect(ended?.stoppedAt).not.toBeNull();
      const lease = (await tx.unsafe("select activity_lease_id,activity_until from sandboxes where id=$1", [id]))[0];
      expect(lease.activity_lease_id).toBeNull();
      expect(lease.activity_until).toBeNull();
      expect(requests.filter((r) => r.endsWith("/prompt"))).toHaveLength(1);
      expect(requests.filter((r) => r.endsWith("/stop"))).toHaveLength(1);
      // Counter exhaustion must fail before admission/provider mutation, not round a CAS.
      await sql.query("update sandboxes set lifecycle_generation=$2 where id=$1", [
        id,
        String(Number.MAX_SAFE_INTEGER),
      ]);
      await expect(callSharedTool(context, "send", { id, prompt: "must not queue" })).rejects.toMatchObject({
        code: "internal",
      });
      expect(
        (await tx.unsafe("select lifecycle_generation from sandboxes where id=$1", [id]))[0].lifecycle_generation,
      ).toBe(String(Number.MAX_SAFE_INTEGER));
      expect(requests.filter((r) => r.endsWith("/prompt"))).toHaveLength(1);
      expect(requests.filter((r) => r.endsWith("/stop"))).toHaveLength(1);
      // Roll back fixtures, including the org's last admin (whose normal deletion is guarded).
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await client.close();
  }
});
const rollback = new Error("rollback isolated lifecycle driver fixture");
