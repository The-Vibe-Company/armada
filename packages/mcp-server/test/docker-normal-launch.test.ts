import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createSqlAuthStore } from "@armada/auth";
import {
  type AgentEvent,
  DOCKER_DEFAULT_IMAGE,
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  type DockerLaunchResult,
  type DockerSandboxStatus,
  type Harness,
  type LaunchCredentialResolver,
  officialSandboxImage,
  ProviderError,
  type SandboxListMetadata,
  type Sql,
  VERSION,
} from "@armada/core";
import {
  createApplicationVault,
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
import { createDockerSnapshots } from "../src/docker-snapshots.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
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
async function fixture(
  options: {
    lifecycleGenerationAfterCreate?: number;
    harness?: Harness;
    checkoutExitCode?: number;
    daemonVersion?: string;
  } = {},
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
  await hosts.poll(host.hostToken, installationId, options.daemonVersion ?? "2.28.0");
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
    failCreate: false | "plain" | "image" = false,
    malformedSkills = false;
  let session: Awaited<ReturnType<typeof authority.enrol>> | undefined;
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
  const jobs: unknown[] = [],
    native: unknown[] = [];
  async function step() {
    const job = await hosts.poll(host.hostToken, installationId, options.daemonVersion ?? "2.28.0");
    if (job) {
      jobs.push(job);
      if (job.operation === "bootstrap" || job.operation === "resume")
        session = await authority.enrol(job.bootstrap.enrolmentToken);
      const failed = failCreate && job.operation === "create";
      await hosts.complete(host.hostToken, installationId, {
        requestId: job.requestId,
        outcome: failed ? "failed" : "completed",
        ...(failed && failCreate === "image" ? { reason: "image_unavailable" as const } : {}),
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
  function mcp(target = sql) {
    const bridge = createRuntimeCommands(createRuntimeEnrolments(target, key), key, {
      now: clock.now,
      wait: (ms) => clock.wait(ms),
    });
    return createRuntimeMcp({ sql: target, key, origin: "https://armada.example", commands: bridge });
  }
  function service(target = sql, enabled = true, timeoutMs = 10_000, releaseImage: string | null = officialImage) {
    return createDockerNormalLaunch(target, key, {
      enabled,
      ...(releaseImage === null ? {} : { officialImage: releaseImage }),
      credentials: resolver,
      bootstrap,
      clock,
      timeoutMs,
      github,
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
    github,
    service,
    mcp,
    step,
    setDrive(value: boolean) {
      drive = value;
    },
    setFailure(kind: "plain" | "image" = "plain") {
      failCreate = kind;
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

test("a launch whose host could not fetch the image says so in plain words, at launch and in status", async () => {
  const f = await fixture();
  f.setFailure("image");
  await rejected(f.service().launch(f.caller, f.body), "sandbox_not_ready");
  await expect(f.service().launch(f.caller, f.body)).rejects.toThrow(DOCKER_IMAGE_UNAVAILABLE_MESSAGE);
  const status = await createDockerSandboxControls(sql, key, { clock: f.clock }).invoke(f.caller, "status", {
    id: f.body.requestId,
  });
  expect(status).toMatchObject({ result: { status: "failed", statusReason: DOCKER_IMAGE_UNAVAILABLE_MESSAGE } });
});

test("prompt-free, image-free launch normalizes UUIDs, uses the default image, honors TTL and stops at runtime readiness", async () => {
  const f = await fixture({ daemonVersion: "2.27.0" });
  const { prompt: _prompt, ...base } = f.body;
  const body = {
    ...base,
    org: base.org.toUpperCase(),
    hostId: base.hostId.toUpperCase(),
    credentialId: base.credentialId.toUpperCase(),
    requestId: base.requestId.toUpperCase(),
    ttlSeconds: 3600,
  };
  const result = await f.service(sql, true, 10_000, null).launch(f.caller, body);
  expect(result.sandbox).toMatchObject({
    id: f.body.requestId,
    status: "ready",
    conversationIds: [],
    credentialVersion: 2,
    requestedTtlSeconds: 3600,
    image: DOCKER_DEFAULT_IMAGE,
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
    harness: "codex",
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

for (const checkoutExitCode of [0, 1])
  test(`Docker checkout exit ${checkoutExitCode} gates its first prompt and scopes GitHub access`, async () => {
    const f = await fixture({ checkoutExitCode });
    await db.query(
      `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
    values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')`,
      [f.actor.userId, await encryptSecret("offline-refresh", key), await encryptSecret("offline-github-token", key)],
    );
    const remote = await defaultRemote(f);
    const body = {
      ...f.body,
      skills: ["catalog/repository@1.0.0"],
      connections: [remote.id],
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
    expect(native.filter((c) => c.op !== "health").map((c) => c.op)).toEqual([
      "configureGitHub",
      "exec",
      "installSkills",
      "configureMcp",
      "prompt",
    ]);
    expect(launched.sandbox.skills?.map((receipt) => receipt.reference)).toEqual(["catalog/repository@1.0.0"]);
    expect(native[2]?.input?.command).toContain("--branch 'feature/work'");
    expect(native[2]?.input?.command).toContain("'/home/user/project'");
    expect(JSON.stringify(native)).not.toContain("offline-github-token");
    expect(JSON.stringify(f.jobs)).not.toContain("offline-github-token");
    expect(launched.promptId).toBe(f.receipt.promptId);
    const beforeReplay = f.native.length;
    await f.service().launch(f.caller, body);
    expect(f.native).toHaveLength(beforeReplay);
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

test("Docker delivers value-free secret references through native environment and refuses new delivery after revocation", async () => {
  const f = await fixture();
  const canary = `offline-application-secret-${randomUUID()}`;
  const secretId = randomUUID();
  await db.query(
    `insert into public.application_secrets(id,org_id,owner_id,scope,name,value_enc) values($1,$2,$3,'personal','APP_TOKEN',$4)`,
    [secretId, f.actor.orgId, f.actor.userId, await encryptSecret(canary, key)],
  );
  const body = { ...f.body, secrets: [{ key: "APP_TOKEN", secretId, version: 1 }] };
  const launched = await f.service().launch(f.caller, body);
  expect((f.native as { op: string }[]).map((command) => command.op)).toEqual([
    "health",
    "configureReadableVariables",
    "prompt",
  ]);
  expect(f.native[1]).toMatchObject({ variables: { APP_TOKEN: canary } });
  expect(JSON.stringify(launched)).not.toContain(canary);
  expect(JSON.stringify(f.jobs)).not.toContain(canary);
  const claim = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      "select request_enc from public.docker_launch_requests where sandbox_id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!claim) throw Error("missing manifest");
  const manifest = JSON.parse(await decryptSecret(claim.request_enc, key));
  expect(manifest.request.secrets).toEqual(body.secrets);
  expect(JSON.stringify(manifest)).not.toContain(canary);
  const controls = createDockerSandboxControls(sql, key, { clock: f.clock, resume: bootstrap });
  await controls.invoke(f.caller, "stop", { id: f.body.requestId });
  await controls.invoke(f.caller, "resume", { id: f.body.requestId, request_id: randomUUID() });
  expect((f.native as { op: string }[]).filter((command) => command.op === "configureReadableVariables")).toHaveLength(
    2,
  );
  const row = (
    await db.query<{ id: string; org_id: string; owner_id: string; status: string; conversation_ids: string[] }>(
      "select id,org_id,owner_id,status,conversation_ids from public.sandboxes where id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!row) throw Error("missing sandbox");
  const send = createDockerNormalSend(sql, key, { enabled: true, clock: f.clock });
  const args = { request_id: randomUUID(), prompt: "Continue" };
  const sent = await send.send(f.caller, args, row);
  await db.query("update public.application_secrets set status='revoked',value_enc=null where id=$1", [secretId]);
  expect(await send.send(f.caller, args, row)).toEqual(sent);
  const before = f.native.length;
  await expect(send.send(f.caller, { request_id: randomUUID(), prompt: "New turn" }, row)).rejects.toThrow();
  expect(f.native).toHaveLength(before);
});

test("Docker secret admission rolls back inaccessible, stale, expired and oversized environments", async () => {
  const f = await fixture();
  const secretId = randomUUID();
  await db.query(
    `insert into public.application_secrets(id,org_id,owner_id,scope,name,value_enc) values($1,$2,$3,'personal','APP_TOKEN',$4)`,
    [secretId, f.actor.orgId, f.otherId, await encryptSecret("x".repeat(8192), key)],
  );
  const binding = { key: "APP_TOKEN", secretId, version: 1 };
  const launch = (secrets: unknown) => f.service().launch(f.caller, { ...f.body, secrets });
  await rejected(launch([binding]), "unavailable");
  await db.query("update public.application_secrets set owner_id=$2 where id=$1", [secretId, f.actor.userId]);
  await rejected(launch([{ ...binding, version: 2 }]), "unavailable");
  await db.query("update public.application_secrets set expires_at=now()-interval '1 second' where id=$1", [secretId]);
  await rejected(launch([binding]), "unavailable");
  await db.query("update public.application_secrets set expires_at=null where id=$1", [secretId]);
  await rejected(launch(Array.from({ length: 9 }, (_, i) => ({ ...binding, key: `APP_TOKEN_${i}` }))), "unavailable");
  for (const key of ["PATH", "OPENAI_API_KEY", "PUBLIC_TOKEN"])
    await rejected(launch([{ ...binding, key }]), "invalid_request");
  await rejected(
    f.service().launch(f.caller, {
      ...f.body,
      variables: [{ key: "APP_TOKEN", variableId: secretId, version: 1 }],
      secrets: [binding],
    }),
    "invalid_request",
  );
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
});

test("normal Docker launch refuses caller-selected images before allocation", async () => {
  const f = await fixture();
  await expect(f.service().launch(f.caller, { ...f.body, image: officialImage })).rejects.toMatchObject({
    code: "invalid_request",
    message: "Remove the image field and retry. Armada chooses the Docker environment automatically.",
  });
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
  const variable = await createApplicationVault(sql, undefined).command(f.caller, "variable", "set", {
    org: f.actor.orgId,
    scope: "personal",
    name: "APP_REGION",
    value: "offline-template-region",
  });
  const variableId = (variable.item as { id: string }).id;
  const secretId = randomUUID(),
    canary = "offline-template-secret";
  await db.query(
    "insert into public.application_secrets(id,org_id,owner_id,scope,name,value_enc) values($1,$2,$3,'personal','APP_TOKEN',$4)",
    [secretId, f.actor.orgId, f.actor.userId, await encryptSecret(canary, key)],
  );
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
      variables: [{ key: "APP_REGION", variableId, version: 1 }],
      secrets: [{ key: "APP_TOKEN", secretId, version: 1 }],
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
  expect(f.native).toContainEqual(
    expect.objectContaining({
      op: "configureReadableVariables",
      variables: { APP_REGION: "offline-template-region", APP_TOKEN: canary },
    }),
  );
  expect(JSON.stringify(result)).not.toContain(canary);
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

async function snapshotFixture(enabled = true) {
  const f = await fixture();
  for (const [userId, githubId, access] of [
    [f.actor.userId, 123, "offline-snapshot-access"],
    [f.admin.userId, 124, "offline-admin-access"],
  ] as const)
    await db.query(
      `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at) values($1,$2,'owner','Owner',$3,$4,now()+interval '2 hours')`,
      [userId, githubId, await encryptSecret("offline-refresh", key), await encryptSecret(access, key)],
    );
  const githubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url),
      admin = new Headers(init?.headers).get("authorization")?.includes("admin");
    return path.includes("/user/installations")
      ? Response.json({ installations: [] })
      : path.includes("/repos/")
        ? Response.json({
            id: 1234,
            name: "project",
            owner: { login: "example" },
            private: false,
            default_branch: "main",
          })
        : Response.json({ id: admin ? 124 : 123, login: "owner", name: "Owner" });
  }) as unknown as typeof fetch;
  const snapshots = createDockerSnapshots(sql, key, {
    enabled,
    github: {
      store: createSqlVaultStore(sql),
      app: { clientId: "offline-app", clientSecret: "offline-app-secret" },
      encryptionKey: key,
      fetch: githubFetch,
    },
    installationApp: null,
  });
  const adminCaller = { ...f.caller, userId: f.admin.userId, orgs: [{ orgId: f.actor.orgId, role: "admin" as const }] };
  const config = {
    repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
    init: ["printf built > /home/user/proof"],
  };
  return { ...f, snapshots, adminCaller, config };
}

test.each(["private", "org"] as const)(
  "host snapshot %s publication enforces visibility and launches the baked image without cloning again",
  async (visibility) => {
    const f = await snapshotFixture(),
      id = randomUUID();
    const creator = visibility === "private" ? f.caller : f.adminCaller;
    const input = {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "local-snapshot",
      visibility,
      config: f.config,
    };
    const created = await f.snapshots.command(creator, "create", input);
    expect(created).toMatchObject({ snapshot: { id, status: "building", visibility, builtOnVersion: VERSION } });
    expect(
      (await db.query("select base_image,built_on_version from public.docker_snapshots where id=$1", [id])).rows[0],
    ).toEqual({ base_image: officialSandboxImage(), built_on_version: VERSION });
    await expect(
      db.query("update public.docker_snapshots set built_on_version='0.0.1' where id=$1", [id]),
    ).rejects.toThrow("Snapshot base is immutable");
    await expect(
      db.query("update public.docker_snapshots set base_image=$2 where id=$1", [
        id,
        `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"e".repeat(64)}`,
      ]),
    ).rejects.toThrow("Snapshot base is immutable");
    expect(JSON.stringify(created)).not.toContain("offline-snapshot-access");
    expect(await f.snapshots.command(creator, "create", input)).toMatchObject({ snapshot: { id } });
    const build = await hosts.poll(f.hostToken, f.installationId);
    if (build?.operation !== "buildSnapshot") throw Error("missing snapshot build");
    expect(build.build.config).toEqual(input.config);
    expect(build.request.image).toBe(officialSandboxImage());
    expect(build.build).toMatchObject({ armadaVersion: VERSION });
    for (const fields of [{ image: officialImage }, { baseImage: officialImage }, { builtOnVersion: "0.0.1" }])
      await expect(
        f.snapshots.command(creator, "create", { ...input, requestId: randomUUID(), ...fields }),
      ).rejects.toMatchObject({ code: "invalid" });
    expect(build.build.token).toBe(visibility === "private" ? "offline-snapshot-access" : "offline-admin-access");
    const image = `sha256:${"d".repeat(64)}`;
    await hosts.complete(f.hostToken, f.installationId, { requestId: id, outcome: "completed", imageId: image });
    await hosts.complete(f.hostToken, f.installationId, { requestId: id, outcome: "completed", imageId: image });
    expect(await f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id })).toMatchObject({
      snapshot: { id, status: "ready", image, hostAvailable: true },
    });
    if (visibility === "private") {
      await expect(f.snapshots.command(f.adminCaller, "get", { org: f.actor.orgId, id })).rejects.toMatchObject({
        code: "not_found",
      });
      const resolutions = f.resolutions();
      await expect(f.service().launch(f.adminCaller, { ...f.body, snapshotId: id })).rejects.toThrow();
      expect(f.resolutions()).toBe(resolutions);
    }
    const { hostId: _, ...body } = f.body;
    const launched = await f.service().launch(f.caller, { ...body, snapshotId: id });
    expect(launched.sandbox).toMatchObject({ image, snapshotId: id, hostId: f.hostId });
    expect(f.jobs[0]).toMatchObject({ request: { image, snapshot: { id, ownerId: creator.userId, visibility } } });
    expect((f.native as { op: string }[]).map((cmd) => cmd.op)).toEqual(["health", "configureGitHub", "prompt"]);
    const controls = createDockerSandboxControls(sql, key, {
      clock: f.clock,
      resume: bootstrap,
      prepareSnapshotGitHub: f.github.prepareLaunch,
    });
    const firstEpoch = f.session()?.epoch;
    await controls.invoke(f.caller, "stop", { id: f.body.requestId });
    await controls.invoke(f.caller, "resume", { id: f.body.requestId, request_id: randomUUID() });
    expect(f.session()?.epoch).not.toBe(firstEpoch);
    expect(await f.github.status(f.caller, f.body.requestId)).toMatchObject({
      configured: true,
      runtime: { epoch: f.session()?.epoch },
    });

    await expect(
      f.snapshots.command(f.caller, "create", { ...input, requestId: randomUUID(), visibility: "org" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const beforeReplay = f.native.length;
    await db.query("update public.docker_hosts set last_seen_at=now()-interval '5 minutes' where id=$1", [f.hostId]);
    expect((await f.service().launch(f.caller, { ...body, snapshotId: id })).sandbox.id).toBe(launched.sandbox.id);
    expect(f.native).toHaveLength(beforeReplay);
    await hosts.revoke(f.admin, f.hostId);
    expect((await f.service().launch(f.caller, { ...body, snapshotId: id })).sandbox.id).toBe(launched.sandbox.id);
    expect(f.native).toHaveLength(beforeReplay);
    await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [
        visibility === "private" ? f.admin.userId : f.otherId,
      ]);
      await tx.exec("set local role authenticated");
      expect((await tx.query("select id from public.docker_snapshots where id=$1", [id])).rows).toHaveLength(
        visibility === "private" ? 0 : 1,
      );
      expect(
        (
          await tx.query(
            "select has_table_privilege(current_user,'public.docker_snapshots','INSERT,UPDATE,DELETE') as write",
          )
        ).rows[0],
      ).toEqual({ write: false });
    });
  },
);

test.each([
  ["owner-rejoined", false],
  ["issuer-rejoined", false],
  ["owner-rejoined", true],
] as const)("snapshot authorization fences %s (already delivered: %s)", async (reason, delivered) => {
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "revoked-build",
    visibility: "private",
    config: f.config,
  });
  if (reason === "issuer-rejoined")
    await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [f.actor.orgId, f.otherId]);
  if (delivered) expect((await hosts.poll(f.hostToken, f.installationId))?.operation).toBe("buildSnapshot");
  const userId = reason === "owner-rejoined" ? f.actor.userId : f.admin.userId;
  await db.query("delete from public.members where org_id=$1 and user_id=$2", [f.actor.orgId, userId]);
  await db.query("insert into public.members(org_id,user_id,role) values($1,$2,$3)", [
    f.actor.orgId,
    userId,
    reason === "issuer-rejoined" ? "admin" : "member",
  ]);
  if (delivered)
    await hosts.complete(f.hostToken, f.installationId, {
      requestId: id,
      outcome: "completed",
      imageId: `sha256:${"e".repeat(64)}`,
    });
  else expect(await hosts.poll(f.hostToken, f.installationId)).toBeNull();
  expect((await db.query("select status,image_id from public.docker_snapshots where id=$1", [id])).rows[0]).toEqual({
    status: "failed",
    image_id: null,
  });
});

test("snapshot building respects the existing Docker placement switch", async () => {
  const f = await snapshotFixture(false);
  await expect(
    f.snapshots.command(f.caller, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: randomUUID(),
      name: "disabled",
      visibility: "private",
      config: f.config,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect((await db.query("select id from public.docker_snapshots where org_id=$1", [f.actor.orgId])).rows).toHaveLength(
    0,
  );
});

test("old or unreported Docker daemons get an actionable resume refusal before any job is queued", async () => {
  const f = await fixture();
  await f.service().launch(f.caller, f.body);
  const controls = createDockerSandboxControls(sql, key, { clock: f.clock, resume: bootstrap });
  await controls.invoke(f.caller, "stop", { id: f.body.requestId, request_id: randomUUID() });
  const before = await counts(f);
  for (const version of [null, "2.27.0"]) {
    await db.query("update docker_hosts set daemon_version=$2 where id=$1", [f.hostId, version]);
    await expect(
      controls.invoke(f.caller, "resume", { id: f.body.requestId, request_id: randomUUID() }),
    ).rejects.toMatchObject({
      code: "conflict",
      retryable: false,
      message: expect.stringContaining("Update this Docker host daemon"),
    });
    expect(await counts(f)).toEqual(before);
    expect((await createDockerSandboxService(sql, key).get(f.actor, f.body.requestId)).status).toBe("stopped");
  }
});

test.each(["private", "org"] as const)(
  "snapshot rebuild %s publishes a new immutable build and retains its source and retry receipt",
  async (visibility) => {
    const f = await snapshotFixture(),
      id = randomUUID(),
      requestId = randomUUID();
    const creator = visibility === "private" ? f.caller : f.adminCaller;
    await f.snapshots.command(creator, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "rebuild-source",
      visibility,
      config: f.config,
    });
    const job = await hosts.poll(f.hostToken, f.installationId);
    if (job?.operation !== "buildSnapshot") throw Error("Missing source build");
    await hosts.complete(f.hostToken, f.installationId, {
      requestId: id,
      outcome: "completed",
      imageId: `sha256:${"d".repeat(64)}`,
    });
    const source = await f.snapshots.command(creator, "get", { org: f.actor.orgId, id });
    const input = { org: f.actor.orgId, id, requestId };
    const unauthorized = visibility === "private" ? f.adminCaller : f.caller;
    await expect(f.snapshots.command(unauthorized, "rebuild", input)).rejects.toMatchObject({
      code: visibility === "private" ? "not_found" : "forbidden",
    });
    await expect(f.snapshots.command(creator, "rebuild", { ...input, image: officialImage })).rejects.toMatchObject({
      code: "invalid",
    });
    const rebuilt = await f.snapshots.command(creator, "rebuild", input);
    expect(rebuilt).toMatchObject({
      snapshot: { id: requestId, status: "building", builtOnVersion: VERSION, name: "rebuild-source" },
    });
    expect(await f.snapshots.command(creator, "get", { org: f.actor.orgId, id })).toEqual(source);
    const build = await hosts.poll(f.hostToken, f.installationId);
    expect(build).toMatchObject({
      operation: "buildSnapshot",
      request: { image: officialSandboxImage() },
      build: { id: requestId, config: f.config, armadaVersion: VERSION },
    });
    await db.query("update docker_hosts set last_seen_at=now()-interval '5 minutes' where id=$1", [f.hostId]);
    expect(await f.snapshots.command(creator, "rebuild", input)).toMatchObject({
      snapshot: { id: requestId, status: "building", builtOnVersion: VERSION },
    });
    expect(
      (await db.query("select request_id from docker_host_jobs where request_id=$1", [requestId])).rows,
    ).toHaveLength(1);
  },
);

test("failed snapshot machine facts persist a safe reason in get and list responses", async () => {
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "failed-build",
    visibility: "private",
    config: f.config,
  });
  expect((await hosts.poll(f.hostToken, f.installationId))?.operation).toBe("buildSnapshot");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: id,
    outcome: "failed",
    reason: "snapshot_build_failed",
  });
  const failureReason =
    "Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.";
  expect(await f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id })).toMatchObject({
    snapshot: { id, status: "failed", image: null, failureReason },
  });
  expect(await f.snapshots.command(f.caller, "list", { org: f.actor.orgId })).toMatchObject({
    snapshots: [expect.objectContaining({ id, status: "failed", failureReason })],
  });
});
