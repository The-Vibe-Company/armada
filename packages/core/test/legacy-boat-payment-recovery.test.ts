import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";

test("only a service-role operator can recover captured legacy refusals; new ambiguous jobs retain capacity", async () => {
  const db = await openDatabase();
  const migration = "20261111010000_legacy_boat_payment_recovery.sql";
  try {
    await db.exec(await Bun.file(join(migrationsDir, "../../scripts/db/supabase-prereq.sql")).text());
    for (const file of readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f < migration)
      .sort())
      await db.exec(await Bun.file(join(migrationsDir, file)).text());
    const owner = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("insert into orgs(id,name) values($1,'legacy recovery')", [org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
    const insert = async () => {
      const job = crypto.randomUUID(),
        reservation = crypto.randomUUID();
      await db.query(
        "insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,build_id) values('boat',$1,1,$2,$3,$4)",
        [job, org, owner, reservation],
      );
      await db.query(
        "insert into golden_build_jobs(id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,reservation_id,state,phase,error_code) values($1::uuid,$2,$3,'legacy','org',$1::text,'hash',$4,$5,'recovery_required','builder','build_failed')",
        [job, org, owner, new Uint8Array([1]), reservation],
      );
      return { job, reservation };
    };
    const old = await insert();
    await db.exec(await Bun.file(join(migrationsDir, migration)).text());
    const fresh = await insert();
    const recover = (id: string) =>
      db.query("select reconcile_legacy_boat_payment_refusal($1,'provider_payment_required')", [id]);
    for (const role of ["anon", "authenticated"]) {
      await db.exec("set role " + role);
      await expect(recover(old.job)).rejects.toThrow("permission denied");
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    await expect(recover(fresh.job)).rejects.toThrow("not an eligible pre-migration");
    await db.query("update golden_build_jobs set builder_id='known-builder' where id=$1", [old.job]);
    await expect(recover(old.job)).rejects.toThrow("not an eligible pre-migration");
    await db.query("update golden_build_jobs set builder_id=null where id=$1", [old.job]);
    await recover(old.job);
    await recover(old.job);
    expect((await db.query("select state,failure_reason from golden_build_jobs where id=$1", [old.job])).rows).toEqual([
      { state: "failed", failure_reason: "provider_payment_required" },
    ]);
    expect((await db.query("select build_id from golden_backend_slots")).rows).toEqual([
      { build_id: fresh.reservation },
    ]);
    expect((await db.query("select state from golden_build_jobs where id=$1", [fresh.job])).rows).toEqual([
      { state: "recovery_required" },
    ]);
  } finally {
    await db.close();
  }
});
