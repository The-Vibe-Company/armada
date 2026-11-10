import { expect, test } from "bun:test";
import { createSqlData } from "../src/data.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { readStatus } from "../src/turns.ts";
import { bunLikeSql, database, fakeBoat } from "./support.ts";

for (const missing of [false, true]) {
  test(`SIGKILL after launch registration is readable and reconciled (missing=${missing})`, async () => {
    const { db, people } = await database();
    const sql = bunLikeSql(db);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { text, values } = (await request.json()) as { text: string; values: unknown[] };
        try {
          return Response.json(await sql.query(text, values));
        } catch {
          return new Response(null, { status: 500 });
        }
      },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./fixtures/interrupted-launch.ts", import.meta.url).pathname,
          server.url.href,
          JSON.stringify({ userId: people.owner, orgId: people.org, role: "member" }),
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const data = createSqlData(sql)({
        via: "service",
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" }],
      });
      const row = (await db.query<{ id: string }>("select id from sandboxes where status='starting'")).rows[0]!;
      const found = (await data.sandboxes.get(row.id))!;
      const boat = fakeBoat();
      if (!missing) await boat.provider.fork({ from: "snapshot", labels: { sandbox: found.id } });
      // Before the fix, this attempts to promote to ready and hits the SQL activity fence.
      expect((await readStatus(boat.provider, data.sandboxes, found, { now: new Date() })).status).toBe("starting");
      const lifecycle = createSandboxLifecycle(sql, async () => boat.provider);
      expect(await lifecycle.reconcileOne()).toBe(false);
      await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [found.id]);
      expect(await lifecycle.reconcileOne()).toBe(true);
      const recovered = (await data.sandboxes.get(found.id))!;
      expect(recovered.status).toBe("failed");
      expect(recovered.statusReason).toContain("Launch interrupted");
      expect(recovered.stoppedAt).not.toBeNull();
      expect(boat.stops).toEqual(missing ? [] : [found.providerSandboxId]);
    } finally {
      await server.stop(true);
      await db.close();
    }
  });
}
