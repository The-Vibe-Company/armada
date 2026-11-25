import { expect, test } from "bun:test";
import { DelegatedAuthority, type Sql } from "@armada/core/server";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import { childLaunchAuthorized } from "../src/sandbox-access-child-launch.ts";
import { createSandboxChildren } from "../src/sandbox-access-children.ts";
import { bunSql } from "../src/sql.ts";

const url = process.env.ARMADA_TEST_POSTGRES_URL;
if (!url) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

test("scoped message can reserve and dispatch while its child's launch worker revalidates the parent", async () => {
  const sql = bunSql(url);
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const golden = crypto.randomUUID();
  const parent = crypto.randomUUID();
  const child = crypto.randomUUID();
  const launch = crypto.randomUUID();
  try {
    await sql.transaction!(async (tx) => {
      await tx.query("insert into auth.users(id) values($1)", [owner]);
      await tx.query("insert into orgs(id,name) values($1::uuid,$1::text)", [org]);
      await tx.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
      await tx.query(
        `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,config)
          values($1::uuid,$2,$3,$1::text,'private','boat',$1::text,'{}')`,
        [golden, org, owner],
      );
      for (const id of [parent, child]) {
        await insertSandboxFixture(tx, {
          id,
          orgId: org,
          ownerId: owner,
          goldenId: golden,
          provider: "boat",
          providerSandboxId: id,
          visibility: "private",
          harness: "codex",
          model: "fixture",
          reasoningEffort: "high",
          status: "ready",
        });
      }
      await tx.query(
        `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state)
         values($1,'sandbox',$2,$3,$1,'ready')`,
        [parent, org, owner],
      );
      await tx.query(
        `insert into orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id) values($1,$2,$3,$4)`,
        [child, parent, org, owner],
      );
    });
    const { promise: childLocked, resolve: lockChild } = Promise.withResolvers<void>();
    const { promise: beforeChildLookup, resolve: checkParent } = Promise.withResolvers<void>();
    let childLookups = 0;
    const admissionSql: Sql = {
      ...sql,
      transaction: (work) =>
        sql.transaction!(async (tx) => {
          await tx.query("set local deadlock_timeout = '10ms'");
          return work({
            ...tx,
            async query(statement, params) {
              if (params?.[1] === child && statement.includes("for ")) {
                childLookups++;
                checkParent();
              }
              return tx.query(statement, params);
            },
          });
        }),
    };
    const authority = new DelegatedAuthority(admissionSql, async () => {});
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
      { scopes: ["worker:launch", "worker:message"], goldenIds: [], credentialIds: [] },
    );
    await sql.query(
      `insert into orchestrator_child_operations
        (id,orchestrator_id,org_id,owner_id,parent_generation,parent_epoch,action,target_id,scope_target,
         idempotency_key,request_digest,state,dispatched_at)
        select $1,id,org_id,owner_id,generation,authority_epoch,'launch',$2,id,'launch-fixture',$3,'succeeded',now()
        from armada_access_parents where id=$4`,
      [launch, child, "a".repeat(64), parent],
    );
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
