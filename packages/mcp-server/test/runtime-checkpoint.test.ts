import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import type { Sql } from "@armada/core/server";
import { createSqlSandboxStore, createSqlVaultStore, DelegatedAuthority } from "@armada/core/server";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeHistory } from "../src/runtime-history.ts";
import { createRuntimeProvider, type RuntimeWorkProvider } from "../src/runtime-provider.ts";
import { createSandboxArmadaAccess } from "../src/sandbox-armada-access.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { runtimeFixture, runtimeFixtureGolden } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY, fakeBoat, PUBLIC_URL, seedDatabase } from "./support.ts";

let shared: (Awaited<ReturnType<typeof seedDatabase>> & { modalGoldenId: string }) | undefined;

beforeAll(async () => {
  const db = await openMigratedDatabase();
  try {
    const seeded = await seedDatabase(db);
    shared = { ...seeded, modalGoldenId: await runtimeFixtureGolden(db, seeded.people, "modal") };
  } catch (error) {
    await db.close();
    throw error;
  }
});
afterAll(async () => {
  const db = shared?.db;
  shared = undefined;
  await db?.close();
});

function checkpointFixture(provider: "boat" | "modal" = "boat", idle = false) {
  if (!shared) throw Error("Checkpoint database is not open");
  return runtimeFixture(shared, provider, "codex", idle, undefined, {
    goldenId: provider === "modal" ? shared.modalGoldenId : shared.sharedGoldenId,
    providerSandboxId: crypto.randomUUID(),
  });
}

async function enrolledCheckpointTarget() {
  if (!shared) throw Error("Checkpoint database is not open");
  const { db, people, modalGoldenId } = shared;
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const account = (
    await db.query<{ id: string; version: number }>(
      "select id,version from credentials where kind='openai' and owner_id=$1",
      [people.org],
    )
  ).rows[0]!;
  const row = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "modal",
    providerSandboxId: crypto.randomUUID(),
    goldenId: modalGoldenId,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "ready",
    visibility: "private",
    model: "gpt-5.4",
    reasoningEffort: "high",
    runtimeTransport: "dialout",
    credentialId: account.id,
    credentialVersion: account.version,
  });
  const enrolments = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const issue = () => enrolments.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} });
  const active = await enrolments.enrol((await issue()).enrolmentToken);
  return {
    db,
    people,
    sql,
    account,
    row,
    enrolments,
    issue,
    active,
    caller: { userId: people.owner, orgs: [{ orgId: people.org, role: "member" as const }], via: "service" as const },
  };
}

test.each(["acknowledged", "refused", "reply lost", "epoch replaced"])(
  "enrolled scoped grant admission after delivery: %s",
  async (outcome) => {
    const {
      db,
      people,
      sql,
      account,
      row,
      issue,
      active: { epoch },
    } = await enrolledCheckpointTarget();
    const authority = new DelegatedAuthority(sql, async () => {});
    let token = "";
    const admit = () =>
      authority.admit(
        token,
        {
          method: "launch",
          goldenId: row.goldenId,
          harness: "codex",
          credentialId: account.id,
          credentialVersion: account.version,
        },
        async (_tx, principal) => principal.ownerId,
      );
    const dispatched: string[] = [];
    let admittedBeforeAcknowledgement: boolean | undefined;
    const access = createSandboxArmadaAccess({
      sql,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: PUBLIC_URL,
      commands: {
        async call(_owner, command) {
          dispatched.push(command.op);
          const installing = command.op === "installOrchestratorEpoch";
          if (installing) {
            token = command.token;
            admittedBeforeAcknowledgement = await admit().then(
              () => true,
              () => false,
            );
            if (outcome === "reply lost") throw Error("Guest reply lost before completion");
            if (outcome === "epoch replaced") await issue();
          }
          const acknowledged = !installing || outcome !== "refused";
          return {
            status: acknowledged ? 200 : 503,
            epoch,
            requestId: command.requestId,
            body: { version: 1, requestId: command.requestId, result: { acknowledged } },
          };
        },
      },
    });
    const nativeUnavailable = async () => {
      throw Error("Scoped preparation must use the enrolled runtime");
    };
    const prepare = access.prepare(
      { ...fakeBoat().provider, id: "modal", exec: nativeUnavailable, installOrchestratorEpoch: nativeUnavailable },
      row,
      { userId: people.owner, orgId: people.org, role: "member" },
      { maxActiveChildren: 1 },
    );
    if (outcome === "acknowledged") {
      await prepare;
      await expect(admit()).resolves.toBe(people.owner);
      expect(dispatched).toEqual(["installOrchestratorEpoch"]);
      expect(
        (await db.query("select max_active_children from orchestrator_lifecycle where orchestrator_id=$1", [row.id]))
          .rows,
      ).toEqual([{ max_active_children: 1 }]);
    } else {
      await expect(prepare).rejects.toThrow("denied");
      await expect(admit()).rejects.toThrow("denied");
      expect(dispatched).toEqual(["installOrchestratorEpoch", "scrubOrchestratorEpoch"]);
    }
    expect(admittedBeforeAcknowledgement).toBe(false);
  },
);

function stopPort(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  let stopped = false,
    calls = 0;
  const physicalId = f.row.providerSandboxId!;
  const host = {
    id: f.row.provider,
    async get() {
      return stopped
        ? { id: physicalId, state: "stopped", stoppedAt: new Date(), retainedSnapshot: "usable" }
        : { id: physicalId, state: "running", physicalGeneration: "2" };
    },
    async captureRuntimeWork() {
      return { status: "clean" };
    },
    async stop() {
      calls++;
      stopped = true;
    },
  } as unknown as RuntimeWorkProvider;
  return {
    context: {
      ...f.context,
      runtimeStopCheckpoint: createRuntimeStopCheckpoint(
        f.sql,
        createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge),
      ),
      provider: async () =>
        createRuntimeProvider(host, physicalId, {
          events: ({ sandboxId: _, ...page }) => createRuntimeHistory(f.sql, ENCRYPTION_KEY)(f.caller, f.row.id, page),
          async getPrompt() {
            throw Error("No native/live prompt reads during compute stop");
          },
        }),
    },
    calls: () => calls,
  };
}
const args = (id: string) => ({ id, request_id: crypto.randomUUID(), runtimeVersion: 1 as const });

test("a definite runtime checkpoint refusal still allows compute cleanup", async () => {
  const f = await checkpointFixture("modal");
  try {
    f.github(async () => {
      throw Error("checkpoint runtime teardown refused");
    });
    const stop = stopPort(f);
    await expect(callSharedTool(stop.context, "stop", { id: f.row.id })).resolves.toMatchObject({
      status: "stopped",
      preservationNote: "Runtime checkpoint was refused. No resumable checkpoint was recorded.",
    });
    expect(stop.calls()).toBe(1);
    expect(
      (await f.db.query("select watermark from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows,
    ).toEqual([{ watermark: null }]);
  } finally {
    await f.close();
  }
});

test("an unreadable runtime checkpoint acknowledgement never allows compute cleanup", async () => {
  const f = await checkpointFixture("modal");
  try {
    f.github(async () => {
      throw Error("runtime_result_unavailable");
    });
    const stop = stopPort(f);
    await expect(callSharedTool(stop.context, "stop", { id: f.row.id })).rejects.toMatchObject({ code: "conflict" });
    expect(stop.calls()).toBe(0);
    expect((await f.context.data.sandboxes.get(f.row.id))?.status).toBe("running");
  } finally {
    await f.close();
  }
});

test("idle-only stop refuses a queued turn before creating a checkpoint", async () => {
  const f = await checkpointFixture("modal", true);
  try {
    const queue = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
    const request = f.input();
    expect(await queue.accept(f.caller, request)).toMatchObject({ status: "queued" });
    const sandbox = (await f.context.data.sandboxes.get(f.row.id))!;
    await expect(stopPort(f).context.runtimeStopCheckpoint(f.caller, sandbox, true)).rejects.toThrow("work is pending");
    expect((await f.db.query("select 1 from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows).toHaveLength(
      0,
    );
    expect(await queue.status(f.caller, request.id, request.request_id)).toMatchObject({ failed: false });
  } finally {
    await f.close();
  }
});

test("an organization admin can still stop another member's runtime compute", async () => {
  const f = await checkpointFixture("modal");
  try {
    const admin = {
      ...f.caller,
      userId: f.people.admin,
      orgs: [{ orgId: f.people.org, role: "admin" as const }],
    };
    const stop = stopPort(f);
    await expect(
      callSharedTool({ ...stop.context, caller: admin, data: createSqlData(f.sql)(admin) }, "stop", { id: f.row.id }),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(stop.calls()).toBe(1);
    expect((await f.db.query("select 1 from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows).toHaveLength(
      0,
    );
  } finally {
    await f.close();
  }
});

test.each(["boat", "modal"] as const)("%s stop recovers the original checkpoint ACK", async (provider) => {
  const f = await checkpointFixture(provider);
  try {
    const input = args(f.row.id);
    const unavailable = {
      ...f.bridge,
      async call() {
        throw Error("dropped before delivery");
      },
    };
    await expect(createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, unavailable)(f.caller, input)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.send(f.caller, f.input("must not run"))).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts).toHaveLength(1);
    await expect(
      createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, args(f.row.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    const lost = {
      ...f.bridge,
      async call(...params: Parameters<typeof f.bridge.call>) {
        await f.bridge.call(...params);
        throw Error("lost after durable result");
      },
    };
    await expect(createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, lost)(f.caller, input)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      (await f.db.query("select watermark from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows[0],
    ).toEqual({ watermark: null });
    await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    const stop = stopPort(f);
    await callSharedTool(stop.context, "stop", { id: f.row.id });
    const recovered = await createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, input);
    expect(recovered.checkpoint.state).toBe("complete");
    const authStore = createMemoryAuthStore();
    authStore.addMembership(f.people.owner, { orgId: f.people.org, name: "Fixture", role: "member" });
    const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: f.people.owner })).replace(/=+$/, "")}.sig`;
    const response = await handleControlRequest(
      new Request("https://armada.test/api/v1/sandbox/checkpoint-runtime-v1", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(input),
      }),
      {
        authStore,
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        supabase: {
          supabaseUrl: "https://supabase.test",
          anonKey: "fixture",
          fetch: async () => Response.json({ id: f.people.owner }),
        },
        data: createSqlData(f.sql),
        runtimeCheckpoint: createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, unavailable),
        providers: {
          async resolve() {
            throw Error("No compute/provider resolution for cached checkpoint");
          },
        },
      },
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(recovered);
    await expect(
      createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, unavailable)({ ...f.caller, userId: f.people.admin }, input),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await f.db.query<{ ok: boolean }>(
        "select has_table_privilege($1,'runtime_checkpoints','select,insert,update,delete') as ok",
        [role],
      );
      expect(rows[0]?.ok).toBe(false);
    }
    const final = await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id);
    if (provider === "boat") expect(final?.preservationNote).toContain("runtime checkpoint acknowledged");
    else {
      expect(final?.status).toBe("stopped");
      expect(final?.preservationNote).toBeNull();
      expect(
        (
          await f.db.query(
            "select preservation_stop_generation=stop_generation as captured from sandboxes where id=$1",
            [f.row.id],
          )
        ).rows,
      ).toEqual([{ captured: true }]);
    }
    expect(stop.calls()).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an enrolled scoped parent loses its grant before checkpoint dispatch and scrubs on recovery", async () => {
  const f = await checkpointFixture("modal", true);
  const done = Promise.withResolvers<"finished">();
  try {
    const id = f.row.id;
    await f.db.query("update sandboxes set visibility='private', access_owner_id=owner_id where id=$1", [id]);
    await f.db.query(
      `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state)
       values($1,'sandbox',$2,$3,$1,'ready')`,
      [id, f.people.org, f.people.owner],
    );
    const generation = (
      await f.db.query<{ generation: string }>(
        "select lifecycle_generation::text as generation from sandboxes where id=$1",
        [id],
      )
    ).rows[0]!.generation;
    const authority = new DelegatedAuthority(f.sql, async () => {});
    let token = "";
    await authority.installEpoch(
      id,
      {
        lifecycleGeneration: generation,
        physicalGeneration: f.active.epoch,
        async deliver(bearer, binding) {
          token = bearer;
          const reply = await f.bridge.call(
            f.people.owner,
            {
              version: 1,
              sandboxId: id,
              requestId: crypto.randomUUID(),
              op: "installOrchestratorEpoch",
              token: bearer,
              binding,
              url: "https://armada.test/mcp",
            },
            { expectedEpoch: f.active.epoch },
          );
          return { acknowledged: (reply.body.result as { acknowledged?: boolean })?.acknowledged === true };
        },
        async scrub() {
          throw Error("Unexpected grant installation failure");
        },
      },
      { scopes: ["worker:stop"], goldenIds: [], credentialIds: [] },
    );
    const admit = () => authority.admit(token, { method: "finish" }, async () => true);
    await expect(admit()).resolves.toBe(true);

    const input = args(id);
    f.hold(done.promise);
    await f.send(f.caller, f.input("hold the turn open"));
    const failedIntent: Sql = {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!((tx) =>
          work({
            async query(statement, values) {
              if (statement.startsWith("insert into public.runtime_checkpoints")) throw Error("intent write failed");
              return tx.query(statement, values);
            },
          }),
        ),
    };
    await expect(createRuntimeCheckpoint(failedIntent, ENCRYPTION_KEY, f.bridge)(f.caller, input)).rejects.toThrow(
      "intent write failed",
    );
    await expect(admit()).resolves.toBe(true);

    const beforeDispatch = {
      ...f.bridge,
      async call() {
        throw Error("Interrupted after checkpoint intent");
      },
    };
    await expect(createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, beforeDispatch)(f.caller, input)).rejects.toMatchObject(
      {
        code: "conflict",
      },
    );
    await expect(admit()).rejects.toThrow("denied");
    const checkpoint = createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge);
    await expect(checkpoint(f.caller, input)).rejects.toMatchObject({ code: "conflict" });
    done.resolve("finished");
    await f.runner.flushOutbox();
    f.dropReplyOnce("scrubOrchestratorEpoch");
    await expect(checkpoint(f.caller, input)).rejects.toMatchObject({ code: "conflict" });
    const pending = (await f.bridge.next(f.active.runtimeToken, f.active.epoch)).command;
    if (pending?.op !== "scrubOrchestratorEpoch") throw Error("Expected the pending scoped scrub command");
    const lostScrubReply = {
      ...f.bridge,
      async call(...params: Parameters<typeof f.bridge.call>) {
        expect(params[1].requestId).toBe(pending.requestId);
        const reply = await f.bridge.call(...params);
        if (params[1].op === "scrubOrchestratorEpoch" && reply.status === 200) throw Error("lost scrub reply");
        return reply;
      },
    };
    await expect(createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, lostScrubReply)(f.caller, input)).rejects.toMatchObject(
      {
        code: "conflict",
      },
    );
    const checkpointOnly = {
      ...f.bridge,
      async call(...params: Parameters<typeof f.bridge.call>) {
        expect(params[1].op).toBe("checkpoint");
        return f.bridge.call(...params);
      },
    };
    const recovered = await createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, checkpointOnly)(f.caller, input);
    expect(recovered.checkpoint.state).toBe("complete");
  } finally {
    done.resolve("finished");
    await f.close();
  }
});

test.each(["generation", "prefix", "ack"] as const)(
  "authenticated but invalid durable checkpoint proof fails closed (%s)",
  async (mode) => {
    const f = await checkpointFixture();
    try {
      f.tamper(mode);
      const lines: string[] = [];
      const response = await observeRequest(
        async () => {
          await expect(
            createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, args(f.row.id)),
          ).rejects.toMatchObject({ code: "conflict" });
          return new Response(null, { status: 409 });
        },
        (line) => lines.push(line),
      );
      // A malformed acknowledgement is never recorded as a successful runtime checkpoint. A
      // well-formed one whose watermark disagrees with the stored journal (prefix) is a valid
      // runtime reply that publication then refuses; the request record carries that 409.
      const records = lines.map((line) => JSON.parse(line));
      expect(records.filter((event) => event.event === "provider_call")).toEqual([
        expect.objectContaining({
          requestId: response?.headers.get("x-request-id"),
          operation: "runtime.checkpoint",
          outcome: mode === "prefix" ? "ok" : "error",
        }),
      ]);
      expect(records.filter((event) => event.event === "http_request")).toEqual([
        expect.objectContaining({ requestId: response?.headers.get("x-request-id"), status: 409 }),
      ]);
      expect(
        (await f.db.query("select watermark from runtime_checkpoints where sandbox_id=$1", [f.row.id])).rows[0],
      ).toEqual({ watermark: null });
      await expect(f.send(f.caller, f.input())).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await f.close();
    }
  },
);

test.each([
  ["late journal tail", "Runtime journal changed after checkpoint"],
  ["application-secret exposure", "Application-secret exposure forbids checkpoint reuse"],
] as const)("checkpoint reuse refuses %s", async (change, message) => {
  const { db, sql, row, caller, active, enrolments } = await enrolledCheckpointTarget();
  const input = args(row.id);
  await db.query(
    "insert into runtime_checkpoints(sandbox_id,epoch,request_id,watermark,completed_at) values($1,$2,$3,0,now())",
    [row.id, active.epoch, input.request_id],
  );
  const checkpoint = createRuntimeCheckpoint(sql, ENCRYPTION_KEY, {
    ...createRuntimeCommands(enrolments, ENCRYPTION_KEY),
    async call() {
      throw Error("Checkpoint replay dispatched to the guest");
    },
  });
  expect((await checkpoint(caller, input)).checkpoint.state).toBe("complete");
  if (change === "late journal tail") {
    await createRuntimeEvents(enrolments, ENCRYPTION_KEY).append(active.runtimeToken, active.epoch, {
      sandboxId: row.id,
      generation: active.epoch,
      events: [
        {
          sequence: 1,
          event: { id: "late", at: 1, kind: "other", type: "late-notification", data: {} },
        },
      ],
    });
  } else {
    await db.query("update sandboxes set application_secret_tainted=true where id=$1", [row.id]);
  }
  await expect(checkpoint(caller, input)).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringContaining(message),
  });
});
