import { expect, spyOn, test } from "bun:test";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

// #2560: reported progress becomes first-write-wins launch stages, read back for visible sandboxes only.
test("runtime progress persists launch stages once per activation and status reads the latest one", async () => {
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
    harness: "codex",
    status: "ready",
    visibility: "org",
    model: "gpt-5.4",
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
      await db.query<{ epoch: string; stage: string; at: string }>(
        "select epoch::text,stage,at::text from sandbox_launch_stages where sandbox_id=$1 order by epoch,at,stage",
        [sandbox.id],
      )
    ).rows;
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const ticket = await authority.issue({ sandboxId: sandbox.id, ownerId: people.owner, configuration: {} });
    expect((await report(ticket.enrolmentToken, "bootstrap_started"))?.status).toBe(200);
    expect((await report(ticket.enrolmentToken, "artifact_verified"))?.status).toBe(200);
    const session = await authority.enrol(ticket.enrolmentToken);
    expect((await report(session.runtimeToken, "enrolled", session.epoch))?.status).toBe(200);
    expect((await report(session.runtimeToken, "harness_started", session.epoch))?.status).toBe(200);
    const first = await stages();
    expect((await report(session.runtimeToken, "harness_started", session.epoch))?.status).toBe(200);
    expect(await stages()).toEqual(first);
    expect(first.map((row) => [row.epoch, row.stage])).toEqual([
      ["1", "created"],
      ["1", "machine_started"],
      ["1", "bootstrap_started"],
      ["1", "enrolled"],
      ["1", "harness_ready"],
    ]);

    const owner = createSqlData(sql)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    });
    const launch = await owner.sandboxes.launchTiming!(sandbox.id);
    expect(launch?.epoch).toBe("1");
    expect(launch?.stages.map((stage) => stage.stage)).toEqual([
      "created",
      "machine_started",
      "bootstrap_started",
      "enrolled",
      "harness_ready",
    ]);
    expect(launch?.totalMs).toBe(Date.parse(launch!.stages[4]!.at) - Date.parse(launch!.stages[0]!.at));

    // A resume is a new epoch without a creation stage; status shows only that activation.
    await authority.issue({ sandboxId: sandbox.id, ownerId: people.owner, configuration: {} });
    expect((await owner.sandboxes.launchTiming!(sandbox.id))?.stages.map((stage) => stage.stage)).toEqual([
      "machine_started",
    ]);

    const outsider = createSqlData(sql)({
      userId: people.member,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    });
    expect(await outsider.sandboxes.launchTiming!(sandbox.id)).toBeNull();
  } finally {
    log.mockRestore();
    await db.close();
  }
});
