import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";

// This contract must never silently skip in release validation.
if (!process.env.ARMADA_TEST_POSTGRES_URL) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

import { expect, spyOn, test } from "bun:test";
import { encryptSecret } from "@armada/core/server";
import { SQL } from "bun";
import { retainedSandbox, sandbox } from "../../provider-boat/test/support.ts";
import { createSqlData } from "../src/data.ts";
import { createJobsRunner } from "../src/jobs/runner.ts";
import { createStopJob } from "../src/jobs/stop.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { RuntimeCheckpointRejected } from "../src/runtime-checkpoint.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { sqlOver } from "../src/sql.ts";
import { callSharedTool } from "../src/tool-api.ts";

// CI provides a migrated THROWAWAY PostgreSQL database. Never use a production URL.
// The actual Bun int8 decoder is essential here: PGlite returns a number and hid #571.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
const key = Buffer.alloc(32, 7).toString("base64");
test("real Bun.SQL bigint reads complete runtime send and shared stop", async () => {
  const client = new SQL(url!, { max: 1 });
  const fetchStub = spyOn(globalThis, "fetch");
  try {
    await client.begin(async (tx) => {
      const sql = sqlOver({
        unsafe: (text, params) => tx.unsafe(text, params),
        begin: (work) =>
          tx.savepoint((savepoint) => work({ unsafe: (text, params) => savepoint.unsafe(text, params) })),
      });
      const owner = crypto.randomUUID(),
        org = crypto.randomUUID(),
        golden = crypto.randomUUID(),
        id = crypto.randomUUID();
      await sql.query("insert into auth.users(id) values($1)", [owner]);
      await sql.query("insert into orgs(id,name,boat_api_key_enc) values($1,'lifecycle-driver',$2)", [
        org,
        await encryptSecret("fixture", key),
      ]);
      await sql.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
      await sql.query(
        `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,config)
        values($1::uuid,$2::uuid,$3::uuid,$1::text,'org','boat',$1::text,'{}'::jsonb)`,
        [golden, org, owner],
      );
      const caller = { via: "service" as const, userId: owner, orgs: [{ orgId: org, role: "admin" as const }] };
      const data = createSqlData(sql)(caller);
      const {
        rows: [account],
      } = await sql.query<{ id: string; version: number }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2) returning id,version",
        [owner, await encryptSecret("fixture", key)],
      );
      if (!account) throw Error("Missing fixture account");
      await insertSandboxFixture(sql, {
        id,
        provider: "boat",
        providerSandboxId: "bx_23456789",
        goldenId: golden,
        orgId: org,
        ownerId: owner,
        harness: "codex",
        status: "ready",
        model: "gpt-5.4",
        boatRuntime: true,
        credentialId: account.id,
        credentialVersion: account.version,
        reasoningEffort: "high",
      });
      // Start at the exact production failure value, not just the insert default.
      await sql.query("update sandboxes set lifecycle_generation=2 where id=$1", [id]);
      const raw = await tx.unsafe("select lifecycle_generation from sandboxes where id=$1", [id]);
      expect(typeof raw[0].lifecycle_generation).toBe("string");
      expect(raw[0].lifecycle_generation).toBe("2");
      const authority = createRuntimeEnrolments(sql, key);
      const ticket = await authority.issue({ sandboxId: id, ownerId: owner, configuration: {} });
      const { epoch, runtimeToken } = await authority.enrol(ticket.enrolmentToken);
      const requestId = crypto.randomUUID();
      const promptId = crypto.randomUUID();
      const conversationId = `first_${requestId}`;
      let prompts = 0;
      // The runtime polls and acknowledges over SQL in the same turn, without waiting on a timer.
      const commands = createRuntimeCommands(authority, key, {
        now: () => 0,
        async wait() {
          const { command } = await commands.next(runtimeToken, epoch);
          if (command?.op !== "prompt") throw Error("Expected a durable runtime prompt");
          expect(command.requestId).toBe(`follow_${requestId}`);
          expect(command.input).toMatchObject({ sandboxId: id, text: "continue", conversationId });
          prompts++;
          await commands.complete(runtimeToken, epoch, {
            epoch,
            requestId: command.requestId,
            status: 200,
            body: {
              version: 1,
              requestId: command.requestId,
              result: { promptId, conversationId, status: "queued" },
            },
          });
        },
      });
      const labels = { armada: "sandbox", sandbox: id, org, owner };
      let stopped = false;
      const requests: string[] = [];
      const unexpectedRequests: string[] = [];
      const fetchBoat = async (...[input, init]: Parameters<typeof fetch>) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const path = new URL(request.url).pathname;
        const operation = `${request.method} ${path}`;
        requests.push(operation);
        if (request.method === "GET" && path.endsWith("/me"))
          return Response.json({ ok: true, user: { id: "fixture" } });
        if (request.method === "POST" && path.endsWith("/sandboxes/bx_23456789/stop")) {
          stopped = true;
          return Response.json({ ok: true });
        }
        if (request.method === "GET" && path.endsWith("/sandboxes/bx_23456789"))
          return Response.json({
            ok: true,
            sandbox: stopped ? retainedSandbox({ labels }) : sandbox({ state: "idle", labels }),
          });
        if (request.method === "POST" && path.endsWith("/sandboxes/bx_23456789/commands"))
          return Response.json({
            ok: true,
            type: "command.finished",
            success: true,
            exitCode: 0,
            stdout: "[]",
            stderr: "",
            timedOut: false,
          });
        unexpectedRequests.push(operation);
        throw Error(`Unexpected fixture request: ${operation}`);
      };
      // oxlint-disable-next-line landmines-testing/no-test-doubles -- Intercept only Boat HTTP for the actual worker and SDK. Release contracts run offline.
      fetchStub.mockImplementation(Object.assign(fetchBoat, { preconnect: fetch.preconnect }));
      let checkpoints = 0;
      const context = {
        caller,
        data,
        async provider() {
          throw Error("Shared admission must not resolve a provider");
        },
        runtimeSend: createRuntimeFollowup(sql, key, commands),
        // Guest checkpointing is outside this contract. Exercise compute stop after checkpoint refusal.
        runtimeStopCheckpoint: async () => {
          checkpoints++;
          throw new RuntimeCheckpointRejected();
        },
        launchCredentials: {
          resolve: async () => {
            throw Error("not a launch");
          },
        },
        exposedSecrets: async () => [],
        now: () => new Date(),
        sleep: async () => {
          throw Error("Unexpected fixture sleep");
        },
      };
      expect((await data.sandboxes.get(id))?.lifecycleGeneration).toBe(2);
      expect(await callSharedTool(context, "send", { id, prompt: "continue", request_id: requestId })).toMatchObject({
        id,
        requestId,
        runtime: { kind: "armada", epoch },
        promptId,
        conversationId,
        status: "queued",
      });
      expect(await data.sandboxes.get(id)).toMatchObject({
        lifecycleGeneration: 2,
        taskPromptId: promptId,
        conversationIds: [conversationId],
      });
      expect(prompts).toBe(1);
      expect(requests).toEqual([]);

      // Admission advances the fence once. Shared settlement preserves that generation.
      const maxGeneration = String(Number.MAX_SAFE_INTEGER);
      await sql.query("update sandboxes set lifecycle_generation=$2 where id=$1", [id, maxGeneration]);
      await expect(callSharedTool(context, "stop", { id })).rejects.toMatchObject({
        code: "internal",
        cause: { message: "Sandbox lifecycle generation cannot be advanced safely." },
      });
      expect(
        (
          await tx.unsafe(
            "select status,lifecycle_generation,activity_lease_id,stop_requested_at from sandboxes where id=$1",
            [id],
          )
        )[0],
      ).toMatchObject({
        status: "ready",
        lifecycle_generation: maxGeneration,
        activity_lease_id: null,
        stop_requested_at: null,
      });
      expect((await sql.query("select id from jobs where sandbox_id=$1 and kind='stop'", [id])).rows).toEqual([]);
      expect(checkpoints).toBe(0);
      expect(requests).toEqual([]);

      await sql.query("update sandboxes set lifecycle_generation=$2 where id=$1", [
        id,
        String(Number.MAX_SAFE_INTEGER - 1),
      ]);
      expect(await callSharedTool(context, "stop", { id })).toMatchObject({ id, status: "stopping" });
      expect(
        (await tx.unsafe("select state,generation from jobs where sandbox_id=$1 and kind='stop'", [id]))[0],
      ).toMatchObject({ state: "queued", generation: maxGeneration });
      expect(requests).toEqual([]);

      const runner = createJobsRunner(createJobsStore(sql, key), { stop: createStopJob(sql, key) });
      expect(await runner.reconcileOne(new AbortController().signal)).toBe(true);
      await runner.drain();

      const ended = (
        await tx.unsafe(
          "select status,lifecycle_generation,stopped_at,activity_lease_id,activity_until from sandboxes where id=$1",
          [id],
        )
      )[0];
      expect(ended).toMatchObject({
        status: "stopped",
        lifecycle_generation: maxGeneration,
        activity_lease_id: null,
        activity_until: null,
      });
      expect(ended.stopped_at).toBeInstanceOf(Date);
      expect(
        (await tx.unsafe("select state,generation from jobs where sandbox_id=$1 and kind='stop'", [id]))[0],
      ).toMatchObject({ state: "done", generation: maxGeneration });
      expect(requests.filter((request) => request.endsWith("/stop"))).toHaveLength(1);
      expect(unexpectedRequests).toEqual([]);
      // Roll back fixtures, including the org's last admin (whose normal deletion is guarded).
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    fetchStub.mockRestore();
    await client.close();
  }
});
const rollback = new Error("rollback isolated lifecycle driver fixture");
