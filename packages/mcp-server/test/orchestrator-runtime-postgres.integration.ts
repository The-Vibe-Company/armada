// Explicit opt-in, disposable nonproduction database migrated with actual #661 + #662.
import { expect, test } from "bun:test";
import * as foundation from "@armada/core/server";
import { SQL } from "bun";
import type { OrchestratorRuntimeFoundation } from "../src/orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { sqlOver } from "../src/sql.ts";

const url = process.env.ARMADA_TEST_POSTGRES_URL;
if (!url) throw Error("Explicit disposable ARMADA_TEST_POSTGRES_URL required.");
if (!("reserveOrchestratorOperation" in foundation) || typeof foundation.reserveOrchestratorOperation !== "function")
  throw Error("Actual #661 producer required.");
const reserve = foundation.reserveOrchestratorOperation as OrchestratorRuntimeFoundation["reserveOperation"];

test("PostgreSQL publication holds physical generation through receipt commit", async () => {
  const a = new SQL(url, { max: 1 }),
    b = new SQL(url, { max: 1 }),
    monitor = new SQL(url, { max: 1 });
  const sql = sqlOver({
    unsafe: (q, v) => a.unsafe(q, v),
    begin: (work) => a.begin((tx) => work({ unsafe: (q, v) => tx.unsafe(q, v) })),
  });
  const store = new OrchestratorRuntimeStore(sql, reserve);
  const owner = crypto.randomUUID(),
    org = crypto.randomUUID(),
    golden = crypto.randomUUID(),
    sandboxId = crypto.randomUUID();
  let parent: string | undefined;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let paused: () => void = () => {};
  const ready = new Promise<void>((r) => {
    paused = r;
  });
  let publication: Promise<boolean> | undefined, advancement: Promise<unknown> | undefined;
  try {
    await a.unsafe("insert into auth.users(id) values($1)", [owner]);
    await a.unsafe("insert into orgs(id,name) values($1,'runtime-race')", [org]);
    await a.unsafe("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, owner]);
    await a.unsafe(
      "insert into goldens(id,org_id,name,visibility,owner_id,config) values($1,$2,'runtime-race','private',$3,'{\"repos\":[],\"init\":[]}'::jsonb)",
      [golden, org, owner],
    );
    const created = await store.create({
      ownerId: owner,
      configuration: {
        version: 1,
        orgId: org,
        name: "race",
        goldenId: golden,
        provider: "boat",
        harness: "claude",
        model: "m",
        modelAccountId: crypto.randomUUID(),
      },
      key: "create",
      skillRevision: "a".repeat(40),
    });
    parent = created.identity.id;
    await foundation.createSqlSandboxStore(sql).insert({
      id: sandboxId,
      provider: "boat",
      providerSandboxId: `runtime-${sandboxId}`,
      goldenId: golden,
      orgId: org,
      ownerId: owner,
      harness: "claude",
      model: "m",
      reasoningEffort: "high",
      status: "running",
      visibility: "private",
    });
    await a.unsafe("update orchestrators set sandbox_id=$2 where id=$1", [parent, sandboxId]);
    created.identity = await store.preparing(created);
    await store.complete(created, { state: "succeeded" });
    const message = await store.reserve({
      ownerId: owner,
      orgId: org,
      id: parent,
      action: "message",
      key: "message",
      expectedRevision: 1,
      payload: { text: "continue" },
    });
    const fenced = new OrchestratorRuntimeStore(
      {
        ...sql,
        transaction: (work) => {
          if (!sql.transaction) throw Error("transaction required");
          return sql.transaction((tx) =>
            work({
              query: async (q, v) => {
                if (q.startsWith("update public.orchestrator_operations")) {
                  paused();
                  await gate;
                }
                return tx.query(q, v);
              },
            }),
          );
        },
      },
      reserve,
    );
    publication = fenced.complete(message, { state: "succeeded" });
    await ready;
    const pid = Number((await b.unsafe("select pg_backend_pid() as pid"))[0].pid);
    advancement = b
      .unsafe("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [sandboxId])
      .then((rows) => rows);
    let blocked = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const rows = await monitor.unsafe("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]);
      if (rows[0].blocked) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    release();
    expect(await publication).toBe(true);
    await advancement;
  } finally {
    release();
    await Promise.allSettled([publication, advancement].filter(Boolean));
    if (parent) {
      await a.unsafe("delete from orchestrator_runtime_events where orchestrator_id=$1", [parent]);
      await a.unsafe("delete from orchestrator_runtime_create_keys where orchestrator_id=$1", [parent]);
      await a.unsafe("delete from orchestrator_runtime where orchestrator_id=$1", [parent]);
      await a.unsafe("delete from orchestrator_operations where orchestrator_id=$1", [parent]);
      await a.unsafe("delete from orchestrators where id=$1", [parent]);
    }
    await a.unsafe("delete from sandboxes where id=$1", [sandboxId]);
    await a.unsafe("delete from goldens where id=$1", [golden]);
    await a.unsafe("delete from members where org_id=$1", [org]);
    await a.unsafe("delete from orgs where id=$1", [org]);
    await a.unsafe("delete from auth.users where id=$1", [owner]);
    await Promise.all([a.close(), b.close(), monitor.close()]);
  }
});
