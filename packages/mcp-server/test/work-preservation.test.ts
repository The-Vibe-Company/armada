import { expect, test } from "bun:test";
import { decryptSecret } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";
import { bunLikeSql, database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Primary owner for encrypted persistence and recovery authorization. Collector behavior
// (including actual Git reconstruction) belongs to core's work-preservation test.
test("recovery receipts retain encrypted versions and only current interior owners/admins can retrieve them", async () => {
  const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  const { db, people } = await database();
  try {
    const sql = bunLikeSql(db);
    const id = crypto.randomUUID();
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw new Error("Missing golden fixture");
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat','bx_recovery','claude','running')`,
      [id, golden.id, people.org, people.owner],
    );
    const data = (userId: string, orgId = people.org) =>
      createSqlData(sql)({ via: "service", userId, orgs: [{ orgId, role: "admin" }] }).sandboxes;
    const owner = data(people.owner);
    const boat = fakeBoat();
    const archive = Buffer.from("recovery fixture one: private repository material").toString("base64");
    boat.setExecOutput({ stdout: JSON.stringify({ status: "preserved", archive }) });
    await preserveBeforeStop(sql, boat.provider, id, "bx_recovery");
    const first = (
      await db.query<{ id: string; archive_enc: Uint8Array<ArrayBuffer> }>(
        "select id,archive_enc from sandbox_work_recovery where sandbox_id=$1",
        [id],
      )
    ).rows[0];
    if (!first) throw new Error("Missing recovery artifact");
    expect(Buffer.from(first.archive_enc).includes(Buffer.from(archive))).toBe(false);
    expect(await decryptSecret(first.archive_enc)).toBe(archive);
    expect((await owner.get(id))?.preservationNote).toBe(`unpushed work preserved at work_recovery:${id}/${first.id}`);
    expect(await owner.readWorkRecovery?.(id)).toBe(archive);

    // Clean stops must neither create an archive nor hide an earlier recovery receipt.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, boat.provider, id, "bx_recovery");
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(1);
    expect((await owner.get(id))?.preservationNote).toContain(first.id);

    // Retrying after failed capture surfaces a closed reason without losing earlier data.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "capture_failed" }) });
    await preserveBeforeStop(sql, boat.provider, id, "bx_recovery");
    expect((await owner.get(id))?.preservationNote).toBe("unpushed work could not be preserved (capture_failed)");
    expect(await owner.readWorkRecovery?.(id, first.id)).toBe(archive);

    await db.query("update sandbox_work_recovery set created_at='2020-01-01' where id=$1", [first.id]);
    const newerArchive = Buffer.from("recovery fixture two").toString("base64");
    boat.setExecOutput({ stdout: JSON.stringify({ status: "preserved", archive: newerArchive }) });
    await preserveBeforeStop(sql, boat.provider, id, "bx_recovery");
    expect(await owner.readWorkRecovery?.(id)).toBe(newerArchive);
    expect(await owner.readWorkRecovery?.(id, first.id)).toBe(archive);
    expect(await data(people.admin).readWorkRecovery?.(id)).toBe(newerArchive);
    // Stale admin claims cannot upgrade an ordinary org member's interior access.
    await expect(data(people.member).readWorkRecovery?.(id, first.id)).rejects.toThrow("No such sandbox");
    await expect(data(people.member, people.otherOrg).readWorkRecovery?.(id)).rejects.toThrow("No such sandbox");
    const otherId = crypto.randomUUID();
    expect(await owner.readWorkRecovery?.(id, otherId)).toBeNull();

    // Ciphertext is not directly readable with a dashboard user's database role.
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select archive_enc from sandbox_work_recovery")).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  } finally {
    await db.close();
    if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
  }
});
