// This contract must never silently skip in release validation.
if (!process.env.ARMADA_TEST_POSTGRES_URL) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@armada/agent-runtime";
import { sha256Hex } from "@armada/auth";
import { SQL } from "bun";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "../src/runtime-enrolment.ts";
import { sqlOver } from "../src/sql.ts";

// Release validation supplies an already migrated disposable database.
const url = process.env.ARMADA_TEST_POSTGRES_URL ?? "";

function authority(connection: SQL, failOnLockConflict = false) {
  return createRuntimeEnrolments(
    sqlOver({
      unsafe: (q, v) => connection.unsafe(q, v),
      begin: (work) =>
        connection.begin((tx) =>
          work({
            unsafe: (q, v) =>
              tx.unsafe(
                failOnLockConflict && /\bfor (?:no key update|update|key share|share)(?: of \w+)?$/i.test(q)
                  ? `${q} nowait`
                  : q,
                v,
              ),
          }),
        ),
    }),
    Buffer.alloc(32, 9).toString("base64"),
  );
}

test("runtime sessions share an owner's membership fence and conflict with role changes and removal", async () => {
  const admin = new SQL(url, { max: 1 });
  const runtime = new SQL(url, { max: 1 });
  const peer = new SQL(url, { max: 1 });
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const golden = crypto.randomUUID();
  const sandboxes: [string, string] = [crypto.randomUUID(), crypto.randomUUID()];
  const service = authority(runtime);
  const other = authority(peer, true);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let held: Promise<void> | undefined;
  let admission: Promise<unknown> | undefined;
  try {
    await admin.unsafe("insert into auth.users(id) values($1)", [owner]);
    await admin.unsafe("insert into orgs(id,name) values($1,'runtime-lock-race')", [org]);
    await admin.unsafe("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, owner]);
    await admin.unsafe(
      "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'runtime-lock-race','private','{}')",
      [golden, org, owner],
    );
    const sessions = [];
    for (const sandbox of sandboxes) {
      await admin.unsafe(
        "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status) values($1,$2,$3,$4,$5,'codex','ready')",
        [sandbox, golden, org, owner, `race-${sandbox}`],
      );
      const runtimeToken = `armada_runtime_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
      await admin.unsafe(
        `insert into runtime_enrolments(sandbox_id,lifecycle_generation,epoch,runtime_hash,runtime_protocol_version)
         select id,lifecycle_generation,1,$2,$3 from sandboxes where id=$1`,
        [sandbox, await sha256Hex(runtimeToken), PROTOCOL_VERSION],
      );
      sessions.push(runtimeToken);
    }
    const [first, second] = sessions;
    if (!first || !second) throw new Error("expected two enrolled runtimes");
    held = service.withSession(first, "1", async () => {
      entered.resolve();
      await finish.promise;
    });
    await Promise.race([entered.promise, held]);
    const admitPeer = () => other.withSession(second, "1", async (_tx, scope) => scope.sandboxId);
    expect(await admitPeer()).toBe(sandboxes[1]);
    finish.resolve();
    await held;

    await admin.begin(async (tx) => {
      await tx.unsafe("savepoint role_edit");
      await tx.unsafe("update members set role='admin' where org_id=$1 and user_id=$2", [org, owner]);
      await expect(admitPeer()).rejects.toMatchObject({ errno: "55P03" });
      await tx.unsafe("rollback to savepoint role_edit");
    });
    const pid = Number((await peer.unsafe("select pg_backend_pid() as pid"))[0].pid);
    await peer.unsafe("set statement_timeout='5s'");
    await admin.unsafe("set statement_timeout='5s'");
    await admin.begin(async (tx) => {
      await tx.unsafe("select user_id from members where org_id=$1 and user_id=$2 for update", [org, owner]);
      admission = authority(peer)
        .withSession(second, "1", async (_tx, scope) => scope.sandboxId)
        .catch((error: unknown) => error);
      let blocked = false;
      for (let attempt = 0; attempt < 1000 && !blocked; attempt++) {
        blocked = (await tx.unsafe("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))[0].blocked;
      }
      expect(blocked).toBe(true);
      await tx.unsafe("delete from members where org_id=$1 and user_id=$2", [org, owner]);
    });
    expect(await admission).toBeInstanceOf(RuntimeEnrolmentDenied);
  } finally {
    finish.resolve();
    await Promise.allSettled([held, admission]);
    await admin.unsafe("delete from sandboxes where id in ($1,$2)", sandboxes);
    await admin.unsafe("delete from goldens where id=$1", [golden]);
    await admin.unsafe("delete from members where org_id=$1", [org]);
    await admin.unsafe("delete from mcp_invalidations where org_id=$1", [org]);
    await admin.unsafe("delete from orgs where id=$1", [org]);
    await admin.unsafe("delete from auth.users where id=$1", [owner]);
    await Promise.all([admin.close(), runtime.close(), peer.close()]);
  }
});
