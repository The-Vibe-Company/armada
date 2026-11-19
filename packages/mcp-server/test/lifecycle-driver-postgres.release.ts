// This contract must never silently skip in release validation.
if (!process.env.ARMADA_TEST_POSTGRES_URL) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

import { expect, test } from "bun:test";
import { createBoatProvider } from "@armada/provider-boat";
import { SQL } from "bun";
import { retainedSandbox, sandbox } from "../../provider-boat/test/support.ts";
import { createSqlData } from "../src/data.ts";
import { sqlOver } from "../src/sql.ts";
import { callSharedTool } from "../src/tool-api.ts";

// CI provides a migrated THROWAWAY PostgreSQL database. Never use a production URL.
// The actual Bun int8 decoder is essential here: PGlite returns a number and hid #571.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test("real Bun.SQL bigint reads complete shared send and stop through the Boat SDK", async () => {
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
          return Response.json({ ok: true, sandbox: stopped ? retainedSandbox() : sandbox({ state: "idle" }) });
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
      // Exercise counter exhaustion on a controllable row: a stopped row must refuse
      // at terminal-state preflight before reaching the generation guard.
      // Counter exhaustion must fail before admission/provider mutation, not round a CAS.
      await sql.query("update sandboxes set status='ready',stopped_at=null,lifecycle_generation=$2 where id=$1", [
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
