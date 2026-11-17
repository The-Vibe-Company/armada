import { expect, spyOn, test } from "bun:test";
import {
  type AgentEvent,
  LAUNCH_STAGES,
  launchReadyPercentiles,
  type Provider,
  type ProviderTarget,
} from "@armada/core";
import { createSqlSandboxStore, createSqlVaultStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
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
        // Ties keep catalog order, as summarizeLaunch does: one report can record two stages in the same microsecond.
        `select activation::text,stage,at::text from sandbox_launch_stages where sandbox_id=$1
          order by activation,at,array_position(array[${LAUNCH_STAGES.map((stage) => `'${stage}'`).join(",")}],stage)`,
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

// #2560: a sandbox launched before the stage table existed has no history; its first measured activation is a resume.
test("the first resume of a sandbox launched before measurement stays a resume", async () => {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  try {
    const golden = (
      await db.query<{ id: string }>("select id from goldens where org_id=$1 and visibility='org'", [people.org])
    ).rows[0]!;
    const sandbox = await createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "physical-retained",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "starting",
      visibility: "org",
      model: "claude-opus-4-5",
      reasoningEffort: "high",
    });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [sandbox.id]);
    // Retained from before the migration: no stage was ever recorded for it.
    await db.query("delete from sandbox_launch_stages where sandbox_id=$1", [sandbox.id]);
    await db.query("update sandboxes set status='starting',stopped_at=null where id=$1", [sandbox.id]);
    await db.query("update sandboxes set status='ready' where id=$1", [sandbox.id]);
    const rows = (
      await db.query<{ activation: string; stage: string; at: string }>(
        "select activation::text,stage,at::text from sandbox_launch_stages where sandbox_id=$1 order by at",
        [sandbox.id],
      )
    ).rows;
    expect(rows.map((row) => `${row.activation}:${row.stage}`)).toEqual(["2:accepted", "2:harness_ready"]);
    expect(
      launchReadyPercentiles(rows.map((row) => ({ ...row, sandbox_id: sandbox.id, provider: "boat" }))),
    ).toMatchObject([{ provider: "boat", kind: "resume", count: 1 }]);
    const owner = createSqlData(sql)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "service",
    });
    expect((await owner.sandboxes.launchTiming!(sandbox.id))?.activation).toBe("2");
    // The next resume continues from the measured one.
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [sandbox.id]);
    await db.query("update sandboxes set status='starting',stopped_at=null where id=$1", [sandbox.id]);
    expect((await owner.sandboxes.launchTiming!(sandbox.id))?.activation).toBe("3");
  } finally {
    await db.close();
  }
});

// #2560: native Boat/Modal output reaches the server only through provider event reads, never the runtime upload.
test("native Boat and Modal event reads record first_token per activation at the event's own time", async () => {
  const { db, people } = await database();
  const sql: Sql = { query: (q, v) => db.query(q, v) };
  const golden = (
    await db.query<{ id: string }>("select id from goldens where org_id=$1 and visibility='org'", [people.org])
  ).rows[0]!;
  // The seeded golden is Boat; the Modal case exercises the Modal registry route with that sandbox identity.
  const insert = (provider: "boat" | "modal") =>
    createSqlSandboxStore(sql).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: `physical-${provider}`,
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "claude",
      status: "starting",
      visibility: "org",
      model: "claude-opus-4-5",
      reasoningEffort: "high",
    });
  let events: AgentEvent[] = [];
  const native = (id: "boat" | "modal") =>
    ({ id, events: async () => ({ events, hasMore: false, cursor: "c" }) }) as unknown as Provider;
  const registry = providerRegistry({
    launchStageSql: sql,
    vault: createSqlVaultStore(sql),
    encryptionKey: ENCRYPTION_KEY,
    providerFor: () => native("boat"),
    modalTokensFor: async () => ({ tokenId: "id", tokenSecret: "secret", scope: "org" }),
    modalProviderFor: () => native("modal"),
  });
  const firstToken = async (id: string) =>
    (
      await db.query<{ activation: string; at: Date }>(
        "select activation::text,at from sandbox_launch_stages where sandbox_id=$1 and stage='first_token' order by activation",
        [id],
      )
    ).rows.map((row) => `${row.activation}:${new Date(row.at).getTime()}`);
  const message = (at: number, extra: Partial<AgentEvent> = {}) =>
    ({ id: `e${at}`, at, kind: "message", text: "hi", partial: false, tools: [], ...extra }) as AgentEvent;
  try {
    for (const provider of ["boat", "modal"] as const) {
      const sandbox = await insert(provider);
      const target: ProviderTarget = {
        id: sandbox.id,
        provider,
        orgId: people.org,
        visibility: "org",
        modal: provider === "modal" ? { workspace: "w", environment: "main", app: "armada" } : null,
      } as ProviderTarget;
      // The launch was accepted an hour ago, so its output predates the resume below.
      const accepted = Date.parse(
        (
          await db.query<{ at: string }>(
            "update sandbox_launch_stages set at=at-interval '1 hour' where sandbox_id=$1 and stage='accepted' returning at::text",
            [sandbox.id],
          )
        ).rows[0]!.at,
      );
      const read = async () =>
        (await registry.resolve(target, { userId: people.owner })).events({ sandboxId: sandbox.providerSandboxId });
      // Prompt echoes, tool results and retracted output are not model output.
      events = [
        { id: "p", at: accepted + 1000, kind: "prompt", text: "go", status: "running" } as AgentEvent,
        message(accepted + 1500, { responseKind: "tool_result" }),
        message(accepted + 1700, { retracted: true }),
      ];
      expect((await read()).events).toBe(events);
      expect(await firstToken(sandbox.id)).toEqual([]);
      events = [message(accepted + 3000), message(accepted + 2000)];
      await read();
      events = [message(accepted + 1800)];
      await read();
      expect(await firstToken(sandbox.id)).toEqual([`1:${accepted + 1800}`]);
      // A resume: rereading the launch's history never dates the new activation.
      await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [sandbox.id]);
      await db.query("update sandboxes set status='starting',stopped_at=null where id=$1", [sandbox.id]);
      await read();
      expect(await firstToken(sandbox.id)).toEqual([`1:${accepted + 1800}`]);
      // The resume was accepted half an hour ago; its output follows it.
      const resumedAt = Date.parse(
        (
          await db.query<{ at: string }>(
            "update sandbox_launch_stages set at=at-interval '30 minutes' where sandbox_id=$1 and activation=2 and stage='accepted' returning at::text",
            [sandbox.id],
          )
        ).rows[0]!.at,
      );
      const resumed = resumedAt + 1000;
      events = [message(accepted + 1800), message(resumed)];
      await read();
      expect(await firstToken(sandbox.id)).toEqual([`1:${accepted + 1800}`, `2:${resumed}`]);
    }
    // A failed record never fails the read it observes.
    const broken = providerRegistry({
      launchStageSql: {
        query: async () => {
          throw Error("db down");
        },
      },
      vault: createSqlVaultStore(sql),
      encryptionKey: ENCRYPTION_KEY,
      providerFor: () => native("boat"),
    });
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = await broken.resolve(
        { id: crypto.randomUUID(), provider: "boat", orgId: people.org, visibility: "org", modal: null },
        { userId: people.owner },
      );
      expect((await provider.events({ sandboxId: "x" })).events).toBe(events);
    } finally {
      quiet.mockRestore();
    }
  } finally {
    await db.close();
  }
});
