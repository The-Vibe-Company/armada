import { expect, test } from "bun:test";
import { createSqlSandboxStore } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { readStatus } from "../src/turns.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { bunLikeSql, fakeBoat } from "./support.ts";

const database = rowOnlyDatabase();

for (const outcome of ["allocated", "missing", "unavailable"] as const) {
  test(`abandoned launch registration is readable and reconciled (outcome=${outcome})`, async () => {
    const { db, people } = await database();
    const sql = bunLikeSql(db);
    const data = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    });
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    // Persist the registration boundary directly: no catch/finally cleanup or
    // activity renewal has run after the API worker disappeared.
    const registered = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "bx_1",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "starting",
      activityLeaseId: crypto.randomUUID(),
      model: "claude-sonnet-4-6",
      reasoningEffort: "default",
    });
    const found = (await data.sandboxes.get(registered.id))!;
    expect(found.status).toBe("starting");
    const boat = fakeBoat();
    if (outcome !== "missing") await boat.provider.fork({ from: "snapshot", labels: { sandbox: found.id } });
    // Before the fix, this attempts to promote to ready and hits the SQL activity fence.
    expect((await readStatus(boat.provider, data.sandboxes, found, { now: new Date() })).status).toBe("starting");
    const get = boat.provider.get.bind(boat.provider);
    if (outcome === "unavailable")
      boat.provider.get = async () => {
        throw Error("Transport failure");
      };
    const lifecycle = createSandboxLifecycle(sql, async () => boat.provider);
    expect(await lifecycle.reconcileOne()).toBe(false);
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [found.id]);
    expect(await lifecycle.reconcileOne()).toBe(true);
    const recovered = (await data.sandboxes.get(found.id))!;
    expect(recovered.status).toBe("failed");
    expect(recovered.statusReason).toContain("Launch interrupted");
    expect(recovered.stoppedAt === null).toBe(outcome === "unavailable");
    expect((await readStatus(boat.provider, data.sandboxes, recovered, { now: new Date() })).status).toBe("failed");
    expect(boat.stops).toEqual(outcome === "allocated" ? [found.providerSandboxId] : []);
    if (outcome === "unavailable") {
      boat.provider.get = get;
      await db.query("update sandboxes set reconcile_after=now() where id=$1", [found.id]);
      await lifecycle.reconcileOne();
      expect((await data.sandboxes.get(found.id))?.stoppedAt).not.toBeNull();
      expect(boat.stops).toEqual([found.providerSandboxId]);
    }
  });
}
