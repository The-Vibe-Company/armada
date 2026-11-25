import { expect, mock, spyOn, test } from "bun:test";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  DelegatedAuthority,
  encryptSecret,
  type Sql,
} from "@armada/core/server";
import { createTurnDispatchJob } from "../src/account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { createSqlData, DataError } from "../src/data.ts";
import { createEventFeed } from "../src/event-feed.ts";
import { runModalLaunch } from "../src/jobs/modal-launch.ts";
import { ModalLaunchSetupConflict } from "../src/jobs/modal-launch-setup.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeFollowup, RuntimeFollowupConflict } from "../src/runtime-followup.ts";
import { createRuntimeProvider } from "../src/runtime-provider.ts";
import {
  RuntimeCheckpointActivityConflict,
  RuntimeReconciliationConflict,
} from "../src/runtime-reconciliation-conflict.ts";
import { createSandboxChildren, type SandboxChildExecutor } from "../src/sandbox-access-children.ts";
import { createSandboxAccessServices } from "../src/sandbox-access-services.ts";
import { runtimeWakes, SANDBOX_ADMISSION_WAKE } from "../src/wake-bus.ts";
import { archivedBoat, runBoatStop } from "./boat-stop.fixture.ts";
import { modalAdmissionFixture } from "./modal-admission.fixture.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runClaimedStop } from "./stop-job.fixture.ts";
import { ENCRYPTION_KEY, fakeBoat } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(
  parentState: "ready" | "running" = "running",
  accountKind: "anthropic" | "codex_auth" = "anthropic",
  provider: "boat" | "modal" = "boat",
  abortAfterTransition?: (code: unknown) => boolean,
) {
  const { db, people: p } = await sharedDatabase();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          async query<T>(statement: string, params?: unknown[]) {
            const result = await tx.query<T>(statement, params);
            if (statement.includes("from public.sandbox_transition(") && abortAfterTransition?.(params?.[5]))
              throw Error("Synthetic transaction failure after journaling a transition");
            return result;
          },
        }),
      ),
  };
  const golden =
    provider === "modal"
      ? (
          await db.query<{ id: string }>(
            `insert into goldens(org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
             select $1,$2,'modal-child','org','modal','image','workspace','main','app',config from goldens where org_id=$1 and name='shared' returning id`,
            [p.org, p.owner],
          )
        ).rows[0]
      : (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const parent = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider,
    providerSandboxId: "parent-child-admission",
    goldenId: golden.id,
    orgId: p.org,
    ownerId: p.owner,
    harness: "codex",
    status: parentState,
    model: "m",
    reasoningEffort: "high",
    visibility: "private",
  });
  const id = crypto.randomUUID();
  const account = crypto.randomUUID();
  await db.query("insert into orchestrators(id,org_id,owner_id,sandbox_id,state) values($1,$2,$3,$4,'ready')", [
    id,
    p.org,
    p.owner,
    parent.id,
  ]);
  await db.query(
    `insert into orchestrator_runtime(orchestrator_id,configuration,skill_revision,conversation_id,continuity)
    values($1,$2::jsonb,$3,$4,$5)`,
    [
      id,
      JSON.stringify({
        version: 1,
        orgId: p.org,
        name: "existing coordinator",
        goldenId: golden.id,
        provider: "boat",
        harness: "codex",
        model: "m",
        modelAccountId: crypto.randomUUID(),
      }),
      "78884de87066851b75e09cbda134606c0a8bc6d7",
      parentState === "ready" ? null : "existing-native-conversation",
      parentState === "ready" ? "not_started" : "native",
    ],
  );
  await db.query(
    `insert into credentials(id,scope,owner_id,kind,value_enc,name) values($1,'user',$2,$4,$3,'Child test account')`,
    [
      account,
      p.owner,
      await encryptSecret(
        accountKind === "codex_auth"
          ? JSON.stringify({
              tokens: {
                access_token: "synthetic-native-child-access",
                refresh_token: "synthetic-native-child-refresh",
                account_id: "synthetic-native-child-account",
              },
            })
          : "synthetic-model-key-not-a-real-secret",
        ENCRYPTION_KEY,
      ),
      accountKind,
    ],
  );
  const authority = new DelegatedAuthority(sql, async (tx, accountRequest) => {
    // Actual #612 resolver + real row lock, synthetic encrypted API-key fixture only.
    await tx.query("select id from credentials where id=$1 for update", [accountRequest.credentialId]);
    await launchCredentials(createSqlVaultStore(tx), ENCRYPTION_KEY).resolve(
      { userId: accountRequest.userId, orgId: accountRequest.orgId, role: "member" },
      accountRequest.harness,
      accountRequest.credentialId,
      accountRequest.credentialVersion,
    );
  });
  let token = "";
  await authority.installEpoch(
    id,
    {
      physicalGeneration: "synthetic-native-physical-663",
      lifecycleGeneration: String(parent.lifecycleGeneration),
      async deliver(secret) {
        token = secret;
        return { acknowledged: true };
      },
      async scrub() {},
    },
    {
      scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop", "worker:extend"],
      goldenIds: [golden.id],
      credentialIds: [account],
    },
  );
  const selection = {
    goldenId: golden.id,
    harness: "claude" as const,
    credentialId: account,
    credentialVersion: 1,
    model: "m",
  };
  return {
    db,
    sql,
    p,
    parent,
    id,
    authority,
    token,
    selection,
    golden,
    // The shared helper owns borrowed connections until afterAll.
    close: async () => {
      await db.exec("reset role; reset all; set search_path=public");
    },
  };
}

const childRuntime = (
  sql: Sql,
  provider: ReturnType<typeof fakeBoat>["provider"],
  admitLaunch?: Awaited<ReturnType<typeof modalAdmissionFixture>>,
) =>
  createSandboxAccessServices({
    sql,
    providers: { resolve: async () => provider },
    connections: undefined,
    encryptionKey: ENCRYPTION_KEY,
    scopedMcpUrl: "https://armada.example/mcp",
    ...(admitLaunch ? { admitLaunch } : {}),
  });

const boatAdmissionProvider = (boat: ReturnType<typeof fakeBoat>) => ({
  ...boat.provider,
  managementIdentity: async () => ({ scope: "org" as const, ownerId: "fixture" }),
});

const admissionScenarios = [
  "revoked Boat",
  "lost Modal acknowledgement",
  "rolled back Boat",
  "brief parent contention",
  "contended Boat admission",
];

test.each(admissionScenarios)(
  "delegated child launch admission preserves its durable authority fence after %s",
  async (scenario) => {
    const provider = scenario === "lost Modal acknowledgement" ? "modal" : "boat";
    const { close, db, sql, p, authority, id, token, selection } = await fixture("running", "anthropic", provider);
    try {
      const boat = fakeBoat();
      const fixtureProvider = { ...boatAdmissionProvider(boat), id: provider };
      let armed = false;
      let authorityOutsideTransaction = false;
      const guarded: Sql = {
        ...sql,
        async query<T>(statement: string, params?: unknown[]) {
          if (statement.includes("orchestrator_child_operations") && /for share of [\w,]*\bs\b/.test(statement))
            authorityOutsideTransaction = true;
          return sql.query<T>(statement, params);
        },
        transaction: async (work) => {
          const result = await sql.transaction!(async (tx) => {
            let parentLockHeld = scenario === "brief parent contention" || scenario === "contended Boat admission";
            const value = await work({
              ...tx,
              async query<T>(statement: string, params?: unknown[]) {
                if (armed && parentLockHeld && /for share of [\w,]*\bs\b/.test(statement)) {
                  const { rows } = await tx.query<{ lock_timeout: string }>("show lock_timeout");
                  const noWait = /\bnowait\b/i.test(statement);
                  if (!noWait) expect(rows[0]?.lock_timeout).toBe("2s");
                  if (noWait || scenario === "contended Boat admission")
                    throw Object.assign(new Error("parent sandbox lock unavailable"), {
                      name: "PostgresError",
                      errno: "55P03",
                    });
                  parentLockHeld = false;
                }
                return tx.query<T>(statement, params);
              },
            });
            if (armed && scenario === "rolled back Boat") throw Error("worker admission rollback");
            return value;
          });
          if (armed && scenario === "lost Modal acknowledgement") throw Error("admission response lost");
          return result;
        },
      };
      const admit = await modalAdmissionFixture(
        guarded,
        ENCRYPTION_KEY,
        createSqlVaultStore(sql),
        provider === "modal"
          ? {
              orgId: p.org,
              userId: p.owner,
              visibility: "org",
              binding: { workspace: "workspace", environment: "main", appId: "app" },
            }
          : undefined,
        fixtureProvider,
      );
      const { childWorker } = childRuntime(sql, fixtureProvider, async (...args) => {
        armed = true;
        try {
          return await admit(...args);
        } finally {
          armed = false;
        }
      });
      const chosen = { ...selection, model: "claude-sonnet-4-6", size: "small" as const };
      const receipt = await childWorker.launch(token, "same-key", chosen);
      const jobs = createJobsStore(sql, ENCRYPTION_KEY);
      if (scenario === "contended Boat admission") {
        expect(receipt.state).toBe("failed");
        expect(
          (await db.query("select state,error_code from orchestrator_child_operations where id=$1", [receipt.id])).rows,
        ).toEqual([{ state: "failed", error_code: "child_admission_lock_contended" }]);
        expect(await childWorker.launch(token, "same-key", chosen)).toEqual(receipt);
        expect(await jobs.claim("launch", crypto.randomUUID(), 30, 1)).toBeUndefined();
        expect((await db.query("select id from sandboxes where id=$1", [receipt.sandboxId])).rows).toEqual([]);
        return;
      }
      if (scenario === "rolled back Boat") {
        expect(receipt.state).toBe("uncertain");
        expect(await jobs.claim("launch", crypto.randomUUID(), 30, 1)).toBeUndefined();
        expect((await db.query("select id from sandboxes where id=$1", [receipt.sandboxId])).rows).toEqual([]);
        await db.query("update orchestrator_child_operations set reconcile_after='-infinity' where id=$1", [
          receipt.id,
        ]);
        await db.query("update orchestrator_child_operations set error_code=null where id=$1", [receipt.id]);
        expect(await childWorker.reconcileOne()).toBe(false);
        await db.query(
          "update orchestrator_child_operations set error_code='child_launch_admission_pending' where id=$1",
          [receipt.id],
        );
        expect(await childWorker.reconcileOne()).toBe(true);
        expect((await childWorker.launch(token, "same-key", chosen)).state).toBe("failed");
        return;
      }
      expect(receipt.state).toBe("succeeded");
      expect(await childWorker.launch(token, "same-key", { ...chosen, skills: [] })).toEqual(receipt);
      await expect(childWorker.launch(token, "same-key", { ...chosen, size: "large" })).rejects.toThrow(
        "Idempotency conflict",
      );
      expect(await childWorker.read(token, receipt.sandboxId)).toMatchObject({
        status: "starting",
        providerSandboxId: null,
        events: [],
      });
      const job = await jobs.claim("launch", crypto.randomUUID(), 30, 1);
      expect(job).toMatchObject({
        sandbox_id: receipt.sandboxId,
        payload: { childOperationId: receipt.id, allocation: { size: "small" } },
      });
      expect(
        (
          await db.query(
            `select s.visibility,s.credential_id,s.credential_version,c.orchestrator_id
          from sandboxes s join orchestrator_children c on c.sandbox_id=s.id where s.id=$1`,
            [receipt.sandboxId],
          )
        ).rows,
      ).toEqual([
        { visibility: "private", credential_id: selection.credentialId, credential_version: 1, orchestrator_id: id },
      ]);
      expect(boat.forks).toHaveLength(0);
      if (scenario === "lost Modal acknowledgement") {
        await db.query(
          `update jobs set outcome='{"modal_machine":{"entry":{"operation":"create","phase":"allocated","machineId":"child-modal"}}}'
           where id=$1`,
          [job!.id],
        );
        await db.query("update sandboxes set provider_sandbox_id='child-modal' where id=$1", [receipt.sandboxId]);
        await db.query("update sandboxes set status='ready' where id=$1", [receipt.sandboxId]);
        await db.query(
          "insert into runtime_enrolments(sandbox_id,lifecycle_generation,epoch,runtime_hash) values($1,1,1,repeat('a',64))",
          [receipt.sandboxId],
        );
        const setup = (
          await db.query<{ id: string }>(
            "update jobs set state='done' where sandbox_id=$1 and kind='launch_initial_turn' returning id",
            [receipt.sandboxId],
          )
        ).rows[0]!;
        const queue = createAccountTurnQueue(sql, ENCRYPTION_KEY);
        expect(
          await queue.acceptInitialLaunch(
            { via: "service", userId: p.owner, orgs: [{ orgId: p.org, role: "member" }] },
            { id: receipt.sandboxId, request_id: setup.id, prompt: "first turn" },
            "1",
            async () => true,
            { childOperationId: receipt.id },
          ),
        ).toBe(true);
        await authority.revoke(id);
        const send = mock(async () => ({}));
        const turn = (await jobs.claim("turn_dispatch", crypto.randomUUID(), 30, 1))!;
        await createTurnDispatchJob(guarded, ENCRYPTION_KEY, send).run(turn, {
          signal: new AbortController().signal,
          canDispatch: async () => true,
          handoffGeneration: async () => "1",
        });
        expect(send).not.toHaveBeenCalled();
        expect(authorityOutsideTransaction).toBe(false);
        expect((await db.query("select state from account_turn_queue where request_id=$1", [setup.id])).rows).toEqual([
          { state: "failed" },
        ]);
      }
      if (scenario === "revoked Boat" && job) {
        await authority.revoke(id);
        const unexpected = () => {
          throw Error("revoked launch must not allocate or bootstrap");
        };
        const result = await runModalLaunch(
          sql,
          ENCRYPTION_KEY,
          job,
          {
            signal: new AbortController().signal,
            canDispatch: async () => true,
          },
          () => ({
            boat: "fixture",
            bindingRef: job.id,
            allocation: { source: { kind: "snapshot", ref: "snapshot" }, computeTtlSeconds: 3600, size: "small" },
            canUseModalCredential: async () => true,
            prepareRuntimeTicket: unexpected,
            machine: () => ({
              create: unexpected,
              bootstrap: unexpected,
              stop: unexpected,
              resume: unexpected,
              delete: unexpected,
              observe: async () => ({ kind: "absent" }),
            }),
          }),
          "boat",
        );
        expect(result.status).toBe("fail");
      }
    } finally {
      await close();
    }
  },
);

test("own children support independent target receipts while unrelated children remain denied", async () => {
  const { close, db, sql, p, parent, id, authority, token, selection } = await fixture();
  try {
    const boat = fakeBoat();
    const messages: string[] = [];
    const stopped: string[] = [];
    const admit = await modalAdmissionFixture(
      sql,
      ENCRYPTION_KEY,
      createSqlVaultStore(sql),
      undefined,
      boatAdmissionProvider(boat),
    );
    const { childWorker } = childRuntime(sql, boat.provider, admit);
    const executor: SandboxChildExecutor = {
      async launch() {
        throw Error("Unexpected launch");
      },
      async reconcile(op) {
        return { operationId: op.id, sandboxId: op.sandboxId, state: "unknown" };
      },
      async message(op) {
        messages.push(op.sandboxId);
      },
      async stop(op) {
        stopped.push(op.sandboxId);
      },
      async read(sandboxId, ownerId, orgId) {
        return { sandboxId, ownerId, orgId };
      },
    };
    const children = createSandboxChildren(sql, authority, executor);
    for (const key of ["ticket-one", "ticket-two", "ticket-three", "ticket-four"]) {
      expect((await childWorker.launch(token, key, { ...selection, model: "claude-sonnet-4-6" })).state).toBe(
        "succeeded",
      );
    }
    const rows = (
      await db.query<{ sandbox_id: string }>(
        "select sandbox_id from orchestrator_children where orchestrator_id=$1 order by sandbox_id",
        [id],
      )
    ).rows;
    const bindingRows = (
      await db.query<{ credential_id: string; credential_version: number }>(
        "select credential_id,credential_version from sandboxes where id=any($1::uuid[])",
        [rows.map((r) => r.sandbox_id)],
      )
    ).rows;
    expect(bindingRows).toHaveLength(4);
    for (const binding of bindingRows)
      expect(binding).toEqual({
        credential_id: selection.credentialId,
        credential_version: selection.credentialVersion,
      });
    expect(rows).toHaveLength(4); // No synthetic three-child default from the provisional DTO.
    const readyChildren = [];
    for (const providerSandboxId of ["receipt-isolation-first", "receipt-isolation-second"]) {
      const child = await createSqlSandboxStore(sql).insert({
        id: crypto.randomUUID(),
        provider: parent.provider,
        providerSandboxId,
        goldenId: selection.goldenId,
        orgId: p.org,
        ownerId: p.owner,
        harness: "claude",
        status: "ready",
        model: "claude-sonnet-4-6",
        reasoningEffort: "medium",
      });
      await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
      readyChildren.push(child.id);
    }
    const [first, second] = readyChildren;
    if (!first || !second) throw Error("owned child missing");
    const one = await children.message(token, "same-key", first, "first ticket");
    expect(one.state).toBe("succeeded");
    expect((await children.message(token, "same-key", second, "second ticket")).state).toBe("succeeded");
    expect(await children.message(token, "same-key", first, "first ticket")).toEqual(one);
    expect(messages).toEqual([first, second]);
    expect(await children.read(token, first)).toEqual({ sandboxId: first, ownerId: p.owner, orgId: p.org });
    expect((await children.stop(token, "stop-child", first)).state).toBe("succeeded");
    expect(stopped).toEqual([first]);
    await expect(children.stop(token, "stop-parent", parent.id)).rejects.toThrow("authority");
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    await expect(children.read(token, second)).rejects.toThrow("authority");
  } finally {
    await close();
  }
});

test.each(["launch", "message"] as const)(
  "revocation before dispatch records the failed %s admission",
  async (action) => {
    const { close, db, sql, id, p, parent, golden, authority, token, selection } = await fixture();
    try {
      let childId: string | undefined;
      if (action === "message") {
        const child = await createSqlSandboxStore(sql).insert({
          id: crypto.randomUUID(),
          provider: parent.provider,
          providerSandboxId: "child-dispatch-admission",
          goldenId: golden.id,
          orgId: p.org,
          ownerId: p.owner,
          harness: "codex",
          model: selection.model,
          reasoningEffort: "high",
          status: "ready",
          visibility: "private",
        });
        childId = child.id;
        await db.query(
          "insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)",
          [childId, id, p.org, p.owner],
        );
      }
      let admissions = 0;
      let dispatches = 0;
      const children = createSandboxChildren(
        sql,
        {
          async admit(secret, request, reserve) {
            if (++admissions === 2) await authority.revoke(id);
            return authority.admit(secret, request, reserve);
          },
        },
        {
          async launch() {
            dispatches++;
            throw Error("allocation must not start");
          },
          async message() {
            dispatches++;
            throw Error("message must not start");
          },
          async stop() {
            throw Error("unexpected");
          },
          async read() {
            throw Error("unexpected");
          },
          async reconcile(op) {
            return { operationId: op.id, sandboxId: op.sandboxId, state: "unknown" };
          },
        },
      );
      const lines: string[] = [];
      let receipt: Awaited<ReturnType<typeof children.launch>> | undefined;
      const response = await observeRequest(
        async () => {
          receipt = childId
            ? await children.message(token, "queued-revoke", childId, "synthetic child prompt")
            : await children.launch(token, "queued-revoke", selection);
          return new Response();
        },
        (line) => lines.push(line),
      );
      expect(dispatches).toBe(0);
      if (!receipt) throw Error("Missing child receipt.");
      expect(receipt.state).toBe("failed");
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          event: "operator_failure",
          phase: `scoped.child_${action}.dispatch_admission`,
          code: "child_dispatch_not_admitted",
          refusalCode: "authority_denied",
          errorClass: "DelegatedAuthorityDenied",
          sandboxId: receipt.sandboxId,
          operationId: receipt.id,
          requestId: response?.headers.get("x-request-id"),
        }),
      );
    } finally {
      await close();
    }
  },
);

test("scoped message after async launch waits for readiness before dispatch", async () => {
  const { close, sql, token, selection } = await fixture();
  const waiting = Promise.withResolvers<void>();
  const abort = new AbortController();
  const boat = fakeBoat();
  const admitLaunch = await modalAdmissionFixture(
    sql,
    ENCRYPTION_KEY,
    createSqlVaultStore(sql),
    undefined,
    boatAdmissionProvider(boat),
  );
  const services = createSandboxAccessServices({
    sql: {
      ...sql,
      transaction: (work) =>
        sql.transaction!(async (tx) =>
          work({
            async query<T>(statement: string, params?: unknown[]) {
              const result = await tx.query<T>(statement, params);
              if (statement.includes("as extension_refused") && (result.rows[0] as { busy?: boolean })?.busy)
                waiting.resolve();
              return result;
            },
          }),
        ),
    },
    providers: { resolve: async () => boat.provider },
    connections: undefined,
    encryptionKey: ENCRYPTION_KEY,
    scopedMcpUrl: "https://armada.example/mcp",
    admitLaunch,
    runtimeSend: createRuntimeFollowup(
      sql,
      ENCRYPTION_KEY,
      createRuntimeCommands(createRuntimeEnrolments(sql, ENCRYPTION_KEY), ENCRYPTION_KEY),
    ),
  });
  try {
    const { sandboxId, state } = await services.childWorker.launch(token, "launch", {
      ...selection,
      model: "claude-sonnet-4-6",
      size: "small",
    });
    expect(state).toBe("succeeded");
    const send = services.childWorker.message(token, "message", sandboxId, "follow up", abort.signal);
    const firstOutcome = await Promise.race([
      waiting.promise.then(() => "waiting"),
      send.then((receipt) => receipt.state),
    ]);
    abort.abort();
    expect(firstOutcome).toBe("waiting");
    expect(await send).toMatchObject({ state: "failed", sandboxId });
    expect(
      (
        await sql.query(
          "select dispatched_at from orchestrator_child_operations where target_id=$1 and action='message'",
          [sandboxId],
        )
      ).rows,
    ).toEqual([{ dispatched_at: null }]);
  } finally {
    await close();
  }
});

test.each(["succeeds", "revoked", "deadline expired", "setup failed"] as const)(
  "scoped message during ready child launch setup: %s",
  async (outcome) => {
    const { close, db, sql, id, p, authority, token, selection } = await fixture("running", "anthropic", "modal");
    let waiting = Promise.withResolvers<void>();
    const abort = new AbortController();
    const runtimeSend = mock(
      createRuntimeFollowup(
        sql,
        ENCRYPTION_KEY,
        createRuntimeCommands(createRuntimeEnrolments(sql, ENCRYPTION_KEY), ENCRYPTION_KEY),
      ),
    );
    const provider = { ...boatAdmissionProvider(fakeBoat()), id: "modal" as const };
    const admitLaunch = await modalAdmissionFixture(
      sql,
      ENCRYPTION_KEY,
      createSqlVaultStore(sql),
      {
        orgId: p.org,
        userId: p.owner,
        visibility: "org",
        binding: { workspace: "workspace", environment: "main", appId: "app" },
      },
      provider,
    );
    const services = createSandboxAccessServices({
      sql: {
        ...sql,
        transaction: (work) =>
          sql.transaction!(async (tx) =>
            work({
              async query<T>(statement: string, params?: unknown[]) {
                const result = await tx.query<T>(statement, params);
                if (statement.includes("as extension_refused") && (result.rows[0] as { busy?: boolean })?.busy)
                  waiting.resolve();
                return result;
              },
            }),
          ),
      },
      providers: { resolve: async () => provider },
      connections: undefined,
      encryptionKey: ENCRYPTION_KEY,
      scopedMcpUrl: "https://armada.example/mcp",
      admitLaunch,
      runtimeSend,
    });
    try {
      const launch = await services.childWorker.launch(token, "launch", {
        ...selection,
        model: "claude-sonnet-4-6",
        size: "small",
      });
      expect(launch.state).toBe("succeeded");
      const sandboxId = launch.sandboxId;
      const job = await createJobsStore(sql, ENCRYPTION_KEY).claim("launch", crypto.randomUUID(), 30, 1);
      expect(job?.sandbox_id).toBe(sandboxId);
      await db.query(
        `update jobs set outcome='{"modal_machine":{"entry":{"operation":"create","phase":"allocated","machineId":"child-modal"}}}'
         where sandbox_id=$1 and kind='launch'`,
        [sandboxId],
      );
      await db.query("update sandboxes set provider_sandbox_id='child-modal' where id=$1", [sandboxId]);
      await db.query("update sandboxes set status='ready' where id=$1", [sandboxId]);
      const setup = (
        await db.query<{ id: string }>(
          "select id from jobs where sandbox_id=$1 and kind='launch_initial_turn' and state='queued'",
          [sandboxId],
        )
      ).rows[0]!;
      expect(setup).toBeDefined();

      await db.query(
        "insert into runtime_enrolments(sandbox_id,lifecycle_generation,epoch,runtime_hash) values($1,1,1,repeat('a',64))",
        [sandboxId],
      );
      const deadline = new AbortController();
      const timeout =
        outcome === "deadline expired" ? spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal) : undefined;
      const send = services.childWorker.message(token, "message", sandboxId, "follow up", abort.signal);
      async function expectWaiting() {
        expect(await Promise.race([waiting.promise.then(() => "waiting"), send.then((receipt) => receipt.state)])).toBe(
          "waiting",
        );
        expect(runtimeSend).not.toHaveBeenCalled();
      }
      await expectWaiting().finally(() => timeout?.mockRestore());
      if (outcome === "succeeds") {
        await db.query("update jobs set state='done' where id=$1", [setup.id]);
        const queue = createAccountTurnQueue(sql, ENCRYPTION_KEY);
        expect(
          await queue.acceptInitialLaunch(
            { via: "service", userId: p.owner, orgs: [{ orgId: p.org, role: "member" }] },
            { id: sandboxId, request_id: setup.id, prompt: "first turn" },
            "1",
            async () => true,
            { childOperationId: launch.id },
          ),
        ).toBe(true);
        waiting = Promise.withResolvers<void>();
        runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
        await expectWaiting();
        runtimeSend.mockResolvedValueOnce({});
        await db.query("update account_turn_queue set state='admitted' where request_id=$1", [setup.id]);
      } else if (outcome === "revoked") {
        await authority.revoke(id);
      } else if (outcome === "deadline expired") {
        deadline.abort(new DOMException("Admission timed out", "TimeoutError"));
      } else {
        await db.query("update jobs set state='failed' where id=$1", [setup.id]);
      }
      runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
      expect(await send).toMatchObject({ state: outcome === "succeeds" ? "succeeded" : "failed", sandboxId });
      expect(runtimeSend).toHaveBeenCalledTimes(outcome === "succeeds" ? 1 : 0);
      if (outcome !== "succeeds") {
        expect(
          (
            await db.query(
              "select dispatched_at from orchestrator_child_operations where target_id=$1 and action='message'",
              [sandboxId],
            )
          ).rows,
        ).toEqual([{ dispatched_at: null }]);
      }
    } finally {
      abort.abort();
      await services.childWorker.drain();
      await close();
    }
  },
);

test("an uncertain scoped message records a correlated operator diagnostic", async () => {
  const { close, db, sql, id, p, parent, golden, authority, token, selection } = await fixture();
  try {
    const child = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: parent.provider,
      providerSandboxId: "child-message-outcome",
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      model: selection.model,
      reasoningEffort: "high",
      status: "ready",
    });
    await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
    let claimMiss = false;
    let setupFailed = false;
    let admissions = 0;
    let dispatches = 0;
    const children = createSandboxChildren(
      sql,
      {
        async admit(secret, request, reserve) {
          if (claimMiss && ++admissions === 2)
            await db.query(
              "update orchestrator_child_operations set dispatched_at=now() where orchestrator_id=$1 and idempotency_key=$2",
              [id, "message-claim-miss"],
            );
          return authority.admit(secret, request, reserve);
        },
      },
      {
        async message() {
          dispatches++;
          if (setupFailed) throw new ModalLaunchSetupConflict("modal_launch_setup_failed");
          throw new RuntimeFollowupConflict("runtime_activity_busy", "private provider response");
        },
        async launch() {
          throw Error("unexpected");
        },
        async stop() {
          throw Error("unexpected");
        },
        async read() {
          throw Error("unexpected");
        },
        async reconcile(op) {
          return { operationId: op.id, sandboxId: op.sandboxId, state: "unknown" };
        },
      },
    );
    const lines: string[] = [];
    let receipt: Awaited<ReturnType<typeof children.message>> | undefined;
    const response = await observeRequest(
      async () => {
        receipt = await children.message(token, "message-outcome", child.id, "synthetic child prompt");
        return new Response();
      },
      (line) => lines.push(line),
    );
    if (!receipt) throw Error("Missing child message receipt.");
    const original = receipt;
    expect(original.state).toBe("uncertain");
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "operator_failure",
        phase: "scoped.child_message.execution",
        code: "child_outcome_unconfirmed",
        causeCode: "runtime_activity_busy",
        sandboxId: child.id,
        operationId: original.id,
        requestId: response?.headers.get("x-request-id"),
      }),
    );
    const replayResponse = await observeRequest(
      async () => {
        expect(await children.message(token, "message-outcome", child.id, "synthetic child prompt")).toEqual(original);
        return new Response();
      },
      (line) => lines.push(line),
    );
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        phase: "scoped.child_message.receipt",
        causeCode: "prior_uncertain_receipt",
        sandboxId: child.id,
        operationId: original.id,
      }),
    );
    expect(replayResponse?.status).toBe(200);
    claimMiss = true;
    const claimMissResponse = await observeRequest(
      async () => {
        const target = child.id.toUpperCase();
        const missed = await children.message(token, "message-claim-miss", target, "synthetic child prompt");
        expect(missed).toMatchObject({ state: "uncertain", sandboxId: target });
        expect(lines.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({
            phase: "scoped.child_message.receipt",
            causeCode: "dispatch_claim_missing",
            sandboxId: child.id,
            operationId: missed.id,
          }),
        );
        return new Response();
      },
      (line) => lines.push(line),
    );
    expect(claimMissResponse?.status).toBe(200);
    expect(dispatches).toBe(1);
    claimMiss = false;
    setupFailed = true;
    const refused = await children.message(token, "message-setup-failed", child.id, "synthetic child prompt");
    expect(refused.state).toBe("failed");
    expect(await children.message(token, "message-setup-failed", child.id, "synthetic child prompt")).toEqual(refused);
    expect(dispatches).toBe(2);
    expect(lines.join("\n")).not.toContain("private provider response");
  } finally {
    await close();
  }
});

test("scoped enrolled Boat extension fails before recording dispatch", async () => {
  const { close, db, sql, id, p, golden, authority, token } = await fixture();
  try {
    const child = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "enrolled-child",
      boatRuntime: true,
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      model: "m",
      reasoningEffort: "high",
      status: "ready",
    });
    await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
    const unexpected = async () => {
      throw Error("Unexpected child executor call");
    };
    const extend = mock(unexpected);
    const children = createSandboxChildren(sql, authority, {
      launch: unexpected,
      message: unexpected,
      stop: unexpected,
      extend,
      read: unexpected,
      reconcile: unexpected,
    });

    const receipt = await children.extend(token, "extend-enrolled", child.id, 1_200);
    expect(receipt.state).toBe("failed");
    expect(extend).not.toHaveBeenCalled();
    expect(
      (await db.query("select dispatched_at,error_code from orchestrator_child_operations where id=$1", [receipt.id]))
        .rows,
    ).toEqual([{ dispatched_at: null, error_code: "child_dispatch_not_admitted" }]);
  } finally {
    await close();
  }
});

test.each([
  "message",
  "stop",
  "extend",
  "shutdown while waiting",
  "abort after commit",
  "abandoned before dispatch",
] as const)("scoped child admission handles %s", async (scenario) => {
  const action = scenario === "stop" || scenario === "extend" ? scenario : "message";
  const requestAbort = new AbortController();
  const { close, db, sql, id, p, parent, golden, authority, token, selection } = await fixture(
    "running",
    "codex_auth",
    "modal",
  );
  try {
    const child = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: parent.provider,
      providerSandboxId: "reconciling-child",
      modalTransport: "dialout",
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      model: selection.model,
      reasoningEffort: "high",
      status: "ready",
    });
    await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
    const lease = action === "stop" ? crypto.randomUUID() : null;
    await db.query(
      `update sandboxes set activity_lease_id=$2, activity_until=case when $2::uuid is not null then 'infinity'::timestamptz end,
        reconcile_lease_until=case when $2::uuid is null then 'infinity'::timestamptz end where id=$1`,
      [child.id, lease],
    );
    const waiting = Promise.withResolvers<void>();
    const raced = Promise.withResolvers<void>();
    let dispatchAdmissions = 0;
    let executionAttempts = 0;
    const execute = mock(async () => {
      if (++executionAttempts !== 1) return;
      raced.resolve();
      if (action === "stop") throw new RuntimeCheckpointActivityConflict();
      throw new DataError("Sandbox is busy.", "sandbox_not_ready", { cause: new RuntimeReconciliationConflict() });
    });
    const recoverStop = spyOn({ recoverStop: async () => {} }, "recoverStop");
    const children = createSandboxChildren(
      sql,
      {
        async admit(secret, request, reserve) {
          const result = await authority.admit(secret, request, reserve);
          if (++dispatchAdmissions === 2) waiting.resolve();
          if (dispatchAdmissions === 3 && scenario === "abort after commit") requestAbort.abort();
          return result;
        },
      },
      {
        message: execute,
        stop: execute,
        recoverStop,
        extend: execute,
        async launch() {
          throw Error("unexpected launch");
        },
        async read() {
          throw Error("unexpected read");
        },
        async reconcile() {
          throw Error("unexpected reconciliation");
        },
      },
    );
    const request = () => {
      if (action === "message")
        return children.message(token, "busy", child.id, "synthetic child prompt", requestAbort.signal);
      if (action === "extend") return children.extend(token, "busy", child.id, 60);
      return children.stop(token, "busy", child.id);
    };
    const pending = request();
    await waiting.promise;
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await db.query("select state,dispatched_at from orchestrator_child_operations where target_id=$1", [child.id]))
        .rows,
    ).toEqual([{ state: "pending", dispatched_at: null }]);

    if (scenario === "abandoned before dispatch") {
      expect(await children.reconcileOne()).toBe(false);
      await db.query("update orchestrator_child_operations set reconcile_after='-infinity' where target_id=$1", [
        child.id,
      ]);
      expect(await children.reconcileOne()).toBe(true);
      const recorded = await request();
      expect(recorded).toMatchObject({ state: "failed", sandboxId: child.id });
      await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [child.id]);
      runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
      expect(await pending).toEqual(recorded);
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "shutdown while waiting") {
      children.stopAdmission();
      expect(await pending).toMatchObject({ state: "failed", sandboxId: child.id });
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    if (lease) {
      await createSqlData(sql)({
        userId: p.owner,
        orgs: [{ orgId: p.org, role: "member" }],
        via: "service",
      }).sandboxes.update(child.id, {
        finishActivity: true,
        activityToken: lease,
        expectedGeneration: child.lifecycleGeneration!,
      });
    } else {
      await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [child.id]);
    }
    runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
    if (scenario === "abort after commit") {
      expect(await pending).toMatchObject({ state: "failed", sandboxId: child.id });
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    await raced.promise;
    await db.query("select 1");
    runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
    const result = await pending;
    expect(result).toMatchObject({ state: "succeeded", sandboxId: child.id });
    expect(await request()).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(recoverStop).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

test("read-only delegated scope cannot override the launch method through untrusted selection fields", async () => {
  const { close, db, sql, p, parent, id, authority, selection, golden } = await fixture();
  try {
    const child = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "read-only-child",
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "claude",
      status: "running",
      model: "m",
      reasoningEffort: "medium",
      visibility: "private",
    });
    await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
    let readToken = "";
    await authority.installEpoch(
      id,
      {
        physicalGeneration: "synthetic-native-physical-663",
        lifecycleGeneration: String(parent.lifecycleGeneration),
        async deliver(token) {
          readToken = token;
          return { acknowledged: true };
        },
        async scrub() {},
      },
      { scopes: ["worker:read"], goldenIds: [], credentialIds: [] },
    );
    let allocations = 0;
    const children = createSandboxChildren(sql, authority, {
      async launch() {
        allocations++;
        throw Error("unauthorized allocation attempt");
      },
      async message() {
        throw Error("unexpected");
      },
      async stop() {
        throw Error("unexpected");
      },
      async read() {
        return parent.id;
      },
      async reconcile(op) {
        return { operationId: op.id, sandboxId: op.sandboxId, state: "unknown" };
      },
    });
    const injected = JSON.parse(JSON.stringify({ ...selection, method: "read", childId: child.id }));
    await expect(children.launch(readToken, "scope-confusion", injected)).rejects.toThrow();
    expect(allocations).toBe(0);
    await expect(children.launch(readToken, "well-formed-launch", selection)).rejects.toThrow("authority");
  } finally {
    await close();
  }
});

test("production scoped MCP/API gateway uses epoch child authority and never owner dispatch", async () => {
  const { close, sql, p, id, parent, authority, token, selection } = await fixture("ready");
  const { ORCHESTRATOR_SCOPED_PATH } = await import("@armada/core/contract");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const boat = fakeBoat();
  const clients: InstanceType<typeof Client>[] = [];
  try {
    const admit = await modalAdmissionFixture(
      sql,
      ENCRYPTION_KEY,
      createSqlVaultStore(sql),
      undefined,
      boatAdmissionProvider(boat),
    );
    const services = childRuntime(sql, boat.provider, admit);
    const route = services.scopedToolsRoute;
    const clientFor = async (secret: string) => {
      const client = new Client({ name: "scoped-native-fixture", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`https://armada.example.com${ORCHESTRATOR_SCOPED_PATH}/mcp`), {
          fetch: async (input, init) =>
            (await route(new Request(String(input), init))) ?? new Response(null, { status: 404 }),
          requestInit: { headers: { authorization: `Bearer ${secret}` } },
        }),
      );
      clients.push(client);
      return client;
    };
    const client = await clientFor(token);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "extend",
      "launch",
      "message",
      "read",
      "stop",
    ]);
    const launched = await client.callTool({
      name: "launch",
      arguments: {
        idempotencyKey: "mcp-child",
        selection: { ...selection, model: "claude-sonnet-4-6", size: "small" },
      },
    });
    expect(launched.isError).not.toBe(true);
    const receipt = (
      launched.structuredContent as { result: { id: string; sandboxId: string; state: string } } | undefined
    )?.result;
    if (!receipt) throw new Error("Scoped launch receipt missing.");
    expect(receipt.state).toBe("succeeded");
    expect((await client.callTool({ name: "read", arguments: { sandboxId: receipt.sandboxId } })).isError).not.toBe(
      true,
    );
    expect((await client.callTool({ name: "read", arguments: { sandboxId: parent.id } })).isError).toBe(true);
    const unrelated = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "same-owner-unrelated-worker",
      goldenId: selection.goldenId,
      orgId: p.org,
      ownerId: p.owner,
      harness: "claude",
      status: "running",
      model: "m",
      reasoningEffort: "medium",
      visibility: "private",
    });
    expect((await client.callTool({ name: "read", arguments: { sandboxId: unrelated.id } })).isError).toBe(true);
    const api = async (method: string, payload: unknown, secret = token, key?: string) =>
      (await route(
        new Request(`https://armada.example.com${ORCHESTRATOR_SCOPED_PATH}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}),
          },
          body: JSON.stringify(payload),
        }),
      )) ?? new Response(null, { status: 404 });
    const { publishedResponse } = await import("./published-response.ts");
    const launchResponse = await api(
      "launch",
      { selection: { ...selection, model: "claude-sonnet-4-6", size: "small" } },
      token,
      "mcp-child",
    );
    expect(launchResponse.status).toBe(200);
    expect(publishedResponse("orchestrator-tools/launch").safeParse(await launchResponse.json()).success).toBe(true);
    const readResponse = await services.scopedToolsRoute(
      new Request(`https://armada.example.com${ORCHESTRATOR_SCOPED_PATH}/read`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ sandboxId: receipt.sandboxId }),
      }),
    );
    if (!readResponse) throw new Error("Scoped read did not dispatch.");
    expect(readResponse.status).toBe(200);
    expect(publishedResponse("orchestrator-tools/read").safeParse(await readResponse.json()).success).toBe(true);
    for (const method of ["exec", "credentials", "admin", "owner", "token_create"])
      expect((await api(method, {})).status).toBe(403);
    expect((await api("wait_record", { kind: "child", reference: receipt.sandboxId })).status).toBe(503);
    const denied = await api("read", { sandboxId: unrelated.id });
    expect(denied.status).toBe(403);
    expect((await denied.text()).includes(token)).toBe(false);
    const oversizedSerializedPrompt = "\\".repeat(70_000);
    expect(
      (
        await route(
          new Request(`https://armada.example.com${ORCHESTRATOR_SCOPED_PATH}/launch`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "idempotency-key": "oversized-launch" },
            body: JSON.stringify({ selection: { ...selection, prompt: oversizedSerializedPrompt } }),
          }),
        )
      )?.status,
    ).toBe(400);
    expect((await api("read", { sandboxId: receipt.sandboxId }, "armada_owner_session_not_epoch")).status).toBe(401);
    expect(
      (
        await api(
          "launch",
          { selection: { ...selection, method: "read", childId: receipt.sandboxId } },
          token,
          "injected",
        )
      ).status,
    ).toBe(400);
    let readonly = "";
    await authority.installEpoch(
      id,
      {
        physicalGeneration: "synthetic-native-physical-663",
        lifecycleGeneration: String(parent.lifecycleGeneration),
        async deliver(secret) {
          readonly = secret;
          return { acknowledged: true };
        },
        async scrub() {},
      },
      { scopes: ["worker:read"], goldenIds: [], credentialIds: [] },
    );
    const reader = await clientFor(readonly);
    expect((await reader.listTools()).tools.map((tool) => tool.name)).toEqual(["read"]);
    expect((await reader.callTool({ name: "read", arguments: { sandboxId: receipt.sandboxId } })).isError).not.toBe(
      true,
    );
    expect(
      (await reader.callTool({ name: "launch", arguments: { idempotencyKey: "read-scope-cannot-launch", selection } }))
        .isError,
    ).toBe(true);
    expect((await client.callTool({ name: "read", arguments: { sandboxId: receipt.sandboxId } })).isError).toBe(true); // old epoch
    await sql.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect((await reader.callTool({ name: "read", arguments: { sandboxId: receipt.sandboxId } })).isError).toBe(true);
    expect(boat.forks).toHaveLength(0);
  } finally {
    for (const client of clients) await client.close();
    await close();
  }
});

const stopRecoveryCases = ["checkpoint", "handler", "both", "recovery rollback"];

test.each(stopRecoveryCases)("scoped Modal stop recovery after %s", async (loss) => {
  const loseStopReply = loss === "both";
  const abortRecovery = loss === "recovery rollback";
  const suspendFirstStop = loss !== "checkpoint";
  const checkpointWritten = Promise.withResolvers<void>();
  const releaseCheckpoint = Promise.withResolvers<void>();
  let recoveryAborts = 0;
  const { close, sql, p, id, token, selection } = await fixture("running", "anthropic", "modal", (code) => {
    if (!abortRecovery || code !== "runtime_retained_stop") return false;
    recoveryAborts++;
    return true;
  });
  try {
    const fake = fakeBoat();
    let checkpointRequest: string | undefined;
    let checkpointCalls = 0;
    let hostAvailable = true;
    const physicalDeadline = new Date(Date.now() + 16_000_000);
    const host = {
      ...fake.provider,
      id: "modal" as const,
      async get(id: string) {
        const info = await fake.provider.get(id);
        return info.state === "ready"
          ? { ...info, providerState: "active", expiresAt: physicalDeadline, physicalGeneration: "1" }
          : info;
      },
      async captureRuntimeWork() {
        expect(checkpointRequest).toBeDefined();
        return { status: "clean" as const };
      },
      async runtimeStopMachine() {
        return {
          physical: { machineId: "physical", generation: 1 },
          stopped: false,
          machine: {
            stop: async (request: { retain: boolean; sandboxId: string; generation: number }) => {
              expect(checkpointRequest).toBeDefined();
              expect(request.retain).toBe(true);
              expect(
                (
                  await sql.query(
                    `select status_reason,preservation_stop_generation=stop_generation as captured from sandboxes where id=$1`,
                    [logicalId],
                  )
                ).rows[0],
              ).toEqual({ status_reason: "idle_paused", captured: true });
              await fake.provider.stop({ sandboxId: physicalId! });
              if (loseStopReply) throw Error("synthetic lost compute stop response");
              return { sandboxId: request.sandboxId, generation: request.generation, kind: "image", ref: "image" };
            },
          },
        };
      },
    };
    const resolved = await fake.provider.fork({ from: "test", name: "child", ttlSeconds: 3600, noEnv: true, env: {} });
    const physicalId = resolved.id;
    const saved = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "modal",
      providerSandboxId: physicalId,
      modalTransport: "dialout",
      orgId: p.org,
      ownerId: p.owner,
      goldenId: selection.goldenId,
      visibility: "private",
      status: "starting",
      harness: "claude",
      model: "m",
      reasoningEffort: "medium",
      credentialId: selection.credentialId,
      credentialVersion: 1,
    });
    const logicalId = saved.id;
    await sql.query("insert into orchestrator_children values($1,$2,$3,$4)", [logicalId, id, p.org, p.owner]);
    const enrolments = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const ticket = await enrolments.issue({
      sandboxId: logicalId,
      ownerId: p.owner,
      commandGrantExpiresAt: physicalDeadline.getTime(),
      configuration: { grant: { expiresAt: physicalDeadline.getTime() } },
    });
    await enrolments.enrol(ticket.enrolmentToken);
    await sql.query("update sandboxes set status='running' where id=$1", [logicalId]);
    const sends: { id: string; prompt: string; request_id?: string | undefined }[] = [];
    const services = createSandboxAccessServices({
      sql,
      providers: {
        async resolve(target, caller) {
          if (!hostAvailable) throw Error("Modal App is unavailable");
          expect(target.id).toBeDefined();
          expect(target.modalTransport).toBe("dialout");
          expect(target.visibility).toBe("private");
          expect(target.sourceGoldenVisibility).toBe("org");
          expect(caller.userId).toBe(p.owner);
          return createRuntimeProvider(
            host,
            physicalId,
            { events: host.events, getPrompt: host.getPrompt },
            undefined,
            host.captureRuntimeWork,
          );
        },
      },
      connections: undefined,
      encryptionKey: ENCRYPTION_KEY,
      scopedMcpUrl: "https://armada.example/mcp",
      async runtimeCheckpoint(caller, request) {
        expect(caller.userId).toBe(p.owner);
        expect((await createSqlData(sql)(caller).sandboxes.get(request.id))?.status).toBe("running");
        checkpointRequest = request.request_id;
        checkpointCalls++;
        if (checkpointCalls === 1) {
          await sql.query("insert into runtime_checkpoints(sandbox_id,epoch,request_id) values($1,1,$2)", [
            request.id,
            request.request_id,
          ]);
          checkpointWritten.resolve();
          if (suspendFirstStop) await releaseCheckpoint.promise;
          throw Error("synthetic lost response after checkpoint intent");
        }
        await sql.query(
          "update runtime_checkpoints set watermark=0,completed_at=now() where sandbox_id=$1 and epoch=1 and request_id=$2",
          [request.id, request.request_id],
        );
        return {
          id: request.id,
          requestId: request.request_id,
          runtime: { kind: "armada", epoch: "1" },
          checkpoint: { state: "complete", watermark: 0, acknowledgedSequence: 0 },
        };
      },
      async runtimeSend(caller, request) {
        expect(caller.userId).toBe(p.owner);
        expect(caller.orgs.map(({ orgId }) => orgId)).toEqual([p.org]);
        sends.push(request);
        return {
          id: request.id,
          requestId: request.request_id!,
          runtime: { kind: "armada", epoch: "1" },
          promptId: "runtime-follow-up",
          conversationId: "runtime-conversation",
          status: "running",
        };
      },
    });
    const receipt = { sandboxId: logicalId };
    hostAvailable = false;
    const message = await services.childWorker.message(token, "message", receipt.sandboxId, "follow up");
    hostAvailable = true;
    expect(message.state).toBe("succeeded");
    expect(sends).toEqual([{ id: receipt.sandboxId, prompt: "follow up", request_id: message.id }]);
    expect(fake.prompts).toHaveLength(0);
    expect(
      (
        await sql.query(
          `select c.orchestrator_id,c.owner_id,c.org_id,s.id as sandbox_id from orchestrator_children c
         join sandboxes s on s.id=c.sandbox_id where c.sandbox_id=$1`,
          [receipt.sandboxId],
        )
      ).rows,
    ).toEqual([{ orchestrator_id: id, owner_id: p.owner, org_id: p.org, sandbox_id: logicalId }]);
    expect((await services.childWorker.extend(token, "extend", receipt.sandboxId, 15_000)).state).toBe("succeeded");
    const firstStop = services.childWorker.stop(token, "stop", receipt.sandboxId);
    let stopped: Awaited<typeof firstStop>;
    try {
      if (suspendFirstStop) {
        await Promise.race([
          checkpointWritten.promise,
          firstStop.then(() => {
            throw Error("Initial stop completed before writing the checkpoint.");
          }),
        ]);
        expect(fake.stops).toHaveLength(0);
        stopped = await services.childWorker.stop(token, "stop", receipt.sandboxId);
      } else {
        const first = await firstStop;
        expect(first.state).toBe("uncertain");
        expect(fake.stops).toHaveLength(0);
        stopped = await services.childWorker.stop(token, "stop", receipt.sandboxId);
        expect(stopped.id).toBe(first.id);
      }
      expect(stopped.state).toBe(abortRecovery ? "pending" : "succeeded");
    } finally {
      releaseCheckpoint.resolve();
      await firstStop;
    }
    expect(checkpointRequest).toBe(stopped.id);
    if (abortRecovery) {
      expect(recoveryAborts).toBe(1);
      expect(
        (await sql.query("select activity_lease_id, stop_requested_at from sandboxes where id=$1", [receipt.sandboxId]))
          .rows,
      ).toEqual([{ activity_lease_id: null, stop_requested_at: null }]);
    } else {
      expect(await services.childWorker.stop(token, "stop", receipt.sandboxId)).toEqual(stopped);
    }
    if (!abortRecovery)
      expect((await runClaimedStop(sql, async () => host)).result.status).toBe(loseStopReply ? "retry" : "done");
    expect(checkpointCalls).toBe(2);
    expect(fake.stops).toHaveLength(abortRecovery ? 0 : 1);
    expect(
      (
        await sql.query(
          `select actor,code,to_status from sandbox_transitions
         where sandbox_id=$1 and to_status in ('stopping','stopped') order by id`,
          [receipt.sandboxId],
        )
      ).rows,
    ).toEqual(
      abortRecovery
        ? []
        : [
            { actor: "api", code: "runtime_retained_stop", to_status: "stopping" },
            ...(loseStopReply ? [] : [{ actor: "lifecycle_runner", code: "owner_stop_settled", to_status: "stopped" }]),
          ],
    );
    await expect(services.childWorker.read(token, receipt.sandboxId)).resolves.toMatchObject({
      status: abortRecovery ? "running" : loseStopReply ? "stopping" : "stopped",
    });
  } finally {
    await close();
  }
});

test("managed child stop stays pending until the shared job confirms exit", async () => {
  const { close, db, sql, p, id, token, golden } = await fixture("running", "anthropic", "boat");
  try {
    const fake = fakeBoat();
    const physical = await fake.provider.fork({ from: "test" });
    const child = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: physical.id,
      goldenId: golden.id,
      orgId: p.org,
      ownerId: p.owner,
      harness: "codex",
      status: "ready",
      model: "m",
      reasoningEffort: "high",
    });
    await db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, id, p.org, p.owner]);
    const services = createSandboxAccessServices({
      sql,
      providers: { resolve: async () => fake.provider },
      connections: undefined,
      encryptionKey: ENCRYPTION_KEY,
      scopedMcpUrl: "https://armada.example/mcp",
    });
    expect((await services.childWorker.stop(token, crypto.randomUUID(), child.id)).state).toBe("succeeded");
    expect(fake.stops).toHaveLength(0);
    expect(await services.childWorker.read(token, child.id)).toMatchObject({ status: "stopping" });
    expect(await runBoatStop(sql, archivedBoat())).toBe("done");
    expect(await services.childWorker.read(token, child.id)).toMatchObject({ status: "stopped" });
  } finally {
    await close();
  }
});

// Scoped child messages share ordinary send's native receipt registration, so the
// shared settlement boundary admits the turn to Langfuse export.

test("the event feed grants a scoped bearer access only to its authorized child", async () => {
  const f = await fixture();
  try {
    const child = await createSqlSandboxStore(f.sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "event-feed-child",
      goldenId: f.golden.id,
      orgId: f.p.org,
      ownerId: f.p.owner,
      harness: "codex",
      model: "m",
      reasoningEffort: "medium",
      status: "ready",
      visibility: "private",
    });
    await f.db.query("insert into orchestrator_children values($1,$2,$3,$4)", [child.id, f.id, f.p.org, f.p.owner]);
    await f.db.query("insert into event_log(org_id,sandbox_id,kind,ref) values($1,$2,'transition',1)", [
      f.p.org,
      child.id,
    ]);
    const feed = createEventFeed(f.sql, f.authority);
    expect(await feed.child(f.token, child.id)("0")).toEqual([
      expect.objectContaining({ sandboxId: child.id, kind: "transition", sequence: null }),
    ]);
    expect(await feed.child(f.token, f.parent.id)("0")).toBeNull();
    await f.db.query("update orchestrator_delegations set revoked_at=now() where orchestrator_id=$1", [f.id]);
    expect(await feed.child(f.token, child.id)("0")).toBeNull();
  } finally {
    await f.close();
  }
});
