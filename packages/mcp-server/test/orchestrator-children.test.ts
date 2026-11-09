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
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { callOrchestrator } from "../src/orchestrator-api.ts";
import { launchOrchestratorChild } from "../src/orchestrator-child-launch.ts";
import { createOrchestratorChildren, type OrchestratorChildExecutor } from "../src/orchestrator-children.ts";
import { createLifecycleAwareOrchestratorRuntime } from "../src/orchestrator-lifecycle-integration.ts";
import { configureOrchestratorLifecycle } from "../src/orchestrator-lifecycle-settings.ts";
import { createOrchestratorWaits } from "../src/orchestrator-waits.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

async function fixture(
  parentState: "ready" | "running" = "running",
  accountKind: "anthropic" | "codex_auth" = "anthropic",
) {
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
      physicalGeneration: "synthetic-native-physical-663",
      lifecycleGeneration: String(parent.lifecycleGeneration),
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

test("production scoped MCP/API gateway uses epoch child authority and never owner dispatch", async () => {
  const { db, sql, p, id, parent, authority, token, selection } = await fixture("ready");
  const { ORCHESTRATOR_SCOPED_PATH, orchestratorScopedMcpUrl } = await import("../src/orchestrator-scoped-gateway.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { createOrchestratorServices } = await import("../src/orchestrator-services.ts");
  const boat = fakeBoat();
  const clients: InstanceType<typeof Client>[] = [];
  try {
    let reads = 0;
    const executor: OrchestratorChildExecutor = {
      async launch(op, chosen) {
        return launchOrchestratorChild({
          sql,
          provider: boat.provider,
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
      async read(sandboxId) {
        reads++;
        return (await sql.query("select id,status from sandboxes where id=$1", [sandboxId])).rows[0];
      },
      async message(op, text) {
        const child = (
          await sql.query<{ provider_sandbox_id: string; harness: "claude" | "codex" }>(
            "select provider_sandbox_id,harness from sandboxes where id=$1",
            [op.sandboxId],
          )
        ).rows[0];
        if (!child) throw Error("missing owned child");
        await boat.provider.prompt({ sandboxId: child.provider_sandbox_id, harness: child.harness, text });
      },
      async stop(op) {
        const child = (
          await sql.query<{ provider_sandbox_id: string }>("select provider_sandbox_id from sandboxes where id=$1", [
            op.sandboxId,
          ])
        ).rows[0];
        if (!child) throw Error("missing owned child");
        await boat.provider.stop({ sandboxId: child.provider_sandbox_id });
      },
      async reconcile(op) {
        return { operationId: op.id, sandboxId: op.sandboxId, state: "unknown" };
      },
    };
    const serviceInput: Parameters<typeof createOrchestratorServices>[1] = {
      scopedMcpUrl: orchestratorScopedMcpUrl("https://armada.example.com"),
      runtime: {
        authority,
        reserveOperation: reserveOrchestratorOperation,
        skillRevision: "78884de87066851b75e09cbda134606c0a8bc6d7",
        async resolveBackend() {
          throw Error("delegated token must never enter owner dispatcher");
        },
      },
      childAuthority: authority,
      childExecutor: executor,
      evidence: {
        async inspect() {
          throw Error("owner wait fallback forbidden");
        },
      },
      lifecycleRuntime: {
        async observe(machine) {
          return { ...machine, physicalGeneration: null, state: "unknown", evidence: "unused-worker" };
        },
        async stop() {
          throw Error("no parent lifecycle action in scopedtool test");
        },
        async reconcileStop() {
          throw Error("no parent lifecycle action");
        },
      },
    };
    const bundle = createOrchestratorServices(sql, serviceInput);
    expect(() =>
      createOrchestratorServices(sql, { ...serviceInput, scopedMcpUrl: "https://armada.example.com/mcp" }),
    ).toThrow("Scoped gateway path");
    const route = bundle.scopedToolsRoute;
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
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["launch", "message", "read", "stop"]);
    const launched = await client.callTool({
      name: "launch",
      arguments: { idempotencyKey: "mcp-child", selection: { ...selection, size: "small" } },
    });
    expect(launched.isError).not.toBe(true);
    const receipt = (
      launched.structuredContent as { result: { id: string; sandboxId: string; state: string } } | undefined
    )?.result;
    if (!receipt) throw new Error("Scoped launch receipt missing.");
    expect(receipt.state).toBe("succeeded");
    expect(boat.forks[0]?.size).toBe("small");
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
    expect(reads).toBe(1);
    expect(
      (
        await client.callTool({
          name: "message",
          arguments: {
            idempotencyKey: "mcp-child-message",
            sandboxId: receipt.sandboxId,
            text: "continue the same ticket",
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(boat.prompts).toHaveLength(1);
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
    expect((await api("launch", { selection: { ...selection, size: "small" } }, token, "mcp-child")).status).toBe(200);
    expect(boat.forks).toHaveLength(1);
    expect((await api("stop", { sandboxId: receipt.sandboxId }, token, "api-child-stop")).status).toBe(200);
    expect((await api("stop", { sandboxId: receipt.sandboxId }, token, "api-child-stop")).status).toBe(200);
    expect(boat.stops).toHaveLength(1);
    for (const method of ["exec", "credentials", "admin", "owner", "token_create"])
      expect((await api(method, {})).status).toBe(403);
    expect((await api("wait_record", { kind: "child", reference: receipt.sandboxId })).status).toBe(503);
    const denied = await api("read", { sandboxId: unrelated.id });
    expect(denied.status).toBe(403);
    expect((await denied.text()).includes(token)).toBe(false);
    expect(
      (
        await route(
          new Request(`https://armada.example.com${ORCHESTRATOR_SCOPED_PATH}/launch`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: "x".repeat(129 * 1024),
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
    expect(boat.forks).toHaveLength(1);
  } finally {
    for (const client of clients) await client.close();
    await db.close();
  }
});

test("production owner lifecycle routes authenticate settings/waits without promoting delegated epochs", async () => {
  const { db, sql, p, id, authority, token } = await fixture("ready");
  const { createMemoryAuthStore, generateToken, sha256Hex } = await import("@armada/auth");
  const { createOrchestratorServices } = await import("../src/orchestrator-services.ts");
  const { orchestratorScopedMcpUrl } = await import("../src/orchestrator-scoped-gateway.ts");
  try {
    const auth = createMemoryAuthStore();
    const ownerToken = generateToken("service"),
      adminToken = generateToken("service");
    for (const [userId, secret, role] of [
      [p.owner, ownerToken, "member"],
      [p.admin, adminToken, "admin"],
    ] as const) {
      auth.addMembership(userId, { orgId: p.org, name: "fixture", role });
      await auth.insertToken("service", {
        userId,
        orgId: p.org,
        hash: await sha256Hex(secret),
        label: "fixture",
        createdAt: new Date().toISOString(),
      });
    }
    let completed = false,
      evidenceReads = 0;
    const bundle = createOrchestratorServices(sql, {
      scopedMcpUrl: orchestratorScopedMcpUrl("https://armada.example.com"),
      runtime: {
        authority,
        reserveOperation: reserveOrchestratorOperation,
        skillRevision: "79472bf3f68f83ab53692a6655c484c9f9431a23",
        async resolveBackend() {
          throw Error("settings/history must not activate provider");
        },
      },
      childAuthority: authority,
      childExecutor: {
        async launch() {
          throw Error("unexpected allocation");
        },
        async read() {
          throw Error("unexpected child read");
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
      },
      lifecycleRuntime: {
        async observe(machine) {
          return { ...machine, physicalGeneration: null, state: "unknown", evidence: "unused" };
        },
        async stop() {
          throw Error("unexpected parent stop");
        },
        async reconcileStop() {
          throw Error("unexpected");
        },
      },
      evidence: {
        async inspect(input) {
          evidenceReads++;
          const clock = (await sql.query<{ now: Date }>("select clock_timestamp() as now")).rows[0];
          if (!clock) throw Error("clock");
          return {
            ...input,
            identity: `approved-ci-event-${evidenceReads}`,
            at: new Date(clock.now),
            state: input.reference === "ci:approved-run" ? (completed ? "complete" : "active") : "unknown",
          };
        },
      },
    });
    const route = bundle.ownerLifecycleRoute({
      authStore: auth,
      supabase: {
        supabaseUrl: "https://supabase.example.com",
        anonKey: "test-anon",
        async fetch() {
          throw Error("service token route must not use browser OAuth");
        },
      },
    });
    const request = async (path: string, secret = ownerToken, payload?: unknown, key?: string) =>
      (await route(
        new Request(
          `https://armada.example.com/api/v1/orchestrators/${id}/${path}${payload === undefined ? `?orgId=${p.org}` : ""}`,
          {
            method: payload === undefined ? "GET" : "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
              ...(key ? { "idempotency-key": key } : {}),
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          },
        ),
      )) ?? new Response(null, { status: 404 });
    expect((await request("settings", token)).status).toBe(401);
    expect((await request("settings", adminToken)).status).toBe(404);
    const policy = { orgId: p.org, expectedRevision: 0, idleSeconds: 900, maxActiveChildren: null };
    expect((await request("settings", ownerToken, policy, "settings-key")).status).toBe(200);
    expect((await request("settings", ownerToken, policy, "settings-key")).status).toBe(200);
    expect(await (await request("settings")).json()).toMatchObject({
      version: 1,
      revision: 1,
      idleSeconds: 900,
      maxActiveChildren: null,
    });
    expect((await request("settings", ownerToken, { ...policy, idleSeconds: 901 }, "settings-key")).status).toBe(409);
    expect(
      (await request("settings", ownerToken, { ...policy, expectedRevision: 1, ownerId: p.owner }, "owner-smuggle"))
        .status,
    ).toBe(400);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const waitInput = {
      orgId: p.org,
      expectedRevision: 1,
      kind: "ci",
      reference: "ci:approved-run",
      reason: "CI verified by registered source",
      expiresAt,
    };
    const created = await request("waits", ownerToken, waitInput, "wait-register");
    expect(created.status).toBe(201);
    const lease = (await created.json()) as { id: string; released: boolean };
    expect(lease.released).toBe(false);
    expect((await request("waits", token, waitInput, "guest-wait")).status).toBe(401);
    expect(evidenceReads).toBe(1);
    expect(await (await request("waits")).json()).toMatchObject({
      version: 1,
      waits: [{ id: lease.id, reference: "ci:approved-run" }],
    });
    const renewalInput = { orgId: p.org, expectedRevision: 2, expiresAt };
    const renewed = await request(`waits/${lease.id}/renew`, ownerToken, renewalInput, "wait-renew");
    expect(renewed.status).toBe(201);
    const renewedReceipt = await renewed.json();
    expect(
      (
        await request(
          "waits",
          ownerToken,
          { ...waitInput, expectedRevision: 3, reason: "New verified CI reason" },
          "wait-reason",
        )
      ).status,
    ).toBe(201);
    const readsBeforeRetry = evidenceReads;
    const replay = await request(`waits/${lease.id}/renew`, ownerToken, renewalInput, "wait-renew");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(renewedReceipt);
    expect(evidenceReads).toBe(readsBeforeRetry);
    expect(
      (await request(`waits/${lease.id}/renew`, ownerToken, { ...renewalInput, expectedRevision: 3 }, "wait-renew"))
        .status,
    ).toBe(409);
    const releaseInput = { orgId: p.org, expectedRevision: 4 };
    expect((await request(`waits/${lease.id}/release`, ownerToken, releaseInput, "wait-release")).status).toBe(409);
    completed = true;
    expect((await request(`waits/${lease.id}/release`, ownerToken, releaseInput, "wait-release")).status).toBe(200);
    expect((await request(`waits/${lease.id}/release`, ownerToken, releaseInput, "wait-release")).status).toBe(200);
    expect(await (await request("waits")).json()).toMatchObject({ version: 1, waits: [] });
    expect(
      (await sql.query<{ revision: number }>("select revision from orchestrators where id=$1", [id])).rows[0]?.revision,
    ).toBe(5);
    await sql.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect((await request("settings")).status).toBe(404); // SQL membership recheck, even if auth cache fixture still lists it.
  } finally {
    await db.close();
  }
});

test("delegated native child preserves actual ownership admission and fails busy before allocation", async () => {
  const { db, sql, p, parent, authority, token, selection } = await fixture("ready", "codex_auth");
  try {
    const ownership = createModelAuthOwnership(sql, ENCRYPTION_KEY);
    await ownership.claim({ userId: p.owner, orgId: p.org, role: "member" }, selection.credentialId, 1, parent.id);
    await sql.query("update sandboxes set credential_id=$2,credential_version=1 where id=$1", [
      parent.id,
      selection.credentialId,
    ]);
    const credentials = launchCredentials(createSqlVaultStore(sql), ENCRYPTION_KEY, undefined, ownership);
    const boat = fakeBoat();
    const children = createOrchestratorChildren(sql, authority, {
      launch: (operation, selected) =>
        launchOrchestratorChild({
          sql,
          provider: boat.provider,
          operation,
          selection: selected,
          stores: { goldens: createSqlGoldenStore(sql), sandboxes: createSqlSandboxStore(sql), credentials },
          namedCredentials: credentials,
        }),
      async message() {
        throw Error("unexpected message");
      },
      async stop() {
        throw Error("unexpected stop");
      },
      async read() {
        throw Error("unexpected read");
      },
      async reconcile(operation) {
        return { operationId: operation.id, sandboxId: operation.sandboxId, state: "unknown" };
      },
    });
    const result = await children.launch(token, "native-parent-account-busy", {
      ...selection,
      harness: "codex",
      model: "gpt-6.1-sol",
    });
    expect(result.state).toBe("failed");
    expect(boat.forks).toHaveLength(0);
    expect(
      (
        await sql.query("select state,error_code,provider_sandbox_id from orchestrator_child_operations where id=$1", [
          result.id,
        ])
      ).rows,
    ).toEqual([{ state: "failed", error_code: "child_preallocation_rejected", provider_sandbox_id: null }]);
    expect(
      (await sql.query("select sandbox_id from model_auth_ownership where account_id=$1", [selection.credentialId]))
        .rows,
    ).toEqual([{ sandbox_id: parent.id }]);
  } finally {
    await db.close();
  }
});
