import { expect, test } from "bun:test";
import { resolveMachineSize } from "@armada/core";
import { DelegatedAuthority, DelegatedAuthorityDenied, encryptSecret, type Sql } from "@armada/core/server";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import { admitModalLaunch } from "../src/jobs/modal-launch.ts";
import { childLaunchAuthorized } from "../src/sandbox-access-child-launch.ts";
import { createSandboxChildren } from "../src/sandbox-access-children.ts";
import { bunSql } from "../src/sql.ts";

const url = process.env.ARMADA_TEST_POSTGRES_URL;
if (!url) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

const key = Buffer.alloc(32, 7).toString("base64");

async function seedScopedParent(sql: Sql) {
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const golden = crypto.randomUUID();
  const parent = crypto.randomUUID();
  const account = crypto.randomUUID();
  await sql.transaction!(async (tx) => {
    await tx.query("insert into auth.users(id) values($1)", [owner]);
    await tx.query("insert into orgs(id,name) values($1::uuid,$1::text)", [org]);
    await tx.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
    await tx.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,config)
        values($1::uuid,$2,$3,$1::text,'private','boat',$1::text,'{"repos":[{"url":"https://example.com/repo.git","branch":"main","dir":"repo"}],"init":[]}')`,
      [golden, org, owner],
    );
    await tx.query("insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)", [
      account,
      owner,
      await encryptSecret("fixture", key),
    ]);
    await insertSandboxFixture(tx, {
      id: parent,
      orgId: org,
      ownerId: owner,
      goldenId: golden,
      provider: "boat",
      providerSandboxId: parent,
      visibility: "private",
      harness: "codex",
      model: "fixture",
      reasoningEffort: "high",
      status: "ready",
      credentialId: account,
      credentialVersion: 1,
    });
    await tx.query(
      `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state)
       values($1,'sandbox',$2,$3,$1,'ready')`,
      [parent, org, owner],
    );
  });
  const authority = new DelegatedAuthority(sql, async () => {});
  let token = "";
  await authority.installEpoch(
    parent,
    {
      physicalGeneration: "fixture-generation",
      lifecycleGeneration: "1",
      async deliver(secret) {
        token = secret;
        return { acknowledged: true };
      },
      async scrub() {},
    },
    { scopes: ["worker:launch", "worker:message"], goldenIds: [golden], credentialIds: [account] },
  );
  return { owner, org, golden, parent, account, token };
}

async function seedLaunchReceipt(sql: Sql, parent: string, child: string, state: "pending" | "succeeded") {
  const id = crypto.randomUUID();
  const {
    rows: [fence],
  } = await sql.query<{ parent_generation: string; parent_epoch: string }>(
    `insert into orchestrator_child_operations
      (id,orchestrator_id,org_id,owner_id,parent_generation,parent_epoch,action,target_id,scope_target,
       idempotency_key,request_digest,state,dispatched_at)
      select $1,id,org_id,owner_id,generation,authority_epoch,'launch',$2,id,'launch-fixture',$3,$4,now()
      from armada_access_parents where id=$5 returning parent_generation::text,parent_epoch::text`,
    [id, child, "a".repeat(64), state, parent],
  );
  if (!fence) throw new Error("Missing child launch fence.");
  return { id, parentGeneration: fence.parent_generation, parentEpoch: fence.parent_epoch };
}

function observeTransactions(sql: Sql, beforeQuery: (statement: string, params?: unknown[]) => void) {
  return {
    ...sql,
    transaction: (work) =>
      sql.transaction!(async (tx) => {
        await tx.query("set local deadlock_timeout = '10ms'");
        return work({
          ...tx,
          async query(statement, params) {
            beforeQuery(statement, params);
            return tx.query(statement, params);
          },
        });
      }),
  } satisfies Sql;
}

test("scoped message can reserve and dispatch while its child's launch worker revalidates the parent", async () => {
  const sql = bunSql(url);
  try {
    const { parent, org, owner, golden, token } = await seedScopedParent(sql);
    const child = crypto.randomUUID();
    await insertSandboxFixture(sql, {
      id: child,
      orgId: org,
      ownerId: owner,
      goldenId: golden,
      provider: "boat",
      providerSandboxId: child,
      visibility: "private",
      harness: "codex",
      model: "fixture",
      reasoningEffort: "high",
      status: "ready",
    });
    await sql.query(
      "insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)",
      [child, parent, org, owner],
    );
    const { id: launch } = await seedLaunchReceipt(sql, parent, child, "succeeded");
    const { promise: childLocked, resolve: lockChild } = Promise.withResolvers<void>();
    const { promise: beforeChildLookup, resolve: checkParent } = Promise.withResolvers<void>();
    let childLookups = 0;
    const admissionSql = observeTransactions(sql, (statement, params) => {
      if (params?.[1] === child && statement.includes("for ")) {
        childLookups++;
        checkParent();
      }
    });
    const authority = new DelegatedAuthority(admissionSql, async () => {});
    let sends = 0;
    const children = createSandboxChildren(admissionSql, authority, {
      async launch() {},
      async read() {},
      async reconcile(operation) {
        return { operationId: operation.id, sandboxId: operation.sandboxId, state: "unknown" };
      },
      async stop() {},
      async message() {
        sends++;
      },
    });
    const worker = sql.transaction!(async (tx) => {
      await tx.query("set local deadlock_timeout = '10ms'");
      await tx.query("select id from sandboxes where id=$1 for update", [child]);
      lockChild();
      await beforeChildLookup;
      expect(await childLaunchAuthorized(tx, child, launch)).toBe(true);
    });
    const message = childLocked
      .then(() => children.message(token, "message-fixture", child, "next prompt"))
      .finally(checkParent);
    const results = await Promise.allSettled([worker, message]);
    expect(results).toEqual([
      { status: "fulfilled", value: undefined },
      {
        status: "fulfilled",
        value: expect.objectContaining({ state: "succeeded", sandboxId: child }),
      },
    ]);
    expect(childLookups).toBe(2);
    expect(sends).toBe(1);
  } finally {
    await sql.close();
  }
});

test("scoped launch allocates while a parent turn settles on the same account", async () => {
  const sql = bunSql(url);
  try {
    const { parent, org, owner, golden, account } = await seedScopedParent(sql);
    const sandboxId = crypto.randomUUID();
    const receipt = await seedLaunchReceipt(sql, parent, sandboxId, "pending");
    const { promise: accountLocked, resolve: lockAccount } = Promise.withResolvers<void>();
    const { promise: beforeAccountLookup, resolve: checkSandbox } = Promise.withResolvers<void>();
    const admissionSql = observeTransactions(sql, (statement, params) => {
      if (params?.[0] === account && statement.includes("for update of c")) checkSandbox();
    });
    const turn = sql.transaction!(async (tx) => {
      await tx.query("set local deadlock_timeout = '10ms'");
      await tx.query("select id from credentials where id=$1 for update", [account]);
      lockAccount();
      await beforeAccountLookup;
      await tx.query("select id from sandboxes where id=$1 for update", [parent]);
    });
    const child = accountLocked
      .then(() =>
        admitModalLaunch(
          admissionSql,
          key,
          {
            boat: { scope: "org", backendId: "fixture" },
            child: { ...receipt, sandboxId, action: "launch", orgId: org, ownerId: owner, orchestratorId: parent },
            orgId: org,
            ownerId: owner,
            sandbox: {
              goldenId: golden,
              harness: "codex",
              model: "fixture",
              reasoningEffort: "high",
              credentialId: account,
              credentialVersion: 1,
              effectiveTtlSeconds: 3600,
              machineSize: resolveMachineSize("boat", "small", null),
            },
            allocation: { source: { kind: "snapshot", ref: golden }, computeTtlSeconds: 3600 },
            deadline: new Date(Date.now() + 60_000),
            maxAttempts: 3,
          },
          { async bindLaunch() {} },
        ),
      )
      .finally(checkSandbox);
    const results = await Promise.allSettled([turn, child]);
    expect(results).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: { sandbox: { id: sandboxId, status: "starting" } } },
    ]);
  } finally {
    await sql.close();
  }
});

test("scoped launch admission refuses a grant that expires after the transaction starts", async () => {
  const sql = bunSql(url);
  try {
    const { parent, golden, account, token } = await seedScopedParent(sql);
    const expiring: Sql = {
      ...sql,
      transaction: (work) =>
        sql.transaction!((tx) =>
          work({
            ...tx,
            async query<T>(statement: string, params?: unknown[]) {
              if (params?.[0] === parent && statement.includes("from public.sandboxes where id=$1 for no key update"))
                await tx.query(
                  "update orchestrator_delegations set expires_at=clock_timestamp() where orchestrator_id=$1",
                  [parent],
                );
              return tx.query<T>(statement, params);
            },
          }),
        ),
    };
    const authority = new DelegatedAuthority(expiring, async () => {});
    await expect(
      authority.admit(
        token,
        { method: "launch", goldenId: golden, credentialId: account, credentialVersion: 1, harness: "codex" },
        async () => "reserved",
      ),
    ).rejects.toBeInstanceOf(DelegatedAuthorityDenied);
  } finally {
    await sql.close();
  }
});
