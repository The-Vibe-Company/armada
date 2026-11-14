import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const database = rowOnlyDatabase();
for (const provider of ["boat", "modal"] as const)
  describe.each(["publish", "expired", "pin"] as const)(`${provider} empty runtime publication (%s)`, (mutation) => {
    let f: Awaited<ReturnType<typeof runtimeFixture>>;
    beforeAll(async () => {
      f = await runtimeFixture(await database(), provider, "codex", true);
    });
    afterAll(async () => {
      await f?.close();
    });
    test("only an unchanged actively leased launch retains authority", async () => {
      await f.db.query(
        `update sandboxes set status='starting',activity_lease_id=$2,activity_until=now()+interval '1 minute' where id=$1`,
        [f.row.id, crypto.randomUUID()],
      );
      if (mutation === "expired")
        await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
      expect(
        (
          await f.db.query<{ revoked: boolean }>(
            "select runtime_hash is null as revoked from runtime_enrolments where sandbox_id=$1",
            [f.row.id],
          )
        ).rows[0]?.revoked,
      ).toBe(false);
      await f.db.query(
        `update sandboxes set status='ready',lifecycle_generation=lifecycle_generation+1,
    activity_lease_id=null,activity_until=null,credential_version=credential_version+$2 where id=$1`,
        [f.row.id, mutation === "pin" ? 1 : 0],
      );
      expect(
        (
          await f.db.query<{ revoked: boolean }>(
            "select runtime_hash is null as revoked from runtime_enrolments where sandbox_id=$1",
            [f.row.id],
          )
        ).rows[0]?.revoked,
      ).toBe(mutation !== "publish");
      if (mutation === "publish")
        await expect(f.authority.withSession(f.active.runtimeToken, f.active.epoch, async () => true)).resolves.toBe(
          true,
        );
      else
        await expect(
          f.authority.withSession(f.active.runtimeToken, f.active.epoch, async () => true),
        ).rejects.toThrow();
    });
  });
