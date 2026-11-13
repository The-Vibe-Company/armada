import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createSqlAuthStore } from "@armada/auth";
import {
  type AgentEvent,
  type DockerLaunchResult,
  type DockerSandboxStatus,
  type Harness,
  type LaunchCredentialResolver,
  ProviderError,
  type SandboxListMetadata,
  type Sql,
} from "@armada/core";
import {
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  decryptSecret,
  encryptSecret,
  type TemplateRuntime,
} from "@armada/core/server";
import { dockerLaunchBody, launchedDockerSandbox } from "../../../apps/dashboard/src/lib/docker-launch.ts";
import type { Caller } from "../src/caller.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerNormalLaunch } from "../src/docker-normal-launch.ts";
import { createDockerNormalSend } from "../src/docker-normal-send.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const officialImage = `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`;
const key = Buffer.alloc(32, 19).toString("base64");
const hosts = createDockerHostStore(sql, key);
const authority = createRuntimeEnrolments(sql, key);
const commands = createRuntimeCommands(authority, key);
const credentials = launchCredentials(createSqlVaultStore(sql), key);
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
    harnesses: { codex: { files: [{ path: "bin/codex" }] }, claude: { files: [{ path: "bin/claude" }] } },
  },
  credentials,
});
beforeAll(async () => {
  db = await migratedDatabase();
});
afterAll(async () => {
  await db.close();
});

// The real migrated boundary owns normal-launch sequencing and durable retries.
// Existing private-lane tests own the individual host/runtime protocol matrices.
async function fixture(options: { lifecycleGenerationAfterCreate?: number; harness?: Harness } = {}) {
  const orgId = randomUUID(),
    userId = randomUUID(),
    adminId = randomUUID(),
    otherId = randomUUID(),
    credentialId = randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2),($3)`, [userId, adminId, otherId]);
  await db.query(`insert into public.orgs(id,name) values($1,$2)`, [orgId, `normal-launch-${orgId}`]);
  await db.query(
    `insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin'),($1,$4,'member')`,
    [orgId, userId, adminId, otherId],
  );
  const actor = { userId, orgId },
    admin = { userId: adminId, orgId };
  const caller: Caller = { userId, orgs: [{ orgId, role: "member" }], via: "supabase" };
  const registration = await hosts.issueRegistration(admin),
    installationId = randomUUID();
  const host = await hosts.exchangeRegistration(registration.registrationToken, installationId);
  const secret = `offline-normal-launch-${randomUUID()}`;
  // Omitted version must select the current pin, not fabricate version one.
  await db.query(
    `insert into public.credentials(id,version,scope,owner_id,kind,value_enc) values($1,2,'user',$2,$4,$3)`,
    [
      credentialId,
      userId,
      await encryptSecret(
        options.harness === "opencode"
          ? JSON.stringify({
              apiKey: secret,
              endpoint: { version: 1, baseUrl: "https://models.example/v1", models: ["deepseek-flash"] },
            })
          : secret,
        key,
      ),
      options.harness === "claude" ? "anthropic" : options.harness === "opencode" ? "opencode" : "openai",
    ],
  );
  const body = {
    org: orgId,
    provider: "docker",
    hostId: host.hostId,
    harness: options.harness ?? "codex",
    credentialId,
    requestId: randomUUID(),
    visibility: "private",
    prompt: "Report DOCKER_OK once",
  };
  let now = 0,
    drive = true,
    failCreate = false,
    malformedSkills = false;
  let session: Awaited<ReturnType<typeof authority.enrol>> | undefined;
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
  const jobs: unknown[] = [],
    native: unknown[] = [];
  async function step() {
    const job = await hosts.poll(host.hostToken, installationId);
    if (job) {
      jobs.push(job);
      if (job.operation === "bootstrap" || job.operation === "resume")
        session = await authority.enrol(job.bootstrap.enrolmentToken);
      await hosts.complete(host.hostToken, installationId, {
        requestId: job.requestId,
        outcome: failCreate && job.operation === "create" ? "failed" : "completed",
      });
      if (job.operation === "create" && options.lifecycleGenerationAfterCreate !== undefined) {
        await db.query(`update public.sandboxes set lifecycle_generation=$2 where id=$1`, [
          body.requestId,
          options.lifecycleGenerationAfterCreate,
        ]);
      }
    }
    if (session && job?.operation !== "stop" && job?.operation !== "delete") {
      const next = await commands.next(session.runtimeToken, session.epoch);
      if (next.command) {
        const command = next.command;
        native.push(command);
        await commands.complete(session.runtimeToken, session.epoch, {
          epoch: session.epoch,
          requestId: command.requestId,
          status: 200,
          body: {
            version: 1,
            requestId: command.requestId,
            result:
              command.op === "health"
                ? { ready: true, generation: session.epoch, mcpVersion: 1, skillsVersion: 1 }
                : command.op === "configureMcp"
                  ? { revision: command.configuration.revision }
                  : command.op === "installSkills"
                    ? {
                        receipts: command.input.references.map((reference) => ({
                          reference,
                          version: reference.split("@")[1],
                          skillId: randomUUID(),
                          checksum: malformedSkills ? "bad" : `sha256:${"a".repeat(64)}`,
                          origin: "https://skillpack.app/v1",
                        })),
                      }
                    : receipt,
          },
        });
      }
    }
  }
  const clock = {
    now: () => now,
    async wait(ms: number) {
      now += ms;
      if (drive) await step();
    },
  };
  let resolutions = 0;
  const resolver: Pick<LaunchCredentialResolver, "resolve"> = {
    async resolve(...args) {
      resolutions++;
      return credentials.resolve(...args);
    },
  };
  function mcp(target = sql) {
    const bridge = createRuntimeCommands(createRuntimeEnrolments(target, key), key, {
      now: clock.now,
      wait: (ms) => clock.wait(ms),
    });
    return createRuntimeMcp({ sql: target, key, origin: "https://armada.example", commands: bridge });
  }
  function service(target = sql, enabled = true, timeoutMs = 10_000, releaseImage = officialImage) {
    return createDockerNormalLaunch(target, key, {
      enabled,
      officialImage: releaseImage,
      credentials: resolver,
      bootstrap,
      clock,
      timeoutMs,
      mcp: mcp(target),
    });
  }
  return {
    actor,
    admin,
    setMalformedSkills() {
      malformedSkills = true;
    },
    otherId,
    caller,
    body,
    secret,
    installationId,
    ...host,
    clock,
    jobs,
    native,
    receipt,
    service,
    mcp,
    step,
    setDrive(value: boolean) {
      drive = value;
    },
    setFailure() {
      failCreate = true;
    },
    resolutions: () => resolutions,
    session: () => session,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({ provider: "docker", code });
  expect((error as Error).message).not.toContain("offline-normal");
}
async function counts(f: Fixture) {
  return (
    await db.query<{ sandboxes: number; claims: number; jobs: number; commands: number }>(
      `select (select count(*)::int from public.sandboxes where id=$1) as sandboxes,
    (select count(*)::int from public.docker_launch_requests where sandbox_id=$1) as claims,
    (select count(*)::int from public.docker_host_jobs where bound_sandbox_id=$1) as jobs,
    (select count(*)::int from public.runtime_commands where sandbox_id=$1) as commands`,
      [f.body.requestId],
    )
  ).rows[0];
}

test("normal launch drives create, bootstrap, health and one first prompt, seals its claim and replays current metadata", async () => {
  const f = await fixture();
  const result = await f.service().launch(f.caller, f.body);
  expect(result).toMatchObject({
    sandbox: {
      id: f.body.requestId,
      provider: "docker",
      goldenId: null,
      harness: "codex",
      visibility: "private",
      ownerId: f.actor.userId,
      orgId: f.actor.orgId,
      hostId: f.hostId,
      image: officialImage,
      status: "running",
      credentialId: f.body.credentialId,
      credentialVersion: 2,
      conversationIds: [f.receipt.conversationId],
      repositoryDir: null,
      stoppedAt: null,
      deletedAt: null,
      statusReason: null,
      effectiveTtlSeconds: 14400,
    },
    golden: null,
    helper: null,
    github: { status: "unavailable" },
    runtime: { kind: "armada", epoch: f.session()?.epoch },
    ttlSeconds: 14400,
    promptId: f.receipt.promptId,
    conversationId: f.receipt.conversationId,
  });
  expect(result.sandbox.createdAt).toMatch(/^\d{4}-/);
  expect(result.expiresAt).toBe(result.sandbox.expiresAt as string);
  expect(result.sandbox.model).toBeString();
  expect(result.sandbox.reasoningEffort).toBeString();
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 2 });
  expect(JSON.stringify(f.jobs)).not.toContain(f.body.prompt);
  expect(JSON.stringify(f.jobs)).not.toContain(f.secret);
  expect(JSON.stringify(result)).not.toContain(f.secret);
  const claim = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer>; result_enc: Uint8Array<ArrayBuffer>; request_hash: string }>(
      `select request_enc,result_enc,request_hash from public.docker_launch_requests where sandbox_id=$1`,
      [f.body.requestId],
    )
  ).rows[0];
  if (!claim) throw Error("missing durable launch claim");
  expect(claim.request_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(Buffer.from(claim.request_enc).toString()).not.toContain(f.body.prompt);
  const manifest = JSON.parse(await decryptSecret(claim.request_enc, key));
  expect(manifest).toMatchObject({ credentialVersion: 2, request: { credentialVersion: null, prompt: f.body.prompt } });
  expect(JSON.stringify(manifest)).not.toContain(f.secret);
  expect(JSON.parse(await decryptSecret(claim.result_enc, key))).toEqual({
    epoch: f.session()?.epoch,
    promptId: f.receipt.promptId,
    conversationId: f.receipt.conversationId,
  });
  for (const change of [
    { prompt: "Changed task" },
    { model: "different-model" },
    { credentialId: randomUUID() },
    { credentialVersion: 2 },
  ]) {
    await rejected(f.service().launch(f.caller, { ...f.body, ...change }), "conflict");
  }
  expect(f.resolutions()).toBe(1);
  const cleanup = createDockerSandboxControls(sql, key, { clock: f.clock });
  await cleanup.invoke(f.caller, "stop", { id: f.body.requestId });
  await cleanup.invoke(f.caller, "delete", { id: f.body.requestId });
  await db.query(`update public.credentials set status='revoked' where id=$1`, [f.body.credentialId]);
  const replay = await f.service(sql, false).launch(f.caller, f.body);
  expect(replay.sandbox.status).toBe("deleted");
  expect(replay.promptId).toBe(f.receipt.promptId);
  expect(replay.runtime).toEqual(result.runtime);
  expect(f.resolutions()).toBe(1);
  expect((await counts(f))?.commands).toBe(2);
});

test("unknown timeout and response loss survive restart and concurrent exact retries without rotating phase IDs", async () => {
  const f = await fixture();
  f.setDrive(false);
  await rejected(f.service(sql, true, 250).launch(f.caller, f.body), "unavailable");
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 1, commands: 0 });
  const before = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      `select request_enc from public.docker_launch_requests where sandbox_id=$1`,
      [f.body.requestId],
    )
  ).rows[0];
  expect((await createDockerSandboxService(sql, key).get(f.actor, f.body.requestId)).status).toBe("starting");
  await Promise.all([
    rejected(f.service(sql, true, 250).launch(f.caller, f.body), "unavailable"),
    rejected(f.service(sql, true, 250).launch(f.caller, f.body), "unavailable"),
  ]);
  f.setDrive(true);
  let lost = false;
  const lostResponse: Sql = {
    ...sql,
    async transaction(work) {
      if (!sql.transaction) throw Error("transaction required");
      let published = false;
      const result = await sql.transaction((tx) =>
        work({
          query: (q, v) => {
            if (q.startsWith("update public.docker_launch_requests set result_enc=")) published = true;
            return tx.query(q, v);
          },
        }),
      );
      if (published && !lost) {
        lost = true;
        throw Error("private response loss");
      }
      return result;
    },
  };
  await rejected(f.service(lostResponse).launch(f.caller, f.body), "unavailable");
  expect(lost).toBe(true);
  const [replay, concurrent] = await Promise.all([
    f.service().launch(f.caller, f.body),
    f.service().launch(f.caller, f.body),
  ]);
  expect(concurrent).toEqual(replay);
  expect(replay).toMatchObject({ promptId: f.receipt.promptId, conversationId: f.receipt.conversationId });
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 2 });
  expect(f.resolutions()).toBe(1);
  const after = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      `select request_enc from public.docker_launch_requests where sandbox_id=$1`,
      [f.body.requestId],
    )
  ).rows[0];
  expect(after?.request_enc).toEqual(before?.request_enc);
});

test("normal admission rejects unsupported input before resolution, scopes ownership and cannot adopt private reservations", async () => {
  const f = await fixture();
  for (const change of [
    { goldenId: randomUUID() },
    { env: { TOKEN: "private" } },
    { harness: "unknown" },
    { visibility: "org" },
    { image: "worker:latest" },
    { ttlSeconds: 86401 },
    { ttlSeconds: null },
    { prompt: " " },
    { credentialVersion: 0 },
    { model: "bad model" },
  ]) {
    await rejected(f.service().launch(f.caller, { ...f.body, ...change }), "invalid_request");
  }
  await rejected(f.service(sql, false).launch(f.caller, f.body), "unavailable");
  await rejected(f.service().launch({ ...f.caller, orgs: [] }, f.body), "not_found");
  expect(f.resolutions()).toBe(0);
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
  await createDockerSandboxService(sql, key, { enabled: true }).reserve(f.actor, {
    requestId: f.body.requestId,
    hostId: f.hostId,
    image: officialImage,
    credentialId: f.body.credentialId,
    credentialVersion: 2,
  });
  await rejected(f.service().launch(f.caller, f.body), "conflict");
  await rejected(f.service().launch({ ...f.caller, userId: f.otherId }, f.body), "not_found");
  expect(f.resolutions()).toBe(0);
  expect((await counts(f))?.claims).toBe(0);
});

test("admission and bound create roll back together when claim persistence fails; revoked host cannot allocate", async () => {
  const f = await fixture();
  const failClaim: Sql = {
    ...sql,
    transaction: (work) => {
      if (!sql.transaction) throw Error("transaction required");
      return sql.transaction((tx) =>
        work({
          query(q, v) {
            if (q.startsWith("insert into public.docker_launch_requests")) throw Error("private failure");
            return tx.query(q, v);
          },
        }),
      );
    },
  };
  await rejected(f.service(failClaim).launch(f.caller, f.body), "unavailable");
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
  await hosts.revoke(f.admin, f.hostId);
  await rejected(f.service().launch(f.caller, f.body), "unavailable");
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
});

test("member removal and rejoin cannot continue a pending normal claim under a new actor epoch", async () => {
  const f = await fixture();
  f.setDrive(false);
  await rejected(f.service(sql, true, 250).launch(f.caller, f.body), "unavailable");
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
  await rejected(f.service().launch(f.caller, f.body), "not_found");
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member')`, [
    f.actor.orgId,
    f.actor.userId,
  ]);
  await rejected(f.service().launch(f.caller, f.body), "not_found");
  expect(f.resolutions()).toBe(1);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 1, commands: 0 });
});

test("failed startup returns a safe failure without claiming stopped, and pending retry never starts replacement work", async () => {
  const f = await fixture();
  f.setFailure();
  await rejected(f.service().launch(f.caller, f.body), "sandbox_not_ready");
  const row = await createDockerSandboxService(sql, key).get(f.actor, f.body.requestId);
  expect(row.status).toBe("failed");
  expect(
    (
      await db.query<{ stopped_at: string | null }>(`select stopped_at from public.sandboxes where id=$1`, [
        f.body.requestId,
      ])
    ).rows[0]?.stopped_at,
  ).toBeNull();
  await rejected(f.service().launch(f.caller, f.body), "sandbox_not_ready");
  expect(f.resolutions()).toBe(1);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 1, commands: 0 });
  const cleanup = createDockerSandboxControls(sql, key, { clock: f.clock });
  await cleanup.invoke(f.caller, "stop", { id: f.body.requestId });
  await cleanup.invoke(f.caller, "delete", { id: f.body.requestId });
  expect((await createDockerSandboxService(sql, key).get(f.actor, f.body.requestId)).status).toBe("deleted");
});

test("prompt-free, image-free launch normalizes UUIDs, uses the default image, honors TTL and stops at runtime readiness", async () => {
  const f = await fixture();
  const { prompt: _prompt, ...base } = f.body;
  const body = {
    ...base,
    org: base.org.toUpperCase(),
    hostId: base.hostId.toUpperCase(),
    credentialId: base.credentialId.toUpperCase(),
    requestId: base.requestId.toUpperCase(),
    ttlSeconds: 3600,
  };
  const result = await f.service().launch(f.caller, body);
  expect(result.sandbox).toMatchObject({
    id: f.body.requestId,
    status: "ready",
    conversationIds: [],
    credentialVersion: 2,
    requestedTtlSeconds: 3600,
    image: officialImage,
  });
  expect(result.ttlSeconds).toBe(3600);
  expect(result.promptId).toBeUndefined();
  expect(result.conversationId).toBeUndefined();
  expect(
    await f
      .service(sql, true, 10_000, `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"b".repeat(64)}`)
      .launch(f.caller, body),
  ).toEqual(result);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 1 });
});

test("normal publication uses the runtime epoch rather than the independent lifecycle generation", async () => {
  const f = await fixture({ lifecycleGenerationAfterCreate: 7 });
  const result = await f.service().launch(f.caller, f.body);
  expect(result.runtime).toEqual({ kind: "armada", epoch: "1" });
  expect(result.promptId).toBe(f.receipt.promptId);
  expect(
    (
      await db.query<{ generation: string; epoch: string; runtime_generation: string }>(
        `select s.lifecycle_generation::text as generation,r.epoch::text,r.lifecycle_generation::text as runtime_generation
     from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id where s.id=$1`,
        [f.body.requestId],
      )
    ).rows[0],
  ).toEqual({ generation: "7", epoch: "1", runtime_generation: "7" });
});

test("the normal HTTP route accepts the dashboard body and returns a launched sandbox readable through normal controls", async () => {
  const f = await fixture();
  const body = dockerLaunchBody({
    org: f.actor.orgId,
    hostId: f.hostId,
    credentialId: f.body.credentialId,
    requestId: f.body.requestId,
    model: "normal-http-model",
    reasoningEffort: "high",
    prompt: f.body.prompt,
  });
  const options: ControlOptions = {
    store: createSqlVaultStore(sql),
    encryptionKey: key,
    authStore: createSqlAuthStore(sql),
    data: createSqlData(sql),
    providers: {
      resolve: async () => {
        throw Error("Docker normal launch must not fall back to a golden provider");
      },
    },
    dockerLaunch: f.service(),
    dockerControls: createDockerSandboxControls(sql, key, { clock: f.clock }),
    docker: { hosts: true, placement: true, normalApi: true, normalLaunch: true },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "fixture-anon",
      fetch: async () => Response.json({ id: f.actor.userId }),
    },
  };
  const bearer = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: f.actor.userId })).toString("base64url")}.sig`;
  async function post(path: string, input: object) {
    const response = await handleControlRequest(
      new Request(`https://armada.example/api/v1/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(input),
      }),
      options,
    );
    if (!response) throw Error("Missing normal control route");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  }
  // An acknowledged timeout must preserve the dashboard's stable request key.
  f.setDrive(false);
  options.dockerLaunch = f.service(sql, true, 250);
  const pending = await handleControlRequest(
    new Request("https://armada.example/api/v1/sandbox/launch", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
    options,
  );
  expect(pending?.status).toBe(503);
  expect(await pending?.json()).toMatchObject({ error: { code: "outcome_unknown" } });
  f.setDrive(true);
  options.dockerLaunch = f.service();
  const launched = (await post("sandbox/launch", body)) as DockerLaunchResult;
  expect(launchedDockerSandbox(launched)).toBe(f.body.requestId);
  expect(launched).toMatchObject({
    sandbox: {
      provider: "docker",
      goldenId: null,
      hostId: f.hostId,
      image: officialImage,
      model: "normal-http-model",
      reasoningEffort: "high",
      credentialVersion: 2,
      status: "running",
    },
    runtime: { kind: "armada", epoch: "1" },
    promptId: f.receipt.promptId,
    conversationId: f.receipt.conversationId,
  });
  expect(f.native).toContainEqual(
    expect.objectContaining({
      op: "prompt",
      input: expect.objectContaining({ text: f.body.prompt, model: "normal-http-model", reasoningEffort: "high" }),
    }),
  );
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 2 });
  expect(await post("sandbox/launch", body)).toEqual(launched);
  const session = f.session();
  if (!session) throw Error("Normal launch did not enrol a runtime");
  const events: AgentEvent[] = [
    {
      id: randomUUID(),
      at: 1,
      kind: "prompt",
      promptId: f.receipt.promptId,
      conversationId: f.receipt.conversationId,
      text: f.body.prompt,
      status: "running",
    },
    {
      id: randomUUID(),
      at: 2,
      kind: "message",
      promptId: f.receipt.promptId,
      conversationId: f.receipt.conversationId,
      text: "DOCKER_OK",
      partial: false,
      tools: [],
    },
    {
      id: randomUUID(),
      at: 3,
      kind: "prompt",
      promptId: f.receipt.promptId,
      conversationId: f.receipt.conversationId,
      text: f.body.prompt,
      status: "finished",
    },
  ];
  const journal = await createRuntimeEvents(authority, key).route(
    new Request("https://armada.example/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
      body: JSON.stringify({
        sandboxId: f.body.requestId,
        generation: session.epoch,
        events: events.map((event, index) => ({ sequence: index + 1, event })),
      }),
    }),
  );
  expect(journal?.status).toBe(200);
  expect(await journal?.json()).toEqual({ acknowledgedSequence: 3 });
  const scope = { org: f.actor.orgId };
  const listed = (await post("sandbox/list", scope)) as { sandboxes: SandboxListMetadata[] };
  expect(listed.sandboxes).toHaveLength(1);
  expect(listed.sandboxes[0]).toMatchObject({ id: f.body.requestId, provider: "docker", boatId: null });
  const status = (await post("sandbox/detail", { ...scope, id: f.body.requestId })) as DockerSandboxStatus;
  expect(status).toMatchObject({
    id: f.body.requestId,
    provider: "docker",
    golden: null,
    settled: true,
    prompt: { promptId: f.receipt.promptId, state: "finished" },
  });
  const logs = (await post("logs/read", { ...scope, id: f.body.requestId })) as { events: AgentEvent[] };
  expect(logs.events).toEqual(events);
  expect(JSON.stringify(logs)).not.toContain(f.secret);
  expect(await post("sandbox/stop", { ...scope, id: f.body.requestId })).toEqual({
    id: f.body.requestId,
    status: "stopped",
  });
  expect(await post("sandbox/delete", { ...scope, id: f.body.requestId })).toEqual({
    id: f.body.requestId,
    status: "deleted",
  });
  expect(f.resolutions()).toBe(1);
});

test("normal launch claims remain service-only even for their owner's user JWT", async () => {
  const f = await fixture();
  await f.service().launch(f.caller, f.body);
  for (const role of ["anon", "authenticated"]) {
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`, [f.actor.userId]);
      await tx.exec(`set local role ${role}`);
      const grants = (
        await tx.query<{ table_access: boolean; column_access: boolean }>(
          `select has_table_privilege(current_user,'public.docker_launch_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as table_access,
         has_any_column_privilege(current_user,'public.docker_launch_requests','SELECT,INSERT,UPDATE,REFERENCES') as column_access`,
        )
      ).rows[0];
      expect(grants).toEqual({ table_access: false, column_access: false });
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`, [f.actor.userId]);
        await tx.exec(`set local role ${role}`);
        await tx.query(`select request_enc,result_enc from public.docker_launch_requests where sandbox_id=$1`, [
          f.body.requestId,
        ]);
      }),
    ).rejects.toThrow("permission denied");
  }
});

// Normal launch owns selected-harness credential admission -> encrypted bootstrap -> command propagation.
test.each(["claude", "opencode"] as const)("normal Docker launch selects and bootstraps %s", async (harness) => {
  const f = await fixture({ harness });
  const launched = await f.service().launch(f.caller, f.body);
  expect(launched.sandbox.harness).toBe(harness);
  const configuration = f.session()?.configuration as Record<string, unknown>;
  expect(configuration.selectedHarness).toBe(harness);
  const env = configuration[harness === "claude" ? "claudeEnv" : "opencodeEnv"] as Record<string, string>;
  expect(env[harness === "claude" ? "ANTHROPIC_API_KEY" : "OPENCODE_API_KEY"]).toBe(f.secret);
  expect(f.native).toContainEqual(
    expect.objectContaining({ op: "prompt", input: expect.objectContaining({ harness }) }),
  );
});

test("normal Docker launch refuses caller-selected images before allocation", async () => {
  const f = await fixture();
  await rejected(f.service().launch(f.caller, { ...f.body, image: officialImage }), "invalid_request");
  expect(f.jobs).toHaveLength(0);
});

async function defaultRemote(f: Awaited<ReturnType<typeof fixture>>) {
  const registry = createSqlMcpRegistry(sql, key);
  const connection = await registry.save(f.actor.userId, f.actor.orgId, {
    name: "Docker remote",
    scope: "personal",
    transport: "http",
    url: "https://upstream.example/mcp",
    authType: "none",
  });
  await db.query("update public.mcp_grants set status='connected' where connection_id=$1", [connection.id]);
  await registry.metadata(f.actor.userId, f.actor.orgId, connection.id, { defaultForLaunch: true });
  return connection;
}

test("Docker freezes org/personal skill defaults and MCP defaults, verifies receipts and configures the epoch before first prompt", async () => {
  const f = await fixture(),
    remote = await defaultRemote(f);
  await db.query("insert into public.org_skill_defaults(org_id,skills) values($1,$2::text::jsonb)", [
    f.actor.orgId,
    JSON.stringify(["catalog/org@1.0.0"]),
  ]);
  await db.query("insert into public.personal_skill_defaults(user_id,skills) values($1,$2::text::jsonb)", [
    f.actor.userId,
    JSON.stringify(["catalog/notes@1.0.0"]),
  ]);
  const body = { ...f.body, skills: ["catalog/notes@2.0.0"] };
  f.setDrive(false);
  await rejected(f.service(sql, true, 250).launch(f.caller, body), "unavailable");
  await db.query("update public.org_skill_defaults set skills='[]' where org_id=$1", [f.actor.orgId]);
  await createSqlMcpRegistry(sql, key).metadata(f.actor.userId, f.actor.orgId, remote.id, { defaultForLaunch: false });
  f.setDrive(true);
  const launched = await f.service().launch(f.caller, body);
  const native = f.native as import("@armada/agent-runtime").RunnerRequest[];
  const install = native.find((request) => request.op === "installSkills");
  expect(install).toMatchObject({ input: { references: ["catalog/org@1.0.0", "catalog/notes@2.0.0"] } });
  const configuration = native.find((request) => request.op === "configureMcp");
  if (configuration?.op !== "configureMcp") throw Error("missing native MCP configuration");
  expect(Object.keys(configuration.configuration.servers)).toEqual([`armada_${remote.id.replaceAll("-", "_")}`]);
  expect(native.indexOf(install!)).toBeLessThan(native.findIndex((request) => request.op === "prompt"));
  expect(native.indexOf(configuration)).toBeLessThan(native.findIndex((request) => request.op === "prompt"));
  const stored = (
    await db.query<{ skills: { reference: string; checksum: string }[] }>(
      "select skills from public.sandboxes where id=$1",
      [launched.sandbox.id],
    )
  ).rows[0];
  expect(stored?.skills.map((receipt) => receipt.reference)).toEqual(["catalog/org@1.0.0", "catalog/notes@2.0.0"]);
  expect(stored?.skills.every((receipt) => /^sha256:[a-f0-9]{64}$/.test(receipt.checksum))).toBe(true);
  const server = Object.values(configuration.configuration.servers)[0];
  if (server?.type !== "http") throw Error("missing gateway transport");
  const hash = createHash("sha256")
    .update(server.headers?.Authorization?.slice(7) ?? "")
    .digest("hex");
  const leases = createSqlMcpLeasePort(sql);
  expect(await leases.validate(hash, "tools")).toMatchObject({ sandbox_id: launched.sandbox.id });
  await db.query("update public.mcp_actor_epochs set epoch=epoch+1 where org_id=$1 and user_id=$2", [
    f.actor.orgId,
    f.admin.userId,
  ]);
  expect(await leases.validate(hash, "tools")).toBeNull();
  await expect(f.service().launch(f.caller, { ...body, connections: [] })).rejects.toMatchObject({ code: "conflict" });
});

test("Docker never admits the first prompt after an invalid skill receipt", async () => {
  const f = await fixture();
  f.setMalformedSkills();
  await rejected(
    f.service().launch(f.caller, { ...f.body, skills: ["catalog/notes@1.0.0"], connections: [] }),
    "unavailable",
  );
  expect(f.native.some((request) => (request as { op: string }).op === "prompt")).toBe(false);
  const row = (
    await db.query<{ skills: unknown[] }>("select skills from public.sandboxes where id=$1", [f.body.requestId])
  ).rows[0];
  expect(row?.skills).toEqual([]);
});

test("Docker re-prepares bound MCP grants before follow-up and after same-host resume, revoking the old epoch lease", async () => {
  const f = await fixture(),
    remote = await defaultRemote(f);
  await f.service().launch(f.caller, f.body);
  const native = f.native as import("@armada/agent-runtime").RunnerRequest[];
  const configured = () => native.filter((request) => request.op === "configureMcp");
  const leaseHash = (request: (typeof native)[number]) => {
    if (request.op !== "configureMcp") throw Error("missing config");
    const server = Object.values(request.configuration.servers)[0];
    if (server?.type !== "http") throw Error("missing remote");
    return createHash("sha256")
      .update(server.headers?.Authorization?.slice(7) ?? "")
      .digest("hex");
  };
  const first = leaseHash(configured()[0]!);
  await createSqlMcpLeasePort(sql).invalidateSandbox(f.body.requestId);
  const send = createDockerNormalSend(sql, key, { enabled: true, clock: f.clock, prepareMcp: f.mcp().prepare });
  await send.send(
    f.caller,
    { request_id: randomUUID(), prompt: "follow up" },
    {
      id: f.body.requestId,
      org_id: f.actor.orgId,
      owner_id: f.actor.userId,
      status: "running",
      conversation_ids: [f.receipt.conversationId],
    },
  );
  expect(configured()).toHaveLength(2);
  const second = leaseHash(configured()[1]!);
  expect(second).not.toBe(first);
  expect(await createSqlMcpLeasePort(sql).validate(first, "tools")).toBeNull();
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    resume: bootstrap,
    prepareMcp: f.mcp().prepare,
  });
  await controls.invoke(f.caller, "stop", { id: f.body.requestId, request_id: randomUUID() });
  const resumed = await controls.invoke(f.caller, "resume", { id: f.body.requestId, request_id: randomUUID() });
  expect(resumed).toEqual({ handled: true, result: { id: f.body.requestId, status: "ready" } });
  expect(configured()).toHaveLength(3);
  expect(await createSqlMcpLeasePort(sql).validate(second, "tools")).toBeNull();
  const newest = leaseHash(configured()[2]!);
  expect(await createSqlMcpLeasePort(sql).validate(newest, "tools")).toMatchObject({
    sandbox_id: f.body.requestId,
    connection_id: remote.id,
  });
  await hosts.revoke(f.admin, f.hostId);
  expect(await createSqlMcpLeasePort(sql).validate(newest, "tools")).toBeNull();
});

test("legacy Docker claims without preparation keep their original hash and do not acquire later defaults", async () => {
  const f = await fixture();
  f.setDrive(false);
  await rejected(f.service(sql, true, 250).launch(f.caller, f.body), "unavailable");
  const row = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer>; request_hash: string }>(
      "select request_enc,request_hash from public.docker_launch_requests where sandbox_id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!row) throw Error("missing original claim");
  const manifest = JSON.parse(await decryptSecret(row.request_enc, key));
  delete manifest.preparation;
  await db.query("update public.docker_launch_requests set request_enc=$2 where sandbox_id=$1", [
    f.body.requestId,
    await encryptSecret(JSON.stringify(manifest), key),
  ]);
  await db.query("insert into public.personal_skill_defaults(user_id,skills) values($1,$2::text::jsonb)", [
    f.actor.userId,
    JSON.stringify(["catalog/later@1.0.0"]),
  ]);
  f.setDrive(true);
  expect((await f.service().launch(f.caller, f.body)).sandbox.id).toBe(f.body.requestId);
  expect(f.native.some((request) => (request as { op: string }).op === "installSkills")).toBe(false);
  expect(
    (
      await db.query<{ request_hash: string }>(
        "select request_hash from public.docker_launch_requests where sandbox_id=$1",
        [f.body.requestId],
      )
    ).rows[0]?.request_hash,
  ).toBe(row.request_hash);
});

test("Docker honors frozen launch pins without re-merging later skill defaults", async () => {
  for (const explicit of [[], ["catalog/frozen@1.0.0"]]) {
    const f = await fixture();
    await db.query("insert into public.personal_skill_defaults(user_id,skills) values($1,$2::text::jsonb)", [
      f.actor.userId,
      JSON.stringify(["catalog/later@2.0.0"]),
    ]);
    const launched = await f.service().launch(f.caller, { ...f.body, skills: explicit, skipSkillDefaults: true });
    expect(launched.sandbox.skills?.map((receipt) => receipt.reference)).toEqual(explicit);
    expect(f.native.filter((request) => (request as { op: string }).op === "installSkills")).toHaveLength(
      explicit.length ? 1 : 0,
    );
  }
});

// Template placement owner: real admission + normal Docker reservation/commands; fake host/runtime
// replies exercise transport only. Actual native execution remains the coordinator smoke's proof.
test("Docker templates freeze admission pins, use normal launch, and replay one durable allocation", async () => {
  const f = await fixture();
  const templates = createTemplateService(sql, key);
  const stores = createSqlData(sql)(f.caller);
  await db.query("insert into public.personal_skill_defaults(user_id,skills) values($1,$2::text::jsonb)", [
    f.actor.userId,
    JSON.stringify(["catalog/frozen@1.0.0"]),
  ]);
  const created = await templates.command(f.caller, "create", {
    org: f.actor.orgId,
    scope: "personal",
    name: "docker-template",
    definition: {
      provider: "docker",
      hostId: f.hostId,
      harness: "codex",
      modelAccount: { id: f.body.credentialId, version: 2 },
    },
  });
  const id = (created.item as { id: string }).id;
  let dispatches = 0,
    allocations = 0,
    starts = 0;
  const runtime: TemplateRuntime = {
    stores: { goldens: stores.goldens, sandboxes: stores.sandboxes, credentials },
    provider: async () => {
      throw Error("Docker cannot resolve a golden provider");
    },
    beforeDockerReserve: async (tx, sandboxId) => {
      allocations++;
      expect((await tx.query("select id from sandboxes where id=$1", [sandboxId])).rows).toHaveLength(0);
    },
    beforeDockerStart: async () => {
      starts++;
    },
    launchDocker: async (body, admission) => {
      dispatches++;
      await db.query("update public.personal_skill_defaults set skills=$2::text::jsonb where user_id=$1", [
        f.actor.userId,
        JSON.stringify(["catalog/changed@2.0.0"]),
      ]);
      f.body.requestId = body.requestId as typeof f.body.requestId;
      return f.service().launch(f.caller, body, admission);
    },
  };
  const input = { org: f.actor.orgId, id, requestKey: "frozen-docker", prompt: f.body.prompt };
  const result = await templates.command(f.caller, "launch", input, runtime);
  expect(result).toMatchObject({
    state: "succeeded",
    provider: "docker",
    promptId: f.receipt.promptId,
    manifest: {
      golden: null,
      host: { installationId: f.installationId, ownerId: f.admin.userId },
      resolvedSkills: ["catalog/frozen@1.0.0"],
      skillReceipts: [{ reference: "catalog/frozen@1.0.0" }],
    },
  });
  expect(
    (await db.query("select golden_operation_fence_id from template_launch_requests where id=$1", [result.requestId]))
      .rows,
  ).toEqual([{ golden_operation_fence_id: null }]);
  expect(allocations).toBe(1);
  expect(starts).toBeGreaterThan(0);
  expect(await counts(f)).toMatchObject({ sandboxes: 1, claims: 1, jobs: 2 });
  expect(await templates.command(f.caller, "launch", input, runtime)).toEqual(result);
  expect(dispatches).toBe(1);
});

test("Docker template placement refuses inaccessible, revoked and replaced host identities before reservation", async () => {
  for (const change of ["revoked", "replaced", "issuer_removed"] as const) {
    const f = await fixture();
    const templates = createTemplateService(sql, key);
    const stores = createSqlData(sql)(f.caller);
    const definition = { provider: "docker", hostId: f.hostId, harness: "codex" };
    await expect(
      templates.command(f.caller, "create", {
        org: f.actor.orgId,
        scope: "personal",
        name: "inaccessible",
        definition: { ...definition, hostId: randomUUID() },
      }),
    ).rejects.toThrow("environment_unavailable");
    const created = await templates.command(f.caller, "create", {
      org: f.actor.orgId,
      scope: "personal",
      name: "host-identity",
      definition,
    });
    const runtime: TemplateRuntime = {
      stores: { goldens: stores.goldens, sandboxes: stores.sandboxes, credentials },
      provider: async () => {
        throw Error("Docker cannot resolve a golden provider");
      },
      launchDocker: async (body, admission) => {
        if (change === "revoked") await db.query("update docker_hosts set revoked_at=now() where id=$1", [f.hostId]);
        if (change === "replaced")
          await db.query("update docker_hosts set installation_id=$2 where id=$1", [f.hostId, randomUUID()]);
        if (change === "issuer_removed")
          await db.query("delete from members where org_id=$1 and user_id=$2", [f.actor.orgId, f.admin.userId]);
        f.body.requestId = body.requestId as typeof f.body.requestId;
        return f.service().launch(f.caller, body, admission);
      },
    };
    const result = await templates.command(
      f.caller,
      "launch",
      {
        org: f.actor.orgId,
        id: (created.item as { id: string }).id,
        requestKey: change,
        prompt: f.body.prompt,
      },
      runtime,
    );
    expect(result.state).toBe("failed");
    expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
    if (change === "replaced") expect(result.reason).toBe("environment_binding_changed");
  }
});

test("a lost Docker template response retains one reconciling claim and never redispatches its key", async () => {
  const f = await fixture();
  const templates = createTemplateService(sql, key);
  const stores = createSqlData(sql)(f.caller);
  const created = await templates.command(f.caller, "create", {
    org: f.actor.orgId,
    scope: "personal",
    name: "lost-response",
    definition: { provider: "docker", hostId: f.hostId, harness: "codex" },
  });
  let dispatches = 0;
  const runtime: TemplateRuntime = {
    stores: { goldens: stores.goldens, sandboxes: stores.sandboxes, credentials },
    provider: async () => {
      throw Error("Docker cannot resolve a golden provider");
    },
    launchDocker: async (body, admission) => {
      dispatches++;
      f.body.requestId = body.requestId as typeof f.body.requestId;
      await f.service().launch(f.caller, body, admission);
      throw Error("response lost after actual normal launch committed");
    },
  };
  const input = {
    org: f.actor.orgId,
    id: (created.item as { id: string }).id,
    requestKey: "lost-response",
    prompt: f.body.prompt,
  };
  const result = await templates.command(f.caller, "launch", input, runtime);
  expect(result).toMatchObject({ state: "reconciling", id: f.body.requestId });
  expect(await templates.command(f.caller, "launch", input, runtime)).toMatchObject({
    state: "reconciling",
    id: f.body.requestId,
  });
  expect(dispatches).toBe(1);
  expect(await counts(f)).toMatchObject({ sandboxes: 1, claims: 1, jobs: 2 });
});
