import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  DelegatedAuthority,
  encryptSecret,
  type Sql,
} from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { launchSandboxChild } from "../src/sandbox-access-child-launch.ts";
import { createSandboxChildren, type SandboxChildExecutor } from "../src/sandbox-access-children.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(
  parentState: "ready" | "running" = "running",
  accountKind: "anthropic" | "codex_auth" = "anthropic",
  { isolated = false } = {},
) {
  const { db, people: p } = await (isolated ? database() : sharedDatabase());
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
      if (isolated) await db.close();
    },
  };
}

test("delegated child reservation precedes ambiguous allocation and retries cannot allocate twice", async () => {
  const { close, db, sql, p, parent, authority, token, selection } = await fixture();
  try {
    let allocations = 0;
    const executor: SandboxChildExecutor = {
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
    const children = createSandboxChildren(sql, authority, executor);
    const first = await children.launch(token, "ticket-663", selection);
    expect(first.state).toBe("uncertain");
    // Persisted no-skill receipts must remain replayable across the skills rollout.
    const legacyDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "launch",
          [
            selection.goldenId,
            selection.harness,
            selection.credentialId,
            selection.credentialVersion,
            selection.model,
            null,
            null,
            null,
            null,
          ],
        ]),
      )
      .digest("hex");
    expect(
      (
        await db.query<{ request_digest: string }>(
          "select request_digest from orchestrator_child_operations where id=$1",
          [first.id],
        )
      ).rows[0]?.request_digest,
    ).toBe(legacyDigest);
    expect(await children.launch(token, "ticket-663", { ...selection, skills: [] })).toEqual(first);

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
    await close();
  }
});

test("own children support independent target receipts while unrelated children remain denied", async () => {
  const { close, db, sql, p, parent, id, authority, token, selection } = await fixture();
  try {
    const boat = fakeBoat();
    const messages: string[] = [];
    const stopped: string[] = [];
    const executor: SandboxChildExecutor = {
      async launch(op, selected) {
        return launchSandboxChild({
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
    const children = createSandboxChildren(sql, authority, executor);
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
    await close();
  }
});

test("revocation between reservation and dispatch cancels queued allocation", async () => {
  const { close, sql, id, authority, token, selection } = await fixture();
  try {
    let admissions = 0,
      allocations = 0;
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
    await close();
  }
});

test("missing actual named-account schema fails before fork without an uncertain allocation reservation", async () => {
  const { close, db, sql, authority, token, selection } = await fixture("running", "anthropic", { isolated: true });
  try {
    const boat = fakeBoat();
    // Simulate a deployment missing the actual producer202 column, not a second account schema.
    await db.exec("alter table sandboxes drop column credential_id");
    const children = createSandboxChildren(sql, authority, {
      async launch(operation, selected) {
        return launchSandboxChild({
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

for (const outcome of ["direct-success", "direct-failed", "discovery-success"] as const) {
  test(`child terminal receipt is not downgraded by delayed ${outcome} publication`, async () => {
    const { close, db, sql, p, authority, token, selection, golden } = await fixture();
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
    const discoverReply = deferred<Awaited<ReturnType<SandboxChildExecutor["reconcile"]>>>();
    let op: Parameters<SandboxChildExecutor["launch"]>[0] | undefined;
    let launch: ReturnType<ReturnType<typeof createSandboxChildren>["launch"]> | undefined;
    let reconcile: Promise<boolean> | undefined;
    try {
      const children = createSandboxChildren(sql, authority, {
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
      launch = children.launch(token, "terminal-race", selection);
      await entered.promise;
      reconcile = children.reconcileOne();
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
          const { ChildLaunchNotAllocated } = await import("../src/sandbox-access-child-launch.ts");
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
      if (op) discoverReply.resolve({ operationId: op.id, sandboxId: op.sandboxId, state: "unknown" });
      await Promise.allSettled([launch, reconcile]);
      await close();
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
    const { close, sql, id, authority, token, selection } = await fixture();
    try {
      await sql.query(
        "insert into orchestrator_lifecycle(orchestrator_id,max_active_children) values($1,1) on conflict(orchestrator_id) do update set max_active_children=1",
        [id],
      );
      let allocations = 0;
      const children = createSandboxChildren(sql, authority, {
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
      await close();
    }
  });
}

test("production scoped MCP/API gateway uses epoch child authority and never owner dispatch", async () => {
  const { close, sql, p, id, parent, authority, token, selection } = await fixture("ready");
  const { ORCHESTRATOR_SCOPED_PATH } = await import("../src/sandbox-access-scoped-gateway.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { createSandboxScopedGateway } = await import("../src/sandbox-access-scoped-gateway.ts");
  const boat = fakeBoat();
  const clients: InstanceType<typeof Client>[] = [];
  try {
    let reads = 0;
    const executor: SandboxChildExecutor = {
      async launch(op, chosen) {
        return launchSandboxChild({
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
    const route = createSandboxScopedGateway(createSandboxChildren(sql, authority, executor));
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
    await close();
  }
});

test("registered failed child with confirmed stopped compute releases explicit capacity", async () => {
  const { close, sql, id, authority, token, selection } = await fixture();
  try {
    await sql.query(
      "insert into orchestrator_lifecycle(orchestrator_id,max_active_children) values($1,1) on conflict(orchestrator_id) do update set max_active_children=1",
      [id],
    );
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
    const children = createSandboxChildren(sql, authority, {
      async launch(op, chosen) {
        if (++executionCalls > 1) {
          const { ChildLaunchNotAllocated } = await import("../src/sandbox-access-child-launch.ts");
          throw new ChildLaunchNotAllocated("preallocation_rejected");
        }
        return launchSandboxChild({
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
    await children.reconcileOne();
    expect((await children.launch(token, "capacity-after-confirmed-closure", selection)).state).toBe("failed");
    expect(executionCalls).toBe(2);
    expect(boat.forks).toHaveLength(1);
  } finally {
    await close();
  }
});
