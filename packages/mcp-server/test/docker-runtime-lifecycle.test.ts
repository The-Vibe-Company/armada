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

test("one durable prompt survives a lost response, exact replays reconcile and conflicting text or new IDs never enqueue", async () => {
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
