import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createMemoryAuthStore } from "@armada/auth";
import type { Sql } from "@armada/core";
import { createSqlMcpRegistry, createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { createQueuedSandboxDispatch } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerRuntimeLifecycle } from "../src/docker-runtime-lifecycle.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { fixtureMachineId, pollMachineBootstrap, queueMachineCreate } from "./docker-create.fixture.ts";
import { queueMailboxStop } from "./docker-stop.fixture.ts";
import { useMigratedDatabase } from "./migrated-database.ts";

const database = useMigratedDatabase();
const sql: Sql = {
  query: (q, v) => database().query(q, v),
  transaction: (work) => database().transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const key = Buffer.alloc(32, 13).toString("base64");
const service = createDockerRuntimeLifecycle(sql, key);
const hosts = createDockerHostStore(sql, key);
const reservations = createDockerSandboxService(sql);
const authority = createRuntimeEnrolments(sql, key);
const commands = createRuntimeCommands(authority, key);
const bootstrap = createDockerBootstrapService(sql, key, {
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
async function fixture() {
  const db = database();
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
  const { sandbox, target, context } = await queueMachineCreate(
    sql,
    key,
    actor,
    {
      requestId: randomUUID(),
      hostId: host.hostId,
      image: `worker@sha256:${"a".repeat(64)}`,
      credentialId,
      credentialVersion: 1,
    },
    installationId,
  );
  await hosts.complete(host.hostToken, installationId, {
    requestId: sandbox.generation,
    outcome: "completed",
    machineId: fixtureMachineId,
  });
  await bootstrap.bootstrapMachine(actor, target, context);
  const job = await pollMachineBootstrap(hosts, host.hostToken, installationId);
  if (job?.operation !== "bootstrap") throw Error("missing bootstrap");
  await hosts.complete(host.hostToken, installationId, { requestId: job.requestId, outcome: "completed" });
  const enrol = (target: Sql = sql) => createRuntimeEnrolments(target, key).enrol(job.bootstrap.enrolmentToken);
  return { actor, admin, credentialId, sandbox, installationId, ...host, enrol };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function denied(work: Promise<unknown>) {
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
async function readinessJournal(sandboxId: string) {
  return (
    await database().query(
      `select from_status,to_status,actor,code from public.sandbox_transitions
       where sandbox_id=$1 and to_status='ready' order by id`,
      [sandboxId],
    )
  ).rows;
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
test.each(["prompt", "readable variables", "MCP health", "MCP configuration", "MCP acknowledgement"] as const)(
  "a queued Docker send rolls back %s admission when its claim expires before commit",
  async (operation) => {
    const f = await fixture();
    const session = await ready(f);
    const input = { id: f.sandbox.id, request_id: randomUUID(), prompt: "queued turn" };
    const commandId =
      operation === "prompt" ? `docker_prompt_${input.request_id}` : `docker_variables_${input.id}_${session.epoch}`;
    if (operation === "readable variables") {
      const manifest = await encryptSecret(JSON.stringify({ request: {}, variables: { TEST_VALUE: "test" } }), key);
      await database().query(
        `insert into public.jobs(kind,sandbox_id,org_id,generation,idem_key,request_owner_id,request_digest,state,deadline_at,max_attempts,payload_enc,outcome)
         select 'launch',$1::uuid,e.org_id,1,format('["request","%s","launch","%s",%s]',e.org_id,e.user_id,to_json(format('["docker","%s"]',$1::uuid))),
           e.user_id,$2,'done',now()+interval '1 hour',1,$3,
           jsonb_build_object('docker_actor_epoch',e.epoch::text,'docker_receipt',encode($4::bytea,'hex'))
         from public.mcp_actor_epochs e where e.user_id=$5 and e.org_id=$6`,
        [input.id, "a".repeat(64), manifest, await encryptSecret("{}", key), f.actor.userId, f.actor.orgId],
      );
    }
    const isMcp = operation.startsWith("MCP");
    const commandCount = async (tx: Sql) =>
      (
        await tx.query<{ count: number }>(
          "select count(*)::int as count from public.runtime_commands where sandbox_id=$1",
          [input.id],
        )
      ).rows[0]!.count;
    const initialCount = await commandCount(sql);
    let now = 0;
    const promptId = randomUUID();
    const clock = {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
        const next = await commands.next(session.runtimeToken, session.epoch);
        const command = next.command;
        if (!command) throw new Error("No command to acknowledge");
        let result: object = { acknowledged: true };
        switch (command.op) {
          case "prompt":
            result = { promptId, conversationId: randomUUID(), status: "running" };
            break;
          case "health":
            result = { ready: true, generation: session.epoch, mcpVersion: 1 };
            break;
          case "configureMcp":
            result = { revision: command.configuration.revision };
            break;
        }
        await commands.complete(session.runtimeToken, session.epoch, {
          epoch: session.epoch,
          requestId: command.requestId,
          status: 200,
          body: { version: 1, requestId: command.requestId, result },
        });
      },
    };
    const mcp = createRuntimeMcp({
      sql,
      key,
      origin: "https://armada.example",
      commands: createRuntimeCommands(authority, key, clock),
    });
    if (isMcp) {
      const connection = await createSqlMcpRegistry(sql, key).save(f.actor.userId, f.actor.orgId, {
        name: "Fixture MCP",
        scope: "personal",
        transport: "http",
        url: "https://mcp.example",
        authType: "bearer",
        authentication: "fixture",
      });
      await database().query("update public.mcp_grants set status='connected' where connection_id=$1", [connection.id]);
      await mcp.connections.bind(input.id, [connection.id]);
    }
    const configured = async (tx: Sql) =>
      (
        await tx.query<{ configured: boolean }>("select configured from public.mcp_bootstraps where sandbox_id=$1", [
          input.id,
        ])
      ).rows[0]?.configured;
    const dispatch = createQueuedSandboxDispatch({
      authStore: createMemoryAuthStore(),
      supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
      store: createSqlVaultStore(sql),
      encryptionKey: key,
      data: createSqlData(sql),
      providers: {
        async resolve() {
          throw new Error("Docker send must use the runtime.");
        },
      },
      dockerControls: createDockerSandboxControls(sql, key, {
        sendEnabled: true,
        clock,
        ...(isMcp ? { prepareMcp: mcp.prepare } : {}),
      }),
    });
    const caller = {
      userId: f.actor.userId,
      via: "service" as const,
      orgs: [{ orgId: f.actor.orgId, role: "member" as const }],
    };
    const handoffGeneration = async () => {
      throw new Error("Running send must not hand off generation.");
    };
    let expired = false;
    const mcpCommandsBeforeCommit = {
      "MCP health": 1,
      "MCP configuration": 2,
      "MCP acknowledgement": 2,
    };
    await expect(
      dispatch(caller, input, {
        handoffGeneration,
        async canDispatch(tx) {
          if (!tx) return true;
          if (operation in mcpCommandsBeforeCommit) {
            expired ||=
              operation === "MCP acknowledgement"
                ? (await configured(tx)) === true
                : (await commandCount(tx)) >=
                  initialCount + mcpCommandsBeforeCommit[operation as keyof typeof mcpCommandsBeforeCommit];
            return !expired;
          }
          const command = await tx.query(
            "select 1 from public.runtime_commands where sandbox_id=$1 and request_id=$2",
            [input.id, commandId],
          );
          expired = command.rows.length > 0;
          return !expired;
        },
      }),
    ).rejects.toThrow();
    expect(expired).toBe(true);
    if (isMcp) {
      const committedCommands =
        mcpCommandsBeforeCommit[operation as keyof typeof mcpCommandsBeforeCommit] -
        (operation === "MCP acknowledgement" ? 0 : 1);
      expect(await commandCount(sql)).toBe(initialCount + committedCommands);
      expect(await configured(sql)).toBe(operation === "MCP acknowledgement" ? false : undefined);
      expect(
        (await database().query("select 1 from public.mcp_leases where sandbox_id=$1", [input.id])).rows.length,
      ).toBe(operation === "MCP acknowledgement" ? 1 : 0);
    }
    expect(
      (
        await database().query("select 1 from public.runtime_commands where sandbox_id=$1 and request_id=$2", [
          input.id,
          commandId,
        ])
      ).rows,
    ).toEqual([]);

    await expect(dispatch(caller, input, { handoffGeneration, canDispatch: async () => true })).resolves.toMatchObject({
      promptId,
      requestId: input.request_id,
    });
    if (isMcp) expect(await configured(sql)).toBe(true);
  },
);

test("Docker readiness rejects an ACK read against an older lifecycle generation", async () => {
  const f = await fixture();
  const session = await f.enrol();
  const row = (
    await database().query<{ older_generation: string }>(
      "select (lifecycle_generation-1)::text as older_generation from public.sandboxes where id=$1",
      [f.sandbox.id],
    )
  ).rows[0]!;
  await denied(service.ready(f.actor, f.sandbox.id, randomUUID(), row.older_generation));
  expect((await commands.next(session.runtimeToken, session.epoch)).command).toBeNull();
  expect((await readinessJournal(f.sandbox.id)).length).toBe(1);
});

test("Docker health independently validates the reply from the enrolled epoch", async () => {
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
  }
  const healthId = randomUUID();
  await service.ready(f.actor, f.sandbox.id, healthId);
  await complete(session, { ready: true, generation: session.epoch });
  expect(await service.ready(f.actor, f.sandbox.id, healthId)).toEqual({ state: "ready", epoch: session.epoch });
  await service.ready(f.actor, f.sandbox.id, healthId);
  expect(await readinessJournal(f.sandbox.id)).toEqual([
    { from_status: "starting", to_status: "ready", actor: "runtime_enrolment", code: "runtime_enrolled" },
  ]);
  // The concrete authority still accepts the same live epoch after publication.
  expect(await authority.withSession(session.runtimeToken, session.epoch, async (_tx, scope) => scope.epoch)).toBe(
    session.epoch,
  );
  await queueMailboxStop(sql, key, f.actor, f.sandbox.id, randomUUID());
  await denied(service.ready(f.actor, f.sandbox.id, healthId));
});

test("normal launch preparation cannot be bypassed by private readiness or an unrelated first prompt", async () => {
  const db = database();
  const f = await fixture(),
    session = await f.enrol(),
    healthId = randomUUID();
  const input = { requestId: randomUUID(), text: "Original admitted prompt" };
  await db.query(
    `insert into public.jobs(kind,sandbox_id,org_id,generation,idem_key,request_owner_id,request_digest,state,deadline_at,max_attempts,payload_enc,outcome)
     select 'launch',$1::uuid,e.org_id,1,format('["request","%s","launch","%s",%s]',e.org_id,e.user_id,to_json(format('["docker","%s"]',$1::uuid))),
       e.user_id,$2,'queued',now()+interval '1 hour',1,$3,
       jsonb_build_object('docker_actor_epoch',e.epoch::text)
     from public.mcp_actor_epochs e where e.user_id=$4 and e.org_id=$5`,
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
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("ready");
  const controls = createDockerSandboxControls(sql, key);
  const caller = {
    userId: f.actor.userId,
    orgs: [{ orgId: f.actor.orgId, role: "member" as const }],
    via: "service" as const,
  };
  expect(await controls.invoke(caller, "status", { id: f.sandbox.id })).toMatchObject({
    result: { status: "starting" },
  });
  await expect(controls.invoke(caller, "exec", { id: f.sandbox.id, command: "pwd" })).rejects.toThrow(
    "Docker sandbox must be running.",
  );
  await denied(service.prompt(f.actor, f.sandbox.id, input));
  await denied(service.prompt(f.actor, f.sandbox.id, input, String(BigInt(session.epoch) + 1n)));
  await denied(service.prompt(f.actor, f.sandbox.id, { ...input, requestId: randomUUID() }, session.epoch));
  expect(await service.prompt(f.actor, f.sandbox.id, input, session.epoch)).toEqual({ state: "pending" });
});

test("health replies from before stop or an epoch replacement are refused", async () => {
  for (const change of ["stop", "epoch"] as const) {
    const f = await fixture(),
      session = await f.enrol(),
      requestId = randomUUID();
    await service.ready(f.actor, f.sandbox.id, requestId);
    await complete(session, { ready: true, generation: session.epoch });
    if (change === "stop") await queueMailboxStop(sql, key, f.actor, f.sandbox.id, randomUUID());
    else {
      const next = await createRuntimeEnrolments(sql, key, { allowDockerIssue: true }).issue({
        sandboxId: f.sandbox.id,
        ownerId: f.actor.userId,
        configuration: {},
      });
      await authority.enrol(next.enrolmentToken);
    }
    await denied(service.ready(f.actor, f.sandbox.id, requestId));
    expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe(change === "stop" ? "stopping" : "ready");
  }
});

test("one durable conversation survives lost responses and admits only exact retries or explicit same-conversation follow-ups", async () => {
  const db = database();
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
  await denied(createDockerRuntimeLifecycle(lostSql, key).prompt(f.actor, f.sandbox.id, input));
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual({ state: "pending" });
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("ready");
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" as const };
  await db.exec(
    "alter table sandbox_transitions add constraint test_reject_acceptance check (code <> 'docker_prompt_accepted') not valid",
  );
  try {
    await expect(complete(session, receipt)).rejects.toThrow();
    expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual({ state: "pending" });
    expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("ready");
  } finally {
    await db.exec("alter table sandbox_transitions drop constraint test_reject_acceptance");
  }
  const command = await complete(session, { ...receipt, privateField: "never expose reply extras" });
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("running");
  expect(
    (await db.query("select code from sandbox_transitions where sandbox_id=$1 and to_status='running'", [f.sandbox.id]))
      .rows,
  ).toEqual([{ code: "docker_prompt_accepted" }]);
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

test("a Docker receipt arriving after its terminal event does not reopen the turn", async () => {
  const f = await fixture();
  const session = await ready(f);
  const input = { requestId: randomUUID(), text: "Finish before returning the receipt" };
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toEqual({ state: "pending" });
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
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
              id: "final",
              at: 1,
              kind: "prompt",
              promptId: receipt.promptId,
              text: input.text,
              status: "finished",
            },
          },
        ],
      }),
    }),
  );
  expect(response?.status).toBe(200);
  await complete(session, receipt);
  expect(await service.prompt(f.actor, f.sandbox.id, input)).toMatchObject({ state: "admitted", receipt });
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("ready");
  expect(
    (
      await database().query("select id from sandbox_transitions where sandbox_id=$1 and to_status='running'", [
        f.sandbox.id,
      ])
    ).rows,
  ).toEqual([]);
});

test("a reported outcome clears with its turn at the next prompt and keeps the report history", async () => {
  const db = database();
  const f = await fixture(),
    session = await ready(f),
    input = { requestId: randomUUID(), text: "Open a pull request" };
  await service.prompt(f.actor, f.sandbox.id, input);
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" as const };
  await complete(session, receipt);
  await service.prompt(f.actor, f.sandbox.id, input);
  const outcome = { state: "ready" as const, prNumber: 42 };
  // The turn finished: the report route's own writer persists the outcome and its history.
  await db.query("update public.sandboxes set status='ready' where id=$1", [f.sandbox.id]);
  const generation = (
    await db.query<{ g: string }>("select lifecycle_generation::text as g from public.sandboxes where id=$1", [
      f.sandbox.id,
    ])
  ).rows[0]?.g;
  await createSqlData(sql)({
    userId: f.actor.userId,
    orgs: [{ orgId: f.actor.orgId, role: "member" }],
    via: "mcp",
  }).sandboxes.reportTaskOutcome!(f.sandbox.id, receipt.promptId, outcome, Number(generation));
  const reportKey = `${generation}:${receipt.promptId}`;
  const next = { requestId: randomUUID(), text: "Address review", conversationId: receipt.conversationId };
  expect(await service.prompt(f.actor, f.sandbox.id, next)).toEqual({ state: "pending" });
  const row = await db.query<{ task_outcome: unknown; task_prompt_id: string | null; pull_request_reports: unknown }>(
    "select task_outcome,task_prompt_id,pull_request_reports from public.sandboxes where id=$1",
    [f.sandbox.id],
  );
  expect(row.rows[0]).toEqual({
    task_outcome: null,
    task_prompt_id: null,
    pull_request_reports: { [reportKey]: outcome },
  });
});

test("prompt receipts cannot replace the allocation conversation and invalid replies remain redacted", async () => {
  const db = database();
  const f = await fixture(),
    session = await ready(f);
  const input = { requestId: randomUUID(), text: "Begin" };
  await service.prompt(f.actor, f.sandbox.id, input);
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
  await complete(session, receipt);
  await service.prompt(f.actor, f.sandbox.id, input);
  await db.query("update public.sandboxes set status='ready' where id=$1", [f.sandbox.id]);
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
    expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("ready");
  }
  expect(
    (
      await db.query<{ conversation_ids: string[] }>(`select conversation_ids from public.sandboxes where id=$1`, [
        f.sandbox.id,
      ])
    ).rows[0]?.conversation_ids,
  ).toEqual([receipt.conversationId]);
});

test.each(["admin", "pin", "credential", "owner", "issuer", "rejoin", "host", "stop"] as const)(
  "new ready/prompt operations fail closed after authority change: %s",
  async (change) => {
    const db = database();
    const f = await fixture();
    await ready(f);
    let actor = f.actor;
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
    if (change === "stop") await queueMailboxStop(sql, key, f.actor, f.sandbox.id, randomUUID());
    await denied(service.ready(actor, f.sandbox.id, randomUUID()));
    await denied(service.prompt(actor, f.sandbox.id, { requestId: randomUUID(), text: "Never admitted" }));
  },
);

function raceAfterSnapshot(onSnapshot: (tx: Sql) => Promise<void>) {
  let triggered = false;
  const racedSql: Sql = {
    ...sql,
    transaction: (work) =>
      sql.transaction!((tx) =>
        work({
          async query<T>(q: string, v?: unknown[]) {
            const result = await tx.query<T>(q, v);
            if (!triggered && q.includes("from public.sandboxes s join public.members m")) {
              triggered = true;
              await onSnapshot(tx);
            }
            return result;
          },
        }),
      ),
  };
  return { service: createDockerRuntimeLifecycle(racedSql, key), triggered: () => triggered };
}

test("Docker readiness admits a starting-to-ready enrolment transition between snapshot and lock", async () => {
  const f = await fixture();
  const requestId = randomUUID();
  let session: Awaited<ReturnType<Fixture["enrol"]>> | undefined;
  const raced = raceAfterSnapshot(async (tx) => {
    session = await f.enrol(scopedRuntimeSql(tx));
  });
  expect(await raced.service.ready(f.actor, f.sandbox.id, requestId)).toEqual({ state: "pending" });
  expect(raced.triggered()).toBe(true);
  if (!session) throw Error("missing enrolled session");
  expect((await reservations.get(f.actor, f.sandbox.id)).status).toBe("ready");
  await complete(session, { ready: true, generation: session.epoch });
  expect(await service.ready(f.actor, f.sandbox.id, requestId)).toEqual({ state: "ready", epoch: session.epoch });
  expect(await readinessJournal(f.sandbox.id)).toEqual([
    { from_status: "starting", to_status: "ready", actor: "runtime_enrolment", code: "runtime_enrolled" },
  ]);
});

test.each(["expires_at", "running", "prompt"] as const)(
  "snapshot stability still denies %s across the snapshot-to-lock window",
  async (mutation) => {
    const f = await fixture();
    const raced = raceAfterSnapshot(async (tx) => {
      await f.enrol(scopedRuntimeSql(tx));
      if (mutation === "expires_at")
        await tx.query("update public.sandboxes set expires_at=expires_at+interval '1 hour' where id=$1", [
          f.sandbox.id,
        ]);
      if (mutation === "running")
        await tx.query("update public.sandboxes set status='running' where id=$1", [f.sandbox.id]);
    });
    if (mutation === "prompt")
      await denied(raced.service.prompt(f.actor, f.sandbox.id, { requestId: randomUUID(), text: "Must still deny" }));
    else await denied(raced.service.ready(f.actor, f.sandbox.id, randomUUID()));
    expect(raced.triggered()).toBe(true);
    expect(
      (await database().query("select 1 from public.runtime_commands where sandbox_id=$1", [f.sandbox.id])).rows,
    ).toEqual([]);
  },
);
