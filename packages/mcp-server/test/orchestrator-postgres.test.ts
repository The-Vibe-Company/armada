import { expect, test } from "bun:test";
import { reserveOrchestratorOperation } from "@armada/core/server";
import { SQL } from "bun";
import { sqlOver } from "../src/sql.ts";

// CI supplies an already migrated disposable database. Never point this at production.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!url)("PostgreSQL concurrent receipt reservations serialize on the parent revision", async () => {
  const a = new SQL(url ?? "", { max: 1 });
  const b = new SQL(url ?? "", { max: 1 });
  const monitor = new SQL(url ?? "", { max: 1 });
  const owner = crypto.randomUUID(),
    org = crypto.randomUUID(),
    parent = crypto.randomUUID();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reserved: () => void = () => {};
  const ready = new Promise<void>((r) => {
    reserved = r;
  });
  try {
    await a.unsafe("insert into auth.users(id) values($1)", [owner]);
    await a.unsafe("insert into orgs(id,name) values($1,'orchestrator-race')", [org]);
    await a.unsafe("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, owner]);
    await a.unsafe("insert into orchestrators(id,org_id,owner_id) values($1,$2,$3)", [parent, org, owner]);
    const pid = Number((await b.unsafe("select pg_backend_pid() as pid"))[0].pid);
    const input = {
      orchestratorId: parent,
      actorId: owner,
      action: "message" as const,
      key: "first",
      digest: "a".repeat(64),
      expectedRevision: 0,
    };
    const first = a.begin(async (tx) => {
      const sql = sqlOver({ unsafe: (q, v) => tx.unsafe(q, v) });
      const receipt = await reserveOrchestratorOperation({ ...sql, transaction: (work) => work(sql) }, input);
      reserved();
      await gate;
      return receipt;
    });
    await ready;
    const second = reserveOrchestratorOperation(
      sqlOver({
        unsafe: (q, v) => b.unsafe(q, v),
        begin: (work) => b.begin((tx) => work({ unsafe: (q, v) => tx.unsafe(q, v) })),
      }),
      { ...input, key: "second" },
    ).then(
      () => "unexpected success",
      (error) => error.message,
    );
    // Observe an actual backend lock waiter, not a sleep or serial in-memory transaction queue.
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
    expect((await first).revision).toBe(1);
    expect(await second).toBe("Stale orchestrator revision.");
  } finally {
    release();
    await a.unsafe("delete from orchestrator_operations where orchestrator_id=$1", [parent]);
    await a.unsafe("delete from orchestrators where id=$1", [parent]);
    await a.unsafe("delete from members where org_id=$1", [org]);
    await a.unsafe("delete from orgs where id=$1", [org]);
    await a.unsafe("delete from auth.users where id=$1", [owner]);
    await Promise.all([a.close(), b.close(), monitor.close()]);
  }
});
