import { expect, spyOn, test } from "bun:test";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

// #2560: activation boundaries come from sandbox status; runtime progress adds its stages to the current activation.
test("launch stages persist per activation and status reads only the latest, visible one", async () => {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const golden = (
    await db.query<{ id: string }>("select id from goldens where org_id=$1 and visibility='org'", [people.org])
  ).rows[0]!;
  const sandbox = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "physical",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "claude",
    status: "starting",
    visibility: "org",
    model: "claude-opus-4-5",
    reasoningEffort: "high",
    boatRuntime: true,
  });
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const route = createRuntimeProgress(authority);
  const report = (token: string, stage: string, epoch?: string) =>
    route(
      new Request("https://armada.test/api/runtime/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...(epoch ? { "x-armada-runtime-epoch": epoch } : {}) },
        body: JSON.stringify({ stage }),
      }),
    );
  const stages = async () =>
    (
      await db.query<{ activation: string; stage: string; at: string }>(
        "select activation::text,stage,at::text from sandbox_launch_stages where sandbox_id=$1 order by activation,at,stage",
        [sandbox.id],
      )
    ).rows;
  const owner = createSqlData(sql)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  });
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    // The server inserts the row after the provider fork: it lowers acceptance to the request time.
    const inserted = (await stages())[0]!;
    await owner.sandboxes.recordLaunchStage!(sandbox.id, "accepted", 60_000);
    await owner.sandboxes.recordLaunchStage!(sandbox.id, "provider_claimed");
    const accepted = (await stages())[0]!;
    expect(accepted.stage).toBe("accepted");
    expect(Date.parse(inserted.at) - Date.parse(accepted.at)).toBeGreaterThanOrEqual(59_000);
    // A ticket alone is not a running machine; the in-machine bootstrap report is.
    const ticket = await authority.issue({ sandboxId: sandbox.id, ownerId: people.owner, configuration: {} });
    expect((await stages()).map((row) => row.stage)).toEqual(["accepted", "provider_claimed"]);
    expect((await report(ticket.enrolmentToken, "bootstrap_started"))?.status).toBe(200);
    expect((await report(ticket.enrolmentToken, "artifact_verified"))?.status).toBe(200);
    const session = await authority.enrol(ticket.enrolmentToken);
    expect((await report(session.runtimeToken, "enrolled", session.epoch))?.status).toBe(200);
    // Codex reports harness_started when a prompt starts its app-server: not readiness, not persisted.
    expect((await report(session.runtimeToken, "harness_started", session.epoch))?.status).toBe(200);
    const first = await stages();
    expect((await report(session.runtimeToken, "enrolled", session.epoch))?.status).toBe(200);
    expect(await stages()).toEqual(first);
    // Leaving 'starting' is the latest possible readiness for any harness or path.
    await db.query("update sandboxes set status='ready' where id=$1", [sandbox.id]);
    await db.query("update sandboxes set status='running' where id=$1", [sandbox.id]);
    expect((await stages()).map((row) => `${row.activation}:${row.stage}`)).toEqual([
      "1:accepted",
      "1:provider_claimed",
      "1:machine_started",
      "1:bootstrap_started",
      "1:enrolled",
      "1:harness_ready",
    ]);
    const launch = await owner.sandboxes.launchTiming!(sandbox.id);
    expect(launch).toMatchObject({ activation: "1", ready: true });
    expect(launch?.totalMs).toBe(Date.parse(launch!.stages[5]!.at) - Date.parse(launch!.stages[0]!.at));

    // A resume re-enters 'starting': a new activation that status shows on its own.
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [sandbox.id]);
    await db.query("update sandboxes set status='starting',stopped_at=null where id=$1", [sandbox.id]);
    await db.query("update sandboxes set status='starting' where id=$1", [sandbox.id]);
    expect((await owner.sandboxes.launchTiming!(sandbox.id))?.stages.map((stage) => stage.stage)).toEqual(["accepted"]);
    expect((await owner.sandboxes.launchTiming!(sandbox.id))?.activation).toBe("2");

    const outsider = createSqlData(sql)({
      userId: people.member,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    });
    expect(await outsider.sandboxes.launchTiming!(sandbox.id)).toBeNull();
    await outsider.sandboxes.recordLaunchStage!(sandbox.id, "machine_started");
    expect((await stages()).filter((row) => row.activation === "2").map((row) => row.stage)).toEqual(["accepted"]);
  } finally {
    log.mockRestore();
    await db.close();
  }
});
