import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sqlGoldenBackendSlots } from "../src/golden-create.ts";
import type { Sql } from "../src/golden-store.ts";

// Dedicated disposable database with migrations applied; never point this at production.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!url)(
  "real PostgreSQL serializes adoption/create and competing account binding; rollback preserves receipt",
  async () => {
    const a = new SQL(url!, { max: 1 });
    const b = new SQL(url!, { max: 1 });
    const observer = new SQL(url!, { max: 1 });
    const slotsFor = (client: SQL) => {
      const sql: Sql = {
        query: async <T>(query: string, params: unknown[] = []) => ({
          rows: Array.from(await client.unsafe(query, params as never[])) as T[],
        }),
      };
      return sqlGoldenBackendSlots(sql);
    };
    const slotsA = slotsFor(a);
    const slotsB = slotsFor(b);
    const org = "11111111-1111-4111-8111-111111111111";
    const owner = "22222222-2222-4222-8222-222222222222";
    const golden = "44444444-4444-4444-8444-444444444444";
    const adopt = async (sql: SQL, account: string, receipt: string | null) =>
      sql.unsafe("select adopt_canonical_boat_golden($1,$2,$3,'snapshot','source',$4) as receipt", [
        owner,
        golden,
        account,
        receipt,
      ]);
    const blocked = async () => {
      for (let i = 0; i < 1000; i++) {
        const rows = await observer.unsafe(
          "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()",
        );
        if (rows.length) return;
      }
      throw new Error("Competing database session never blocked");
    };
    try {
      await a.unsafe("insert into auth.users(id,email) values ($1,'race@test')", [owner]);
      await a.unsafe("insert into orgs(id,name) values ($1,'race')", [org]);
      await a.unsafe("insert into members(org_id,user_id,role) values ($1,$2,'admin')", [org, owner]);
      await a.unsafe(
        `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,provider_sandbox_id,config)
      values($1,$2,$3,'legacy','org','boat','snapshot','source','{}')`,
        [golden, org, owner],
      );
      const receipt = (await adopt(a, "account", null))[0].receipt as string;
      await a.unsafe("begin");
      await adopt(a, "account", receipt);
      const creating = b.unsafe("select reserve_golden_backend_slot('boat','account',1,$1,$2)", [org, owner]).execute();
      await blocked();
      await a.unsafe("rollback");
      await creating;
      // Rolled-back adoption consumed neither receipt nor golden.
      expect((await a.unsafe("select 1 from golden_adoption_receipts where id=$1", [receipt])).length).toBe(1);
      expect((await a.unsafe("select golden_id from golden_backend_slots"))[0].golden_id).toBeNull();
      await expect(adopt(a, "account", receipt)).rejects.toThrow();
      await a.unsafe("select release_golden_backend_slot(build_id) from golden_backend_slots");

      const second = (await adopt(b, "other-account", null))[0].receipt as string;
      await a.unsafe("begin");
      await adopt(a, "account", receipt);
      const competing = adopt(b, "other-account", second);
      // Attach rejection immediately so the intentional loser cannot be unhandled.
      const outcome = competing.then(
        () => "success",
        () => "conflict",
      );
      await blocked();
      await a.unsafe("commit");
      expect(await outcome).toBe("conflict");
      expect(Array.from(await a.unsafe("select golden_id,backend_id from golden_backend_slots"))).toMatchObject([
        { golden_id: golden, backend_id: "account" },
      ]);
      expect(Array.from(await a.unsafe("select name,visibility from goldens where id=$1", [golden]))).toMatchObject([
        { name: "legacy", visibility: "org" },
      ]);
      // Another org sharing the verified account cannot claim parallel capacity, even with capacity=2.
      const otherOrg = "55555555-5555-4555-8555-555555555555";
      await a.unsafe("insert into orgs(id,name) values ($1,'other-org')", [otherOrg]);
      await expect(
        slotsB.reserve({ provider: "boat", backendId: "account", capacity: 2, orgId: otherOrg, ownerId: owner }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        slotsB.reserveExisting({ provider: "boat", backendId: "other-account", capacity: 1, goldenId: golden }),
      ).rejects.toMatchObject({ code: "conflict" });
      const conflictingFinalize = await slotsA.reserve({
        provider: "boat",
        backendId: "finalize-conflict",
        capacity: 1,
        orgId: org,
        ownerId: owner,
      });
      await expect(slotsA.finalize(conflictingFinalize, golden)).rejects.toMatchObject({ code: "conflict" });
      await slotsA.release(conflictingFinalize);
      const rebuild = await slotsA.reserveExisting({
        provider: "boat",
        backendId: "account",
        capacity: 1,
        goldenId: golden,
      });
      await expect(
        slotsB.reserveExisting({ provider: "boat", backendId: "account", capacity: 1, goldenId: golden }),
      ).rejects.toMatchObject({ code: "conflict" });
      await slotsA.release(rebuild);

      // Actual competing transactions: one pending build wins, the loser receives the typed
      // capacity conflict from Bun's errno-shaped PostgreSQL exception, not a generic server error.
      const input = { provider: "boat", backendId: "reservation-race", capacity: 1, orgId: org, ownerId: owner };
      await a.unsafe("begin");
      const winner = await slotsA.reserve(input);
      const loser = slotsB.reserve({ ...input, orgId: otherOrg }).then(
        () => ({ code: "unexpected-success", message: "" }),
        (error) => ({ code: error.code, message: error.message }),
      );
      await blocked();
      await a.unsafe("commit");
      const conflict = await loser;
      expect(conflict.code).toBe("conflict");
      expect(conflict.message).toContain("Use an existing golden you can access");
      expect(conflict.message).not.toContain(input.backendId);
      expect(
        (await a.unsafe("select build_id from golden_backend_slots where backend_id=$1", [input.backendId])).length,
      ).toBe(1);
      await slotsA.release(winner);
      expect((await a.unsafe("select build_id from golden_backend_slots where build_id is not null")).length).toBe(0);
    } finally {
      await a.unsafe("rollback");
      await a.close();
      await b.close();
      await observer.close();
    }
  },
);
