import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "../src/runtime-enrolment.ts";
import { sqlOver } from "../src/sql.ts";

// CI supplies an already migrated disposable database. Never use a production database.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!url)("PostgreSQL membership revocation cannot deadlock behind runtime admission", async () => {
  const admin = new SQL(url ?? "", { max: 1 });
  const remover = new SQL(url ?? "", { max: 1 });
  const runtime = new SQL(url ?? "", { max: 1 });
  const owner = crypto.randomUUID(),
    org = crypto.randomUUID(),
    golden = crypto.randomUUID(),
    sandbox = crypto.randomUUID();
  const sql = sqlOver({
    unsafe: (q, v) => runtime.unsafe(q, v),
    begin: (work) => runtime.begin((tx) => work({ unsafe: (q, v) => tx.unsafe(q, v) })),
  });
  const service = createRuntimeEnrolments(sql, Buffer.alloc(32, 9).toString("base64"));
  let allowDeletion: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    allowDeletion = resolve;
  });
  let memberLocked: () => void = () => {};
  const locked = new Promise<void>((resolve) => {
    memberLocked = resolve;
  });
  let removal: Promise<unknown> | undefined;
  let admission: Promise<unknown> | undefined;
  try {
    await admin.unsafe("insert into auth.users(id) values($1)", [owner]);
    await admin.unsafe("insert into orgs(id,name) values($1,'runtime-lock-race')", [org]);
    await admin.unsafe("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, owner]);
    await admin.unsafe(
      "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'runtime-lock-race','private','{}')",
      [golden, org, owner],
    );
    await admin.unsafe(
      "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status) values($1,$2,$3,$4,$5,'codex','ready')",
      [sandbox, golden, org, owner, `race-${sandbox}`],
    );
    const active = await service.enrol(
      (await service.issue({ sandboxId: sandbox, ownerId: owner, configuration: {} })).enrolmentToken,
    );
    const pid = Number((await runtime.unsafe("select pg_backend_pid() as pid"))[0].pid);
    await runtime.unsafe("set statement_timeout='5s'");
    await remover.unsafe("set statement_timeout='5s'");
    removal = remover.begin(async (tx) => {
      await tx.unsafe("select user_id from members where org_id=$1 and user_id=$2 for update", [org, owner]);
      memberLocked();
      await gate;
      // Existing member triggers update sandboxes while this transaction holds the member lock.
      await tx.unsafe("delete from members where org_id=$1 and user_id=$2", [org, owner]);
    });
    await locked;
    admission = service
      .withSession(active.runtimeToken, active.epoch, async () => "unexpected admission")
      .then(
        (value) => value,
        (error) => error,
      );
    let blocked = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if ((await admin.unsafe("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))[0].blocked) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    allowDeletion();
    await removal;
    expect(await admission).toBeInstanceOf(RuntimeEnrolmentDenied);
  } finally {
    allowDeletion();
    await Promise.allSettled([removal, admission]);
    await admin.unsafe("delete from sandboxes where id=$1", [sandbox]);
    await admin.unsafe("delete from goldens where id=$1", [golden]);
    await admin.unsafe("delete from members where org_id=$1", [org]);
    await admin.unsafe("delete from mcp_invalidations where org_id=$1", [org]);
    await admin.unsafe("delete from orgs where id=$1", [org]);
    await admin.unsafe("delete from auth.users where id=$1", [owner]);
    await Promise.all([admin.close(), remover.close(), runtime.close()]);
  }
});
