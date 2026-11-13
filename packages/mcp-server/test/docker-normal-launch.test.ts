import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { createApplicationVault, createSqlVaultStore, decryptSecret, encryptSecret } from "@armada/core/server";
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
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { migratedDatabase } from "./migrated-database.ts";

let db: Awaited<ReturnType<typeof migratedDatabase>>;
const sql: Sql = {
  query: (q, v) => db.query(q, v),
  transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
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
async function fixture(
  options: { lifecycleGenerationAfterCreate?: number; harness?: Harness; checkoutExitCode?: number } = {},
) {
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
    image: `worker@sha256:${"a".repeat(64)}`,
    harness: options.harness ?? "codex",
    credentialId,
    requestId: randomUUID(),
    visibility: "private",
    prompt: "Report DOCKER_OK once",
  };
  let now = 0,
    drive = true,
    failCreate = false;
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
                ? { ready: true, generation: session.epoch }
                : command.op === "configureGitHub" || command.op === "configureReadableVariables"
                  ? { acknowledged: true }
                  : command.op === "exec"
                    ? {
                        detached: false,
                        exitCode: options.checkoutExitCode ?? 0,
                        timedOut: false,
                        stdout: "",
                        stderr: "",
                        truncated: false,
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
  const github = createRuntimeGitHub({
    sql,
    key,
    origin: "https://armada.example",
    commands: createRuntimeCommands(authority, key, {
      now: clock.now,
      wait: async () => {
        await step();
      },
    }),
    github: {
      store: createSqlVaultStore(sql),
      encryptionKey: key,
      app: { clientId: "offline-app", clientSecret: "offline-secret" },
      fetch: (async (url: string | URL | Request) =>
        String(url).includes("/repos/")
          ? Response.json({ full_name: "example/project" })
          : Response.json({ id: 123, login: "owner", name: "Owner" })) as typeof fetch,
    },
  });
  function service(target = sql, enabled = true, timeoutMs = 10_000) {
    return createDockerNormalLaunch(target, key, {
      enabled,
      credentials: resolver,
      bootstrap,
      clock,
      timeoutMs,
      github,
    });
  }
  return {
    actor,
    admin,
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
    github,
    service,
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
      image: f.body.image,
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
    { image: `other@sha256:${"b".repeat(64)}` },
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
    image: f.body.image,
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

test("prompt-free launch normalizes UUIDs, honors TTL and stops at runtime readiness", async () => {
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
  });
  expect(result.ttlSeconds).toBe(3600);
  expect(result.promptId).toBeUndefined();
  expect(result.conversationId).toBeUndefined();
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 1 });
  expect(await f.service().launch(f.caller, { ...base, ttlSeconds: 3600 })).toEqual(result);
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
    image: f.body.image,
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
      image: f.body.image,
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

for (const checkoutExitCode of [0, 1])
  test(`Docker checkout exit ${checkoutExitCode} gates its first prompt and scopes GitHub access`, async () => {
    const f = await fixture({ checkoutExitCode });
    await db.query(
      `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
    values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')`,
      [f.actor.userId, await encryptSecret("offline-refresh", key), await encryptSecret("offline-github-token", key)],
    );
    const body = {
      ...f.body,
      repos: [{ url: "https://github.com/example/project.git", branch: "feature/work", dir: "project" }],
    };
    if (checkoutExitCode !== 0) {
      await rejected(f.service().launch(f.caller, body), "sandbox_not_ready");
      expect((f.native as { op: string }[]).map((c) => c.op)).toEqual(["health", "configureGitHub", "exec"]);
      return;
    }
    const launched = await f.service().launch(f.caller, body);
    expect(launched.github).toMatchObject({ status: "connected", login: "owner" });
    const native = f.native as { op: string; input?: { command?: string } }[];
    expect(native.map((c) => c.op)).toEqual(["health", "configureGitHub", "exec", "prompt"]);
    expect(native[2]?.input?.command).toContain("--branch 'feature/work'");
    expect(native[2]?.input?.command).toContain("'/home/user/project'");
    expect(JSON.stringify(native)).not.toContain("offline-github-token");
    expect(JSON.stringify(f.jobs)).not.toContain("offline-github-token");
    expect(launched.promptId).toBe(f.receipt.promptId);
    await f.service().launch(f.caller, body);
    expect(f.native).toHaveLength(4);
    await rejected(
      f.service().launch(f.caller, { ...body, repos: [{ ...body.repos[0], branch: "other" }] }),
      "conflict",
    );
    const before = f.native.length;
    const fresh = { ...body, requestId: randomUUID() };
    for (const repos of [
      [],
      [{ ...body.repos[0], dir: "../escape" }],
      [{ ...body.repos[0], branch: "--upload-pack=evil" }],
    ]) {
      await rejected(f.service().launch(f.caller, { ...fresh, repos }), "invalid_request");
    }
    expect(f.native).toHaveLength(before);
    const controls = createDockerSandboxControls(sql, key, { clock: f.clock, resume: bootstrap, github: f.github });
    const oldCapability = (f.native[1] as { configuration: { capability: string } }).configuration.capability;
    const refreshed = await controls.invoke(f.caller, "github_refresh", { id: f.body.requestId });
    expect(refreshed).toMatchObject({
      handled: true,
      result: { status: "connected", login: "owner", runtime: { epoch: f.session()?.epoch } },
    });
    await expect(f.github.status({ ...f.caller, orgs: [] }, f.body.requestId)).rejects.toThrow();
    const row = (
      await db.query<{ id: string; org_id: string; owner_id: string; status: string; conversation_ids: string[] }>(
        "select id,org_id,owner_id,status,conversation_ids from public.sandboxes where id=$1",
        [f.body.requestId],
      )
    ).rows[0];
    if (!row) throw Error("missing sandbox");
    const beforeSend = f.native.length;
    const sendArgs = { request_id: randomUUID(), prompt: "Continue" };
    const sent = await createDockerNormalSend(sql, key, { enabled: true, clock: f.clock, github: f.github }).send(
      f.caller,
      sendArgs,
      row,
    );
    const noGitHub = createDockerNormalSend(sql, key, {
      enabled: true,
      clock: f.clock,
      github: {
        prepareTurn: async () => {
          throw Error("GitHub unavailable");
        },
      },
    });
    expect(await noGitHub.send(f.caller, sendArgs, row)).toEqual(sent);
    await expect(noGitHub.send(f.caller, { ...sendArgs, prompt: "Changed" }, row)).rejects.toThrow();
    expect((f.native.slice(beforeSend) as { op: string }[]).map((command) => command.op)).toEqual([
      "configureGitHub",
      "prompt",
    ]);
    const configured = (f.native as { op: string; configuration: { capability: string } }[]).findLast(
      (command) => command.op === "configureGitHub",
    );
    if (!configured) throw Error("missing GitHub configuration");
    let capability = configured.configuration.capability;
    const acquire = async (repository: string) =>
      f.github.route(
        new Request("https://armada.example/api/runtime/github/credentials", {
          method: "POST",
          headers: { authorization: `Bearer ${capability}` },
          body: JSON.stringify({ version: 1, repository, operation: "git" }),
        }),
      );
    expect((await acquire("example/project"))?.status).toBe(200);
    expect(
      (
        await f.github.route(
          new Request("https://armada.example/api/runtime/github/credentials", {
            method: "POST",
            headers: { authorization: `Bearer ${oldCapability}` },
            body: JSON.stringify({ version: 1, repository: "example/project", operation: "gh" }),
          }),
        )
      )?.status,
    ).toBe(403);
    expect((await acquire("example/other"))?.status).toBe(403);
    await controls.invoke(f.caller, "stop", { id: f.body.requestId });
    await controls.invoke(f.caller, "resume", { id: f.body.requestId, request_id: randomUUID() });
    expect((await f.github.status(f.caller, f.body.requestId)).configured).toBe(true);
    expect((await acquire("example/project"))?.status).toBe(403);
    const resumed = (f.native as { op: string; configuration: { capability: string } }[]).findLast(
      (command) => command.op === "configureGitHub",
    );
    if (!resumed) throw Error("missing resumed GitHub configuration");
    capability = resumed.configuration.capability;
    expect((await acquire("example/project"))?.status).toBe(200);
    await hosts.revoke(f.admin, f.hostId);
    expect((await acquire("example/project"))?.status).toBe(403);
  });

test("Docker freezes versioned readable bindings and re-delivers them before the first resumed prompt", async () => {
  const f = await fixture();
  const vault = createApplicationVault(sql, undefined);
  const value = "europe\n$(not-a-command)";
  const variable = await vault.command(f.caller, "variable", "set", {
    org: f.actor.orgId,
    scope: "personal",
    name: "APP_REGION",
    value,
  });
  const variableId = (variable.item as { id: string }).id;
  const body = { ...f.body, variables: [{ key: "APP_REGION", variableId, version: 1 }] };
  const launched = await f.service().launch(f.caller, body);
  expect((f.native as { op: string }[]).map((command) => command.op)).toEqual([
    "health",
    "configureReadableVariables",
    "prompt",
  ]);
  expect(JSON.stringify(launched)).not.toContain(value);
  expect(JSON.stringify(f.jobs)).not.toContain(value);
  await vault.command(f.caller, "variable", "update", {
    org: f.actor.orgId,
    id: variableId,
    expectedVersion: 1,
    value: "changed",
  });
  expect(await f.service().launch(f.caller, body)).toMatchObject({ promptId: launched.promptId });
  const controls = createDockerSandboxControls(sql, key, { clock: f.clock, resume: bootstrap });
  await controls.invoke(f.caller, "stop", { id: f.body.requestId });
  await controls.invoke(f.caller, "resume", { id: f.body.requestId, request_id: randomUUID() });
  const configurations = (f.native as { op: string; variables: Record<string, string> }[]).filter(
    (command) => command.op === "configureReadableVariables",
  );
  expect(configurations.map((command) => command.variables)).toEqual([{ APP_REGION: value }, { APP_REGION: value }]);
  const row = (
    await db.query<{ id: string; org_id: string; owner_id: string; status: string; conversation_ids: string[] }>(
      "select id,org_id,owner_id,status,conversation_ids from public.sandboxes where id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!row) throw Error("missing sandbox");
  await createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }).send(
    f.caller,
    { request_id: randomUUID(), prompt: "Read the variable again" },
    row,
  );
  expect((f.native as { op: string }[]).filter((command) => command.op === "configureReadableVariables")).toHaveLength(
    2,
  );
  const fresh = { ...body, requestId: randomUUID() };
  await rejected(f.service().launch(f.caller, fresh), "unavailable");
  expect((await db.query("select id from public.sandboxes where id=$1", [fresh.requestId])).rows).toHaveLength(0);
});

test("Docker variable admission rejects unsafe names and inaccessible personal references without allocating", async () => {
  const f = await fixture();
  const vault = createApplicationVault(sql, undefined);
  const other = await vault.command({ ...f.caller, userId: f.otherId }, "variable", "set", {
    org: f.actor.orgId,
    scope: "personal",
    name: "PRIVATE_REGION",
    value: "private",
  });
  const variableId = (other.item as { id: string }).id;
  await rejected(
    f.service().launch(f.caller, { ...f.body, variables: [{ key: "APP_REGION", variableId, version: 1 }] }),
    "unavailable",
  );
  for (const variables of [
    [{ key: "PATH", variableId, version: 1 }],
    [{ key: "APP_REGION", variableId, version: 0 }],
    [
      { key: "APP_REGION", variableId, version: 1 },
      { key: "APP_REGION", variableId, version: 1 },
    ],
  ])
    await rejected(f.service().launch(f.caller, { ...f.body, variables }), "invalid_request");
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
});
