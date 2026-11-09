import { expect, test } from "bun:test";
import type { OrchestratorOperation } from "@armada/core";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  OrchestratorAuthority,
  reserveOrchestratorOperation,
  type Sql,
} from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { callOrchestrator } from "../src/orchestrator-api.ts";
import { launchOrchestratorChild } from "../src/orchestrator-child-launch.ts";
import { createOrchestratorChildren, type OrchestratorChildExecutor } from "../src/orchestrator-children.ts";
import { createLifecycleAwareOrchestratorRuntime } from "../src/orchestrator-lifecycle-integration.ts";
import { configureOrchestratorLifecycle } from "../src/orchestrator-lifecycle-settings.ts";
import { createOrchestratorWaits } from "../src/orchestrator-waits.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

async function fixture() {
  const { db, people: p } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const parent = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "parent-child-admission",
    goldenId: golden.id,
    orgId: p.org,
    ownerId: p.owner,
    harness: "codex",
    status: "running",
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
    values($1,$2::jsonb,$3,'existing-native-conversation','native')`,
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
    ],
  );
  await db.query(
    `insert into credentials(id,scope,owner_id,kind,value_enc,name) values($1,'user',$2,'anthropic',$3,'Child test account')`,
    [account, p.owner, await encryptSecret("synthetic-model-key-not-a-real-secret", ENCRYPTION_KEY)],
  );
  const authority = new OrchestratorAuthority(sql, async (tx, accountRequest) => {
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
      async deliver(secret) {
        token = secret;
        return { acknowledged: true };
      },
      async scrub() {},
    },
    {
      scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop"],
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
  return { db, sql, p, parent, id, authority, token, selection, golden };
}

test("delegated child reservation precedes ambiguous allocation and retries cannot allocate twice", async () => {
  const { db, sql, p, parent, authority, token, selection } = await fixture();
  try {
    let allocations = 0;
    const executor: OrchestratorChildExecutor = {
      async launch(operation) {
        allocations++;
        const reservation = (
          await db.query<{ target_id: string; owner_id: string; org_id: string; state: string }>(
            "select target_id,owner_id,org_id,state from orchestrator_child_operations where id=$1",
            [operation.id],
          )
        ).rows[0];
        expect(reservation).toEqual({
          target_id: operation.sandboxId,
          owner_id: p.owner,
          org_id: p.org,
          state: "pending",
        });
        throw Error("synthetic response lost after provider allocation");
      },
      async reconcile(operation) {
        return { operationId: operation.id, sandboxId: operation.sandboxId, state: "unknown" };
      },
      async message() {
        throw Error("unexpected message");
      },
      async stop() {
        throw Error("unexpected stop");
      },
      async read() {
        throw Error("unexpected read");
      },
    };
    const children = createOrchestratorChildren(sql, authority, executor);
    const first = await children.launch(token, "ticket-663", selection);
    expect(first.state).toBe("uncertain");
    expect(await children.launch(token, "ticket-663", selection)).toEqual(first);
    expect(allocations).toBe(1);
    expect(await children.reconcileOne()).toBe(true);
    expect(allocations).toBe(1);
    expect(await children.launch(token, "ticket-663", selection)).toEqual(first);
    await expect(children.launch(token, "ticket-663", { ...selection, model: "different" })).rejects.toThrow(
      "Idempotency conflict",
    );
    const op = (
      await db.query<{ target_id: string }>("select target_id from orchestrator_child_operations where id=$1", [
        first.id,
      ])
    ).rows[0];
    expect(op?.target_id).toBeTruthy();
    await expect(children.read(token, parent.id)).rejects.toThrow("authority");
    expect((await db.query("select * from orchestrator_children")).rows).toHaveLength(0);
    await expect(
      db.query("update orchestrator_child_operations set owner_id=$1 where id=$2", [p.admin, first.id]),
    ).rejects.toThrow("immutable child reservation");
  } finally {
    await db.close();
  }
});

test("own children support independent target receipts while unrelated children remain denied", async () => {
  const { db, sql, p, parent, id, authority, token, selection } = await fixture();
  try {
    const boat = fakeBoat();
    const messages: string[] = [];
    const stopped: string[] = [];
    const executor: OrchestratorChildExecutor = {
      async launch(op, selected) {
        return launchOrchestratorChild({
          sql,
          provider: boat.provider,
          operation: op,
          selection: selected,
          stores: {
            goldens: createSqlGoldenStore(sql),
            sandboxes: createSqlSandboxStore(sql),
            credentials: {
              async resolve() {
                throw Error("legacy credential fallback forbidden");
              },
            },
          },
          namedCredentials: launchCredentials(createSqlVaultStore(sql), ENCRYPTION_KEY),
        });
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
    const children = createOrchestratorChildren(sql, authority, executor);
    expect((await children.launch(token, "ticket-one", { ...selection, size: "small" })).state).toBe("succeeded");
    expect(boat.forks[0]?.size).toBe("small");
    await expect(children.launch(token, "ticket-one", { ...selection, size: "large" })).rejects.toThrow(
      "Idempotency conflict",
    );
    expect((await children.launch(token, "ticket-two", selection)).state).toBe("succeeded");
    expect((await children.launch(token, "ticket-three", selection)).state).toBe("succeeded");
    expect((await children.launch(token, "ticket-four", selection)).state).toBe("succeeded");
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
    const first = rows[0]?.sandbox_id,
      second = rows[1]?.sandbox_id;
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
    await db.close();
  }
});

test("revocation between reservation and dispatch cancels queued allocation", async () => {
  const { db, sql, id, authority, token, selection } = await fixture();
  try {
    let admissions = 0,
      allocations = 0;
    const children = createOrchestratorChildren(
      sql,
      {
        async admit(secret, request, reserve) {
          if (++admissions === 2) await authority.revoke(id);
          return authority.admit(secret, request, reserve);
        },
      },
      {
        async launch() {
          allocations++;
          throw Error("allocation must not start");
        },
        async message() {
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
    const receipt = await children.launch(token, "queued-revoke", selection);
    expect(allocations).toBe(0);
    expect(receipt.state).toBe("failed");
  } finally {
    await db.close();
  }
});

test("actual owner prompt receipt survives delegated child admission before provider acknowledgement", async () => {
  const { db, sql, p, parent, id, authority, token, selection } = await fixture();
  try {
    const children = createOrchestratorChildren(sql, authority, {
      async launch() {
        throw Error("synthetic ambiguous child allocation");
      },
      async message() {
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
    });
    const boat = fakeBoat();
    const services = createLifecycleAwareOrchestratorRuntime(sql, {
      reserveOperation: reserveOrchestratorOperation,
      authority,
      skillRevision: "78884de87066851b75e09cbda134606c0a8bc6d7",
      async resolveBackend() {
        return {
          provider: {
            ...boat.provider,
            async get() {
              return {
                id: parent.providerSandboxId,
                name: "synthetic native parent",
                state: "running" as const,
                providerState: "running",
                labels: {},
              };
            },
            async prompt() {
              await children.launch(token, "while-parent-admits", selection);
              return {
                promptId: "owner-prompt",
                conversationId: "existing-native-conversation",
                status: "running" as const,
              };
            },
          },
          projectDir: "/workspace",
          mcpUrl: "https://armada.example.com/mcp",
          consent: { scopes: [], goldenIds: [], credentialIds: [] },
          transport: {
            async deliver() {
              throw Error("unexpected grant");
            },
            async scrub() {},
          },
          async assertNativeProof() {},
          async launch() {
            throw Error("unexpected");
          },
          async checkpointAndStop() {
            throw Error("unexpected");
          },
          async revalidate() {},
        };
      },
    });
    const caller = { userId: p.owner, orgs: [{ orgId: p.org, role: "member" as const }], via: "supabase" as const };
    const result = (await callOrchestrator(
      services.runtime,
      caller,
      "message",
      { orgId: p.org, id, expectedRevision: 0, text: "coordinate a child" },
      "owner-admits",
    )) as OrchestratorOperation;
    expect(result.state).toBe("succeeded");
    expect(
      (await db.query<{ state: string }>("select state from orchestrator_operations where id=$1", [result.id])).rows[0]
        ?.state,
    ).toBe("succeeded");
  } finally {
    await db.close();
  }
});

test("owner waits and settings cannot invalidate an admitted owner operation", async () => {
  const { db, sql, p, id, authority } = await fixture();
  try {
    const services = createLifecycleAwareOrchestratorRuntime(sql, {
      reserveOperation: reserveOrchestratorOperation,
      authority,
      skillRevision: "78884de87066851b75e09cbda134606c0a8bc6d7",
      async resolveBackend() {
        throw Error("no backend needed");
      },
    });
    const operation = await services.store.reserve({
      ownerId: p.owner,
      orgId: p.org,
      id,
      action: "message",
      key: "pending-owner",
      expectedRevision: 0,
      payload: { text: "admitted" },
    });
    await expect(
      configureOrchestratorLifecycle(sql, {
        key: "policy",
        orchestratorId: id,
        ownerId: p.owner,
        expectedRevision: 1,
        idleSeconds: 900,
        maxActiveChildren: null,
      }),
    ).rejects.toThrow("busy");
    const at = new Date("2030-01-01");
    const waits = createOrchestratorWaits(
      sql,
      {
        async inspect(input) {
          return { ...input, identity: "ci-event-1", at, state: "active" };
        },
      },
      () => at,
    );
    await expect(
      waits.record({
        key: "wait",
        orchestratorId: id,
        ownerId: p.owner,
        expectedRevision: 1,
        generation: "1",
        kind: "ci",
        reference: "repo:run",
        reason: "CI",
      }),
    ).rejects.toThrow("busy");
    expect(
      await services.store.complete(operation, { state: "succeeded", conversationId: "existing-native-conversation" }),
    ).toBe(true);
  } finally {
    await db.close();
  }
});

test("missing actual named-account schema fails before fork without an uncertain allocation reservation", async () => {
  const { db, sql, authority, token, selection } = await fixture();
  try {
    const boat = fakeBoat();
    // Simulate a deployment missing the actual producer202 column, not a second account schema.
    await db.exec("alter table sandboxes drop column credential_id");
    const children = createOrchestratorChildren(sql, authority, {
      async launch(operation, selected) {
        return launchOrchestratorChild({
          sql,
          provider: boat.provider,
          operation,
          selection: selected,
          stores: {
            goldens: createSqlGoldenStore(sql),
            sandboxes: createSqlSandboxStore(sql),
            credentials: {
              async resolve() {
                throw Error("no legacy fallback");
              },
            },
          },
          namedCredentials: {
            async resolve() {
              throw Error("schema must be checked first");
            },
          },
        });
      },
      async read() {
        throw Error("unexpected");
      },
      async message() {
        throw Error("unexpected");
      },
      async stop() {
        throw Error("unexpected");
      },
      async reconcile(op) {
        return { operationId: op.id, sandboxId: op.sandboxId, state: "unknown" };
      },
    });
    expect((await children.launch(token, "missing202", selection)).state).toBe("failed");
    expect(boat.forks).toHaveLength(0);
    expect((await db.query<{ state: string }>("select state from orchestrator_child_operations")).rows[0]?.state).toBe(
      "failed",
    );
  } finally {
    await db.close();
  }
});

test("read-only delegated scope cannot override the launch method through untrusted selection fields", async () => {
  const { db, sql, p, parent, id, authority, selection, golden } = await fixture();
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
        async deliver(token) {
          readToken = token;
          return { acknowledged: true };
        },
        async scrub() {},
      },
      { scopes: ["worker:read"], goldenIds: [], credentialIds: [] },
    );
    let allocations = 0;
    const children = createOrchestratorChildren(sql, authority, {
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
    await db.close();
  }
});

for (const outcome of ["direct-success", "direct-failed", "discovery-success"] as const) {
  test(`child terminal receipt is not downgraded by delayed ${outcome} publication`, async () => {
    const { db, sql, p, authority, token, selection, golden } = await fixture();
    const deferred = <T>() => {
      let resolve: (value: T) => void = () => {};
      let reject: (reason: unknown) => void = () => {};
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    };
    const entered = deferred<void>(),
      discovered = deferred<void>();
    const launchReply = deferred<{ providerSandboxId: string }>();
    const discoverReply = deferred<Awaited<ReturnType<OrchestratorChildExecutor["reconcile"]>>>();
    let op: Parameters<OrchestratorChildExecutor["launch"]>[0] | undefined;
    try {
      const children = createOrchestratorChildren(sql, authority, {
        async launch(operation) {
          op = operation;
          if (outcome !== "direct-failed")
            await createSqlSandboxStore(sql).insert({
              id: operation.sandboxId,
              provider: "boat",
              providerSandboxId: "receipt-race",
              goldenId: golden.id,
              orgId: p.org,
              ownerId: p.owner,
              harness: "claude",
              status: "running",
              model: "m",
              reasoningEffort: "medium",
              visibility: "private",
            });
          entered.resolve();
          return launchReply.promise;
        },
        async reconcile() {
          discovered.resolve();
          return discoverReply.promise;
        },
        async read() {
          throw Error("unexpected");
        },
        async message() {
          throw Error("unexpected");
        },
        async stop() {
          throw Error("unexpected");
        },
      });
      const launch = children.launch(token, "terminal-race", selection);
      await entered.promise;
      const reconcile = children.reconcileOne();
      await discovered.promise;
      if (!op) throw Error("missing operation");
      if (outcome === "discovery-success") {
        discoverReply.resolve({
          operationId: op.id,
          sandboxId: op.sandboxId,
          state: "succeeded",
          providerSandboxId: "receipt-race",
        });
        await reconcile;
        launchReply.reject(Error("original response lost after confirmed discovery"));
        expect((await launch).state).toBe("succeeded");
      } else {
        if (outcome === "direct-success") launchReply.resolve({ providerSandboxId: "receipt-race" });
        else {
          const { ChildLaunchNotAllocated } = await import("../src/orchestrator-child-launch.ts");
          launchReply.reject(new ChildLaunchNotAllocated("preallocation_rejected"));
        }
        await launch;
        discoverReply.resolve({ operationId: op.id, sandboxId: op.sandboxId, state: "unknown" });
        await reconcile;
      }
      expect(
        (await db.query<{ state: string }>("select state from orchestrator_child_operations where id=$1", [op.id]))
          .rows[0]?.state,
      ).toBe(outcome === "direct-failed" ? "failed" : "succeeded");
    } finally {
      launchReply.reject(Error("fixture cleanup"));
      await db.close();
    }
  });
}

for (const proof of [
  "closed-owned-resource",
  "wrong-resource",
  "no-stop-proof",
  "contradictory-no-allocation",
] as const) {
  test(`uncertain child allocation settles only on matching terminal provider evidence (${proof})`, async () => {
    const { db, sql, p, id, authority, token, selection } = await fixture();
    try {
      await configureOrchestratorLifecycle(sql, {
        key: "explicit-child-policy",
        orchestratorId: id,
        ownerId: p.owner,
        expectedRevision: 0,
        idleSeconds: 7200,
        maxActiveChildren: 1,
      });
      let allocations = 0;
      const children = createOrchestratorChildren(sql, authority, {
        async launch(op) {
          allocations++;
          await sql.query("update orchestrator_child_operations set provider_sandbox_id=$2 where id=$1", [
            op.id,
            `allocated-${op.id}`,
          ]);
          throw Error("registration response unavailable after allocation");
        },
        async reconcile(op) {
          return {
            operationId: op.id,
            sandboxId: op.sandboxId,
            state: "failed",
            providerSandboxId: proof === "wrong-resource" ? "another-user-resource" : `allocated-${op.id}`,
            resourceStopped: proof === "closed-owned-resource" || proof === "wrong-resource",
            noAllocation: proof === "contradictory-no-allocation",
          };
        },
        async read() {
          throw Error("unexpected");
        },
        async message() {
          throw Error("unexpected");
        },
        async stop() {
          throw Error("readonly reconciliation must not stop");
        },
      });
      const first = await children.launch(token, "ambiguous-allocation", selection);
      expect(first.state).toBe("uncertain");
      await expect(children.launch(token, "while-unknown", selection)).rejects.toThrow("Owner child policy");
      await children.reconcileOne();
      const state = (
        await sql.query<{ state: string }>("select state from orchestrator_child_operations where id=$1", [first.id])
      ).rows[0]?.state;
      expect(state).toBe(proof === "closed-owned-resource" ? "failed" : "uncertain");
      if (proof === "closed-owned-resource") {
        await children.launch(token, "after-confirmed-stop", selection);
        expect(allocations).toBe(2);
      } else {
        await expect(children.launch(token, "without-terminal-proof", selection)).rejects.toThrow("Owner child policy");
        expect(allocations).toBe(1);
      }
    } finally {
      await db.close();
    }
  });
}

test("registered failed child with confirmed stopped compute releases explicit capacity and does not block parent idle", async () => {
  const { db, sql, p, id, authority, token, selection } = await fixture();
  try {
    await configureOrchestratorLifecycle(sql, {
      key: "one-child-policy",
      orchestratorId: id,
      ownerId: p.owner,
      expectedRevision: 0,
      idleSeconds: 7200,
      maxActiveChildren: 1,
    });
    const boat = fakeBoat();
    const failedProvider = new Proxy(boat.provider, {
      get(target, key) {
        if (key === "exec")
          return async () => {
            throw Error("synthetic repository preparation failure");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let executionCalls = 0;
    const children = createOrchestratorChildren(sql, authority, {
      async launch(op, chosen) {
        if (++executionCalls > 1) {
          const { ChildLaunchNotAllocated } = await import("../src/orchestrator-child-launch.ts");
          throw new ChildLaunchNotAllocated("preallocation_rejected");
        }
        return launchOrchestratorChild({
          sql,
          provider: failedProvider,
          operation: op,
          selection: chosen,
          stores: {
            goldens: createSqlGoldenStore(sql),
            sandboxes: createSqlSandboxStore(sql),
            credentials: launchCredentials(createSqlVaultStore(sql), ENCRYPTION_KEY),
          },
          namedCredentials: launchCredentials(createSqlVaultStore(sql), ENCRYPTION_KEY),
        });
      },
      async reconcile(op) {
        const row = (
          await sql.query<{ provider_sandbox_id: string }>(
            "select provider_sandbox_id from orchestrator_child_operations where id=$1",
            [op.id],
          )
        ).rows[0];
        if (!row) throw Error("missing provider receipt");
        const info = await boat.provider.get(row.provider_sandbox_id);
        return {
          operationId: op.id,
          sandboxId: op.sandboxId,
          state: "failed",
          providerSandboxId: info.id,
          resourceStopped: info.state === "stopped",
        };
      },
      async read() {
        throw Error("unexpected");
      },
      async message() {
        throw Error("unexpected");
      },
      async stop() {
        throw Error("readonly proof only");
      },
    });
    const failed = await children.launch(token, "registered-child-fails", selection);
    expect(failed.state).toBe("uncertain");
    const { createSandboxLifecycle } = await import("../src/sandbox-lifecycle.ts");
    expect(await createSandboxLifecycle(sql, async () => boat.provider).reconcileOne()).toBe(true);
    const row = (
      await sql.query<{ status: string; stopped_at: Date | null; status_reason: string }>(
        "select status,stopped_at,status_reason from sandboxes where id=$1",
        [failed.sandboxId],
      )
    ).rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.stopped_at).not.toBeNull();
    const diagnostic = row?.status_reason;
    await children.reconcileOne();
    expect((await children.launch(token, "capacity-after-confirmed-closure", selection)).state).toBe("failed");
    expect(executionCalls).toBe(2);
    expect(boat.forks).toHaveLength(1);
    const { createOrchestratorLifecycle } = await import("../src/orchestrator-lifecycle.ts");
    const clock = (await sql.query<{ now: Date }>("select clock_timestamp() as now")).rows[0];
    if (!clock) throw Error("missing clock");
    let now = new Date(clock.now);
    let parentStops = 0;
    const worker = createOrchestratorLifecycle(
      sql,
      {
        async observe(machine) {
          return {
            ...machine,
            physicalGeneration: "synthetic-parent-native",
            state: "quiescent",
            evidence: "finished-parent-prompt",
          };
        },
        async stop(machine, _reason, operationId) {
          parentStops++;
          return {
            ...machine,
            physicalGeneration: machine.physicalGeneration ?? null,
            operationId,
            state: "stopped",
            continuity: "native",
          };
        },
        async reconcileStop() {
          throw Error("no uncertain parent stop");
        },
      },
      () => now,
    );
    await worker.reconcileOne();
    now = new Date(now.getTime() + 7_201_000);
    await worker.reconcileOne();
    expect(parentStops).toBe(1);
    expect(
      (
        await sql.query<{ status_reason: string }>("select status_reason from sandboxes where id=$1", [
          failed.sandboxId,
        ])
      ).rows[0]?.status_reason,
    ).toBe(diagnostic);
    expect(
      (await sql.query("select sandbox_id from orchestrator_children where sandbox_id=$1", [failed.sandboxId])).rows,
    ).toHaveLength(1);
  } finally {
    await db.close();
  }
});
