import { expect, spyOn, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeHistory } from "../src/runtime-history.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { ENCRYPTION_KEY } from "./support.ts";

// Owning boundary: real one-use authority/lifecycle locks -> fixed server logs
// and durable failure readback; never a client-provided sandbox/log message.
test("guest progress is ticket/epoch authenticated, non-secret, and failures survive handler restart with an empty journal", async () => {
  const db = await openMigratedDatabase();
  const people = { org: crypto.randomUUID(), owner: crypto.randomUUID() };
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    // Progress reports need an owned sandbox, not launch credentials.
    await db.query("insert into auth.users(id) values($1)", [people.owner]);
    await db.query("insert into orgs(id,name) values($1,'Runtime progress')", [people.org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [people.org, people.owner]);
    await db.query("insert into goldens(org_id,owner_id,name,visibility) values($1,$2,'progress-source','private')", [
      people.org,
      people.owner,
    ]);
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
      select $1,id,org_id,owner_id,'progress-host','codex','starting',true from goldens where owner_id=$2 limit 1`,
      [id, people.owner],
    );
    const sql: Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const ticket = await authority.issue({
      ownerId: people.owner,
      sandboxId: id,
      configuration: { secret: "private-config-canary" },
    });
    const report = async (token: string, body: object, epoch?: string) =>
      createRuntimeProgress(createRuntimeEnrolments(sql, ENCRYPTION_KEY))(
        new Request("https://armada.test/api/runtime/progress", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, ...(epoch ? { "x-armada-runtime-epoch": epoch } : {}) },
          body: JSON.stringify(body),
        }),
      );
    expect((await report("invalid", { stage: "bootstrap_started" }))?.status).toBe(401);
    expect(
      (await report(ticket.enrolmentToken, { stage: "bootstrap_started", secret: "private-config-canary" }))?.status,
    ).toBe(400);
    expect((await report(ticket.enrolmentToken, { stage: "private-config-canary" }))?.status).toBe(400);
    expect(log).not.toHaveBeenCalled();
    for (const stage of ["bootstrap_started", "artifact_verified"])
      expect((await report(ticket.enrolmentToken, { stage }))?.status).toBe(200);
    const active = await authority.enrol(ticket.enrolmentToken); // Reporting never consumes or renews ticket.
    expect((await report(ticket.enrolmentToken, { stage: "bootstrap_started" }))?.status).toBe(401);
    expect((await report(active.runtimeToken, { stage: "enrolled" }, "2"))?.status).toBe(401);
    for (const stage of ["enrolled", "harness_started", "runtime_failed"])
      expect((await report(active.runtimeToken, { stage }, active.epoch))?.status).toBe(200);
    expect((await report(active.runtimeToken, { stage: "harness_started" }, active.epoch))?.status).toBe(401);
    const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(lines.map((v) => v.stage)).toEqual([
      "bootstrap_started",
      "artifact_verified",
      "enrolled",
      "harness_started",
      "runtime_failed",
    ]);
    expect(lines.every((v) => v.event === "armada.runtime.stage" && v.sandboxId === id && v.epoch === "1")).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/private-config-canary|armada_enrol_|armada_runtime_/);
    const read = createRuntimeHistory(sql, ENCRYPTION_KEY);
    expect(
      await read({ userId: people.owner, orgs: [{ orgId: people.org, role: "member" }], via: "service" }, id, {}),
    ).toMatchObject({
      events: [],
      source: "armada-runtime",
      runtimeFailure: { status: "failed", reason: "Armada runtime process failed." },
    });
    // An unconsumed ticket can report bootstrap failure; it is then irreversibly revoked.
    await db.query("update sandboxes set status='starting',status_reason=null where id=$1", [id]);
    const next = await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} });
    expect((await report(next.enrolmentToken, { stage: "bootstrap_failed" }))?.status).toBe(200);
    await expect(authority.enrol(next.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
    expect(
      (await read({ userId: people.owner, orgs: [{ orgId: people.org, role: "member" }], via: "service" }, id, {}))
        .runtimeFailure?.reason,
    ).toBe("Armada runtime bootstrap failed.");
  } finally {
    log.mockRestore();
    await db.close();
  }
});
