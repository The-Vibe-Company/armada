import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createOttoApi } from "../src/otto/api.ts";
import { sqlOver } from "../src/sql.ts";

const url = process.env.ARMADA_TEST_POSTGRES_URL;
// A real lock is essential: PGlite serializes callers and cannot reproduce this regression.
test.skipIf(!url)("all Otto reads answer with unknown completeness while projection writes are locked", async () => {
  const db = new SQL(url ?? "", { max: 1 });
  const writer = new SQL(url ?? "", { max: 1 });
  const org = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    golden = crypto.randomUUID();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = () => {};
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let holding: Promise<unknown> | undefined;
  try {
    await db.unsafe("insert into auth.users(id) values($1)", [owner]);
    await db.unsafe("insert into orgs(id,name) values($1,$2)", [org, `otto-${org}`]);
    await db.unsafe(
      "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'otto','org','{}')",
      [golden, org, owner],
    );
    await db.unsafe(
      "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status) values($1,$2,$3,$4,$5,'codex','ready')",
      [crypto.randomUUID(), golden, org, owner, crypto.randomUUID()],
    );
    // SELECTs remain possible, but any projection upsert waits until this transaction ends.
    holding = writer.begin(async (tx) => {
      await tx.unsafe("lock table otto_resources,otto_tasks,otto_orphan_days in share mode");
      locked();
      await gate;
    });
    await acquired;
    await db.unsafe("set statement_timeout='500ms'");
    const api = createOttoApi(sqlOver(db), { orgId: org, repository: "example/web" }, async () => ({
      ok: true,
      caller: { userId: owner, orgs: [{ orgId: org, role: "admin" }], via: "service" },
    }));
    for (const view of ["summary", "tasks", "resources", "orphans", "facts"]) {
      const response = await api(new Request(`https://armada.example/api/v1/otto/${view}?org_id=${org}`));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ completeness: "unknown" });
    }
  } finally {
    release();
    await holding;
    await db.unsafe("delete from otto_resources where org_id=$1", [org]);
    await db.unsafe("delete from sandboxes where org_id=$1", [org]);
    await db.unsafe("delete from goldens where org_id=$1", [org]);
    await db.unsafe("delete from orgs where id=$1", [org]);
    await db.unsafe("delete from auth.users where id=$1", [owner]);
    await Promise.all([db.close(), writer.close()]);
  }
});
