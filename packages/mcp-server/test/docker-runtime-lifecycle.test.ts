import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentEvent, Sql } from "@armada/core";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerRuntimeLifecycle, DockerRuntimeDenied } from "../src/docker-runtime-lifecycle.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createSandboxAccountChange } from "../src/sandbox-account-change.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const key = Buffer.alloc(32, 13).toString("base64");
const service = createDockerRuntimeLifecycle(sql, key, { enabled: true });
const hosts = createDockerHostStore(sql, key);
const reservations = createDockerSandboxService(sql, key, { enabled: true });
const authority = createRuntimeEnrolments(sql, key);
const commands = createRuntimeCommands(authority, key);
const bootstrap = createDockerBootstrapService(sql, key, {
  enabled: true,
  serverUrl: "https://armada.example",
  architecture: "x64",
  manifest: {
    protocol: 1,
    platform: "linux",
    architecture: "x64",
    libc: "glibc",
    runtime: { sha256: "b".repeat(64), bytes: 42 },
    harnesses: { codex: { files: [{ path: "bin/codex" }] } },
  },
  credentials: launchCredentials(createSqlVaultStore(sql), key),
});
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
});
async function fixture() {
  const orgId = randomUUID(),
    userId = randomUUID(),
    adminId = randomUUID(),
    credentialId = randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2)`, [userId, adminId]);
  await db.query(`insert into public.orgs(id,name) values($1,$2)`, [orgId, `lifecycle-${orgId}`]);
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin')`, [
    orgId,
    userId,
    adminId,
  ]);
  const actor = { userId, orgId },
    admin = { userId: adminId, orgId };
  const registration = await hosts.issueRegistration(admin),
    installationId = randomUUID();
  const host = await hosts.exchangeRegistration(registration.registrationToken, installationId);
  await db.query(`insert into public.credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'openai',$3)`, [
    credentialId,
    userId,
    await encryptSecret(`offline-lifecycle-${randomUUID()}`, key),
  ]);
  const sandbox = await reservations.reserve(actor, {
    requestId: randomUUID(),
    hostId: host.hostId,
    image: `worker@sha256:${"a".repeat(64)}`,
    credentialId,
    credentialVersion: 1,
  });
  await hosts.complete(host.hostToken, installationId, { requestId: sandbox.id, outcome: "completed" });
  await bootstrap.bootstrap(actor, sandbox.id, randomUUID());
  const job = await hosts.poll(host.hostToken, installationId);
  if (job?.operation !== "bootstrap") throw Error("missing bootstrap");
  await hosts.complete(host.hostToken, installationId, { requestId: job.requestId, outcome: "completed" });
  const enrol = () => authority.enrol(job.bootstrap.enrolmentToken);
  return { actor, admin, credentialId, sandbox, installationId, ...host, enrol };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function denied(work: Promise<unknown>) {
  await expect(work).rejects.toBeInstanceOf(DockerRuntimeDenied);
  await expect(work).rejects.toThrow("Docker runtime denied");
}
async function complete(session: Awaited<ReturnType<Fixture["enrol"]>>, payload: unknown, status = 200) {
  const next = await commands.next(session.runtimeToken, session.epoch);
  if (!next.command) throw Error("missing queued command");
  await commands.complete(session.runtimeToken, session.epoch, {
    epoch: session.epoch,
    requestId: next.command.requestId,
    status,
    body: { version: 1, requestId: next.command.requestId, result: payload },
  });
  return next.command;
}
async function ready(f: Fixture) {
  const session = await f.enrol(),
    requestId = randomUUID();
  expect(await service.ready(f.actor, f.sandbox.id, requestId)).toEqual({ state: "pending" });
  await complete(session, { ready: true, generation: session.epoch });
  expect(await service.ready(f.actor, f.sandbox.id, requestId)).toEqual({ state: "ready", epoch: session.epoch });
  return session;
}

// These integration tests own the Docker lifecycle composition: concrete host ACK,
// credential admission, enrolment, encrypted command replay and archive authorization.
test("ACK is not readiness: current epoch health proof alone publishes ready without revoking itself", async () => {
  const f = await fixture(),
    id = randomUUID();
  expect(await service.ready(f.actor, f.sandbox.id, id)).toEqual({ state: "pending" });
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("starting");
  const session = await f.enrol();
  expect(await service.ready(f.actor, f.sandbox.id, id)).toEqual({ state: "pending" });
  await complete(session, { ready: false, generation: session.epoch });
  await denied(service.ready(f.actor, f.sandbox.id, id));
  for (const bad of ["generation", "version", "request", "status"] as const) {
    const requestId = randomUUID();
    await service.ready(f.actor, f.sandbox.id, requestId);
    const next = await commands.next(session.runtimeToken, session.epoch);
    if (!next.command) throw Error("missing health");
    await commands.complete(session.runtimeToken, session.epoch, {
      epoch: session.epoch,
      requestId: next.command.requestId,
      status: bad === "status" ? 503 : 200,
      body: {
        version: bad === "version" ? 2 : 1,
        ...(bad === "request" ? {} : { requestId: next.command.requestId }),
        result: { ready: true, generation: bad === "generation" ? "999" : session.epoch },
      },
    });
    await denied(service.ready(f.actor, f.sandbox.id, requestId));
    expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("starting");
  }
  const healthId = randomUUID();
  await service.ready(f.actor, f.sandbox.id, healthId);
  await complete(session, { ready: true, generation: session.epoch });
  expect(await service.ready(f.actor, f.sandbox.id, healthId)).toEqual({ state: "ready", epoch: session.epoch });
  // The concrete authority still accepts the same live epoch after publication.
  expect(await authority.withSession(session.runtimeToken, session.epoch, async (_tx, scope) => scope.epoch)).toBe(
    session.epoch,
  );
  await reservations.stop(f.actor, f.sandbox.id, randomUUID());
  await denied(service.ready(f.actor, f.sandbox.id, healthId));
});

test("normal launch preparation cannot be bypassed by private readiness or an unrelated first prompt", async () => {
  const f = await fixture(),
    session = await f.enrol(),
    healthId = randomUUID();
  const input = { requestId: randomUUID(), text: "Original admitted prompt" };
  await db.query(
    `insert into public.docker_launch_requests(sandbox_id,actor_epoch,request_hash,request_enc)
    select $1,e.epoch,$2,$3 from public.mcp_actor_epochs e where e.user_id=$4 and e.org_id=$5`,
    [
      f.sandbox.id,
      "a".repeat(64),
      await encryptSecret(JSON.stringify({ promptId: input.requestId, request: { prompt: input.text } }), key),
      f.actor.userId,
      f.actor.orgId,
    ],
  );
  await service.ready(f.actor, f.sandbox.id, healthId);
  await complete(session, { ready: true, generation: session.epoch });
  await service.ready(f.actor, f.sandbox.id, healthId);
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("starting");
  await denied(service.prompt(f.actor, f.sandbox.id, input));
  // Even after trusted preparation publishes ready, the reserved first prompt cannot be replaced.
  await db.query("update public.sandboxes set status='ready' where id=$1", [f.sandbox.id]);
  await denied(service.prompt(f.actor, f.sandbox.id, { ...input, requestId: randomUUID() }));
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual({ state: "pending" });
});

test("a health reply from before stop or an epoch replacement cannot publish readiness", async () => {
  for (const change of ["stop", "epoch"] as const) {
    const f = await fixture(),
      session = await f.enrol(),
      requestId = randomUUID();
    await service.ready(f.actor, f.sandbox.id, requestId);
    await complete(session, { ready: true, generation: session.epoch });
    if (change === "stop") await reservations.stop(f.actor, f.sandbox.id, randomUUID());
    else {
      const next = await createRuntimeEnrolments(sql, key, { allowDockerIssue: true }).issue({
        sandboxId: f.sandbox.id,
        ownerId: f.actor.userId,
        configuration: {},
      });
      await authority.enrol(next.enrolmentToken);
    }
    await denied(service.ready(f.actor, f.sandbox.id, requestId));
    expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe(change === "stop" ? "stopping" : "starting");
  }
});

test("one durable conversation survives lost responses and admits only exact retries or explicit same-conversation follow-ups", async () => {
  const f = await fixture(),
    session = await ready(f),
    input = { requestId: randomUUID(), text: "Report the current directory" };
  let lost = true;
  const lostSql: Sql = {
    ...sql,
    transaction: async (work) => {
      if (!sql.transaction) throw Error("transaction required");
      const result = await sql.transaction(work);
      if (lost) {
        lost = false;
        throw Error("private lost commit response");
      }
      return result;
    },
  };
  await denied(createDockerRuntimeLifecycle(lostSql, key, { enabled: true }).prompt(f.actor, f.sandbox.id, input));
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual({ state: "pending" });
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" as const };
  const command = await complete(session, { ...receipt, privateField: "never expose reply extras" });
  expect(command).toEqual({
    version: 1,
    requestId: `docker_prompt_${input.requestId}`,
    sandboxId: f.sandbox.id,
    op: "prompt",
    input: {
      sandboxId: f.sandbox.id,
      harness: "codex",
      text: input.text,
      model: f.sandbox.model,
      reasoningEffort: f.sandbox.reasoningEffort,
      cwd: "/home/user",
    },
  });
  const expected = { state: "admitted" as const, epoch: session.epoch, receipt };
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual(expected);
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual(expected);
  await denied(service.prompt(f.actor, f.sandbox.id, { ...input, text: "Different text" }));
  await denied(service.prompt(f.actor, f.sandbox.id, { ...input, requestId: randomUUID() }));
  expect((await commands.next(session.runtimeToken, session.epoch)).command).toBeNull();
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("running");
  const projection = await db.query<{
    task_prompt_id: string;
    conversation_ids: string[];
    lifecycle_generation: string;
  }>(`select task_prompt_id,conversation_ids,lifecycle_generation::text from public.sandboxes where id=$1`, [
    f.sandbox.id,
  ]);
  expect(projection.rows[0]).toEqual({
    task_prompt_id: receipt.promptId,
    conversation_ids: [receipt.conversationId],
    lifecycle_generation: session.epoch,
  });

  const followup = {
    requestId: randomUUID(),
    text: "Continue in that directory",
    conversationId: receipt.conversationId,
  };
  expect(await service.prompt(f.actor, f.sandbox.id, followup)).toEqual({ state: "pending" });
  await denied(service.prompt(f.actor, f.sandbox.id, { ...followup, requestId: randomUUID() }));
  await denied(service.prompt(f.actor, f.sandbox.id, { ...followup, text: "Changed text" }));
  await denied(service.prompt(f.actor, f.sandbox.id, { ...followup, conversationId: randomUUID() }));
  const nextReceipt = { ...receipt, promptId: randomUUID() };
  const nextCommand = await complete(session, nextReceipt);
  expect(nextCommand).toMatchObject({
    input: {
      conversationId: receipt.conversationId,
      model: f.sandbox.model,
      reasoningEffort: f.sandbox.reasoningEffort,
      cwd: "/home/user",
    },
  });
  const nextExpected = { state: "admitted" as const, epoch: session.epoch, receipt: nextReceipt };
  expect(await service.prompt(f.actor, f.sandbox.id, followup)).toEqual(nextExpected);
  expect(await service.prompt(f.actor, f.sandbox.id, followup)).toEqual(nextExpected);
  // Initial request replay still omits the now-persisted conversation in its payload.
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual(expected);
  expect(
    (
      await db.query<{ task_prompt_id: string }>("select task_prompt_id from public.sandboxes where id=$1", [
        f.sandbox.id,
      ])
    ).rows[0]?.task_prompt_id,
  ).toBe(nextReceipt.promptId);

  const foreign = await fixture(),
    foreignSession = await ready(foreign);
  const foreignInput = { requestId: randomUUID(), text: "Another allocation" };
  await service.prompt(foreign.actor, foreign.sandbox.id, foreignInput);
  const foreignReceipt = { ...receipt, promptId: randomUUID(), conversationId: randomUUID() };
  await complete(foreignSession, foreignReceipt);
  await service.prompt(foreign.actor, foreign.sandbox.id, foreignInput);
  await denied(
    service.prompt(f.actor, f.sandbox.id, {
      ...followup,
      requestId: randomUUID(),
      conversationId: foreignReceipt.conversationId,
    }),
  );

  // A completed native busy/error RPC is reconcilable but does not lock the
  // allocation: only an unresolved RPC blocks a fresh same-conversation request.
  const busy = { ...followup, requestId: randomUUID() };
  await service.prompt(f.actor, f.sandbox.id, busy);
  const busyCommand = (await commands.next(session.runtimeToken, session.epoch)).command;
  if (!busyCommand) throw Error("missing follow-up");
  await commands.complete(session.runtimeToken, session.epoch, {
    epoch: session.epoch,
    requestId: busyCommand.requestId,
    status: 409,
    body: { version: 1, requestId: busyCommand.requestId, error: "conversation_busy" },
  });
  await denied(service.prompt(f.actor, f.sandbox.id, busy));
  const recovered = { ...followup, requestId: randomUUID() };
  expect(await service.prompt(f.actor, f.sandbox.id, recovered)).toEqual({ state: "pending" });
  const finalReceipt = { ...receipt, promptId: randomUUID() };
  await complete(session, finalReceipt);
  expect(await service.prompt(f.actor, f.sandbox.id, recovered)).toEqual({
    state: "admitted",
    epoch: session.epoch,
    receipt: finalReceipt,
  });
  expect((await commands.next(session.runtimeToken, session.epoch)).command).toBeNull();
});

test("prompt receipts cannot replace the allocation conversation and invalid replies remain redacted", async () => {
  const f = await fixture(),
    session = await ready(f);
  const input = { requestId: randomUUID(), text: "Begin" };
  await service.prompt(f.actor, f.sandbox.id, input);
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
  await complete(session, receipt);
  await service.prompt(f.actor, f.sandbox.id, input);
  for (const bad of [
    { ...receipt, conversationId: randomUUID() },
    { ...receipt, conversationId: "not-a-uuid" },
    { ...receipt, promptId: "not-a-uuid" },
    { ...receipt, status: "not-a-status" },
  ]) {
    const followup = { requestId: randomUUID(), text: "Continue", conversationId: receipt.conversationId };
    await service.prompt(f.actor, f.sandbox.id, followup);
    await complete(session, bad);
    await denied(service.prompt(f.actor, f.sandbox.id, followup));
  }
  expect(
    (
      await db.query<{ conversation_ids: string[] }>(`select conversation_ids from public.sandboxes where id=$1`, [
        f.sandbox.id,
      ])
    ).rows[0]?.conversation_ids,
  ).toEqual([receipt.conversationId]);
});

test("new ready/prompt operations fail closed on current account, membership, issuer, host and lifecycle authority", async () => {
  for (const change of ["flag", "admin", "pin", "credential", "owner", "issuer", "rejoin", "host", "stop"] as const) {
    const f = await fixture();
    await ready(f);
    let actor = f.actor,
      current = service;
    if (change === "flag") current = createDockerRuntimeLifecycle(sql, key, { enabled: "true" as never });
    if (change === "admin") actor = f.admin;
    if (change === "pin")
      await db.query(`update public.credentials set value_enc=$2 where id=$1`, [
        f.credentialId,
        await encryptSecret("offline-replacement", key),
      ]);
    if (change === "credential")
      await db.query(`update public.credentials set status='revoked' where id=$1`, [f.credentialId]);
    if (["owner", "issuer", "rejoin"].includes(change)) {
      const user = change === "issuer" ? f.admin.userId : f.actor.userId;
      if (change === "issuer")
        await db.query(`update public.members set role='admin' where org_id=$1 and user_id=$2`, [
          actor.orgId,
          actor.userId,
        ]);
      await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [actor.orgId, user]);
      if (change === "rejoin")
        await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member')`, [actor.orgId, user]);
    }
    if (change === "host") await hosts.revoke(f.admin, f.hostId);
    if (change === "stop") await reservations.stop(f.actor, f.sandbox.id, randomUUID());
    await denied(current.ready(actor, f.sandbox.id, randomUUID()));
    await denied(current.prompt(actor, f.sandbox.id, { requestId: randomUUID(), text: "Never admitted" }));
  }
});

test("journal reads acknowledged encrypted events plus saved usage after stop/delete/host revoke and flag off, but remains owner/member only", async () => {
  const f = await fixture(),
    session = await ready(f),
    promptId = randomUUID();
  const entries: { sequence: number; event: AgentEvent }[] = [
    {
      sequence: 1,
      event: { id: "first", at: 1, kind: "prompt", promptId, text: "archive marker", status: "finished" },
    },
    {
      sequence: 2,
      event: {
        id: "usage",
        at: 2,
        kind: "other",
        promptId,
        type: "armada/turnUsage",
        data: { model: f.sandbox.model, inputTokens: 50, outputTokens: 8, cachedTokens: 5 },
      },
    },
  ];
  const response = await createRuntimeEvents(authority, key).route(
    new Request("https://armada.example/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
      body: JSON.stringify({ sandboxId: f.sandbox.id, generation: session.epoch, events: entries }),
    }),
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ acknowledgedSequence: 2 });
  const ciphertext = (
    await db.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
      `select event_enc from public.runtime_events where sandbox_id=$1 and sequence=1`,
      [f.sandbox.id],
    )
  ).rows[0]?.event_enc;
  expect(Buffer.from(ciphertext ?? []).includes(Buffer.from("archive marker"))).toBe(false);
  const disabled = createDockerRuntimeLifecycle(sql, key);
  const stopId = randomUUID(),
    deleteId = randomUUID();
  await reservations.stop(f.actor, f.sandbox.id, stopId);
  await hosts.complete(f.hostToken, f.installationId, { requestId: stopId, outcome: "completed" });
  await reservations.delete(f.actor, f.sandbox.id, deleteId);
  await hosts.complete(f.hostToken, f.installationId, { requestId: deleteId, outcome: "completed" });
  await hosts.revoke(f.admin, f.hostId);
  const first = await disabled.journal(f.actor, f.sandbox.id, { limit: 1 });
  expect(first).toMatchObject({
    events: [{ sequence: "1", event: entries[0]?.event }],
    cursor: "1",
    hasMore: true,
    usage: { turnCount: 1, turns: [{ promptId, inputTokens: 50, outputTokens: 8, cachedTokens: 5 }] },
  });
  expect(await disabled.journal(f.actor, f.sandbox.id, { cursor: first.cursor, limit: 1 })).toMatchObject({
    events: [{ sequence: "2", event: entries[1]?.event }],
    cursor: "2",
    hasMore: false,
  });
  for (const input of [{ limit: 101 }, { cursor: "-1" }, { cursor: "9223372036854775808" }])
    await denied(disabled.journal(f.actor, f.sandbox.id, input));
  await denied(disabled.journal(f.admin, f.sandbox.id));
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
  await denied(disabled.journal(f.actor, f.sandbox.id));
});

test("rebound Docker usage has its epoch's admitted prices before the accepted prompt receipt is recorded", async () => {
  const f = await fixture();
  await ready(f);
  const stopId = randomUUID();
  await reservations.stop(f.actor, f.sandbox.id, stopId);
  const stop = await hosts.poll(f.hostToken, f.installationId);
  if (stop?.operation !== "stop") throw Error("missing retained stop");
  await hosts.complete(f.hostToken, f.installationId, { requestId: stop.requestId, outcome: "completed" });
  const selected = randomUUID();
  await db.query(
    "insert into public.credentials(id,scope,owner_id,kind,name,value_enc) values($1,'user',$2,'openai','Rebound pricing',$3)",
    [
      selected,
      f.actor.userId,
      await encryptSecret(
        JSON.stringify({
          apiKey: "offline-rebound-key",
          endpoint: { version: 1, baseUrl: "https://pricing.example/v1" },
          prices: { "gpt-6.1-sol": { input: "3", output: "4", cacheRead: "0", cacheWrite: null, reasoning: null } },
        }),
        key,
      ),
    ],
  );
  await createSandboxAccountChange(sql, launchCredentials(createSqlVaultStore(sql), key), async () => {
    throw Error("not legacy");
  })(
    { userId: f.actor.userId, orgs: [{ orgId: f.actor.orgId, role: "member" }], via: "supabase" },
    { id: f.sandbox.id, credentialId: selected },
  );
  await bootstrap.resume(f.actor, f.sandbox.id, randomUUID());
  const resumed = await hosts.poll(f.hostToken, f.installationId);
  if (resumed?.operation !== "resume") throw Error("missing fresh enrollment");
  const session = await authority.enrol(resumed.bootstrap.enrolmentToken);
  await hosts.complete(f.hostToken, f.installationId, { requestId: resumed.requestId, outcome: "completed" });
  const health = randomUUID();
  await service.ready(f.actor, f.sandbox.id, health);
  await complete(session, { ready: true, generation: session.epoch });
  await service.ready(f.actor, f.sandbox.id, health);
  const input = { requestId: randomUUID(), text: "Usage before receipt" };
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual({ state: "pending" });
  const promptId = randomUUID(),
    conversationId = randomUUID();
  const response = await createRuntimeEvents(authority, key).route(
    new Request("https://armada.example/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
      body: JSON.stringify({
        sandboxId: f.sandbox.id,
        generation: session.epoch,
        events: [
          {
            sequence: 1,
            event: {
              id: randomUUID(),
              at: 1,
              kind: "other",
              type: "armada/turnUsage",
              promptId,
              data: {
                model: "gpt-6.1-sol",
                inputTokens: 100,
                outputTokens: 10,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
              },
            },
          },
        ],
      }),
    }),
  );
  expect(response?.status).toBe(200);
  expect(
    (
      await db.query<{ count: string }>("select count(*)::text as count from sandbox_turn_models where sandbox_id=$1", [
        f.sandbox.id,
      ])
    ).rows[0]?.count,
  ).toBe("0");
  const priced = (
    await db.query<{ usage_turns: { turns: Array<{ pricing: unknown }> } }>(
      "select usage_turns from sandboxes where id=$1",
      [f.sandbox.id],
    )
  ).rows[0]?.usage_turns.turns[0]?.pricing;
  expect(priced).toMatchObject({ credentialId: selected, usd: "0.00034", basis: "estimated", unknown: null });
  await complete(session, { promptId, conversationId, status: "queued" });
  expect((await service.prompt(f.actor, f.sandbox.id, input)).state).toBe("admitted");
  const admitted = (
    await db.query<{ pricing_context: { credentialId: string } }>(
      "select pricing_context from sandbox_turn_models where sandbox_id=$1 and prompt_id=$2",
      [f.sandbox.id, promptId],
    )
  ).rows[0];
  expect(admitted?.pricing_context.credentialId).toBe(selected);
});
