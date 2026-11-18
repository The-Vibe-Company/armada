import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createSqlAuthStore } from "@armada/auth";
import {
  type AgentEvent,
  DOCKER_HOST_SNAPSHOT_BASELINE_HEADER,
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  type DockerLaunchResult,
  type DockerSandboxStatus,
  type Harness,
  type LaunchCredentialResolver,
  LaunchError,
  officialSandboxImage,
  ProviderError,
  type SandboxListMetadata,
  type Sql,
  VaultError,
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { dockerLaunchBody, launchedDockerSandbox } from "../../../apps/dashboard/src/lib/docker-launch.ts";
import { httpApi } from "../../docker-host/src/native.ts";
import { Armada, ArmadaError, type DockerSendInput, type SendInput } from "../../sdk/src/index.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { apiFailureCode } from "../src/api-failure.ts";
import type { Caller } from "../src/caller.ts";
import { type ControlOptions, dispatchControlCommand, handleControlRequest } from "../src/control.ts";
import { readLogs } from "../src/control-logs.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerNormalLaunch } from "../src/docker-normal-launch.ts";
import { createDockerNormalSend } from "../src/docker-normal-send.ts";
import { createDockerRuntimeLifecycle } from "../src/docker-runtime-lifecycle.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { createDockerSnapshots } from "../src/docker-snapshots.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { responseJsonSchema } from "../src/launch-response-schemas.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { createArmadaServer, LOGS_OUTPUT } from "../src/tools.ts";
import { migratedDatabase } from "./migrated-database.ts";
import { publishedRequest, publishedResponse } from "./published-response.ts";

let connection: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
function database() {
  if (!connection) throw new Error("Database fixture is not open");
  return connection;
}
const sql: Sql = {
  query: (q, v) => database().query(q, v),
  transaction: (work) => database().transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
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
  connection = await migratedDatabase();
});
afterAll(async () => {
  const db = connection;
  connection = undefined;
  await db?.close();
});

// The real migrated boundary owns normal-launch sequencing and durable retries.
// Existing private-lane tests own the individual host/runtime protocol matrices.
async function fixture(
  options: {
    lifecycleGenerationAfterCreate?: number;
    harness?: Harness;
    checkoutExitCode?: number;
    refreshFailure?: "auth" | "network";
    repositoryAccessDenied?: boolean;
    publicRepositoryAccess?: boolean;
    withholdWorkspace?: "timeout" | "stop";
    distinctPromptIds?: boolean;
    githubConfigurationAcknowledged?: boolean;
    refuseSkillInstall?: boolean;
    daemonVersion?: string;
  } = {},
) {
  const db = database();
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
    failCreate: false | "plain" | "image" | "disk" = false,
    malformedSkills = false;
  let session: Awaited<ReturnType<typeof authority.enrol>> | undefined;
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
  const promptReceipts = new Map<string, typeof receipt>();
  const jobs: unknown[] = [],
    native: unknown[] = [],
    checkoutStatuses: string[] = [];
  async function step() {
    for (const claim of await hosts.resumeClaimsForHost(host.hostToken, installationId))
      await hosts.claimResume(host.hostToken, installationId, claim.requestId, true);
    const job = await hosts.poll(host.hostToken, installationId, options.daemonVersion ?? "2.28.0");
    if (job) {
      jobs.push(job);
      if (job.operation === "stop" || job.operation === "delete") session = undefined;
      if (job.operation === "bootstrap" || job.operation === "resume")
        session = await authority.enrol(job.bootstrap.enrolmentToken);
      const failed = failCreate && job.operation === "create";
      await hosts.complete(host.hostToken, installationId, {
        requestId: job.requestId,
        outcome: failed ? "failed" : "completed",
        ...(failed && failCreate !== "plain"
          ? { reason: failCreate === "image" ? ("image_unavailable" as const) : ("disk_full" as const) }
          : {}),
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
        if (command.op === "installSkills" && options.refuseSkillInstall) {
          await commands.complete(session.runtimeToken, session.epoch, {
            epoch: session.epoch,
            requestId: command.requestId,
            status: 409,
            body: { version: 1, requestId: command.requestId, error: "invalid_request" },
          });
          return;
        }
        if (command.op === "workspaceExec" && options.withholdWorkspace) {
          if (options.withholdWorkspace === "stop")
            await db.query("update sandboxes set stop_requested_at=now() where id=$1", [body.requestId]);
          return;
        }
        if (command.op === "prompt" && command.input.conversationId)
          receipt.conversationId = command.input.conversationId as typeof receipt.conversationId;
        if (command.op === "prompt" && !promptReceipts.has(command.requestId))
          promptReceipts.set(
            command.requestId,
            options.distinctPromptIds && promptReceipts.size ? { ...receipt, promptId: randomUUID() } : receipt,
          );
        if (command.op === "exec")
          checkoutStatuses.push(
            (await db.query<{ status: string }>("select status from public.sandboxes where id=$1", [body.requestId]))
              .rows[0]!.status,
          );
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
                  ? {
                      acknowledged:
                        command.op !== "configureGitHub" || options.githubConfigurationAcknowledged !== false,
                    }
                  : command.op === "exec" || command.op === "workspaceExec"
                    ? {
                        detached: false,
                        exitCode:
                          command.op === "workspaceExec" && options.refreshFailure
                            ? options.refreshFailure === "network"
                              ? 75
                              : 128
                            : (options.checkoutExitCode ?? 0),
                        timedOut: false,
                        stdout: "",
                        stderr:
                          command.op === "workspaceExec" && options.refreshFailure
                            ? options.refreshFailure === "network"
                              ? "ARMADA_REPOSITORY_FETCH_FAILED\nCould not resolve host: github.com"
                              : "fatal: could not read Username for https://github.com: terminal prompts disabled"
                            : "",
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
                        : command.op === "prompt"
                          ? promptReceipts.get(command.requestId)!
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
  const publicRepositoryAccess = options.publicRepositoryAccess
    ? launchCredentials(createSqlVaultStore(sql), key, undefined, undefined, {
        store: createSqlVaultStore(sql),
        app: { clientId: "offline-app", clientSecret: "offline-app-secret" },
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          const path = String(url);
          if (path === "https://api.github.com/user") return Response.json({ id: 123, login: "owner", name: "Owner" });
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return Response.json({ private: false, full_name: "example/project" });
        }) as typeof fetch,
      }).authorizeRepositories
    : undefined;
  const resolver: Pick<LaunchCredentialResolver, "resolve" | "authorizeRepositories" | "defaults"> = {
    defaults: async (...args) => credentials.defaults?.(...args),
    ...(publicRepositoryAccess ? { authorizeRepositories: publicRepositoryAccess } : {}),
    ...(options.repositoryAccessDenied
      ? {
          async authorizeRepositories(_actor, _resolved, repos) {
            throw new LaunchError(
              "no_credentials",
              `Repository ${repos[0]!.dir} needs a GitHub connection with read access. Run armada github connect, grant your account and the Armada GitHub App access, then launch again.`,
            );
          },
        }
      : {}),
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
  function service(
    target = sql,
    enabled = true,
    timeoutMs = 10_000,
    releaseImage: string | null = officialImage,
    deferLaunch = false,
  ) {
    return createDockerNormalLaunch(target, key, {
      enabled,
      deferLaunch,
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
    checkoutStatuses,
    receipt,
    promptReceipts,
    github,
    service,
    mcp,
    step,
    setDrive(value: boolean) {
      drive = value;
    },
    setFailure(kind: "plain" | "image" | "disk" = "plain") {
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
  const db = database();
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

test("an initial actor epoch reserves a CLI-session Docker launch without weakening revocation", async () => {
  const db = database();
  const f = await fixture();
  // Members present when MCP epochs were introduced were backfilled at zero.
  await db.query("update public.mcp_actor_epochs set epoch=0 where org_id=$1 and user_id=$2", [
    f.actor.orgId,
    f.actor.userId,
  ]);
  const service = f.service(sql, true, 10_000, officialImage, true);
  await service.launch(f.caller, f.body);
  expect(
    (
      await db.query<{ actor_epoch: string }>(
        "select actor_epoch::text from public.docker_launch_requests where sandbox_id=$1",
        [f.body.requestId],
      )
    ).rows,
  ).toEqual([{ actor_epoch: "0" }]);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 1, commands: 0 });
  await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [
    f.actor.orgId,
    f.actor.userId,
  ]);
  await rejected(service.launch(f.caller, f.body), "not_found");
});

test("normal launch drives create, bootstrap, health and one first prompt, seals its claim and replays current metadata", async () => {
  const db = database();
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
    github: {
      status: "unavailable",
      message: "GitHub access requires repositories in the Docker launch or snapshot configuration.",
    },
    runtime: { kind: "armada", epoch: f.session()?.epoch },
    ttlSeconds: 14400,
    promptId: f.receipt.promptId,
    conversationId: f.receipt.conversationId,
  });
  expect(result.sandbox.createdAt).toMatch(/^\d{4}-/);
  expect(result.expiresAt).toBe(result.sandbox.expiresAt as string);
  expect(result.sandbox.model).toBeString();
  expect(result.sandbox.reasoningEffort).toBeString();
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 4 });
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
  // The user stop adds exactly one bounded final output read (#2570) after the four launch commands.
  const commands = async () =>
    (
      await db.query<{ request_id: string }>(
        `select request_id from public.runtime_commands where sandbox_id=$1 order by sequence`,
        [f.body.requestId],
      )
    ).rows.map((row) => row.request_id);
  const afterStop = await commands();
  expect(afterStop.map((id) => id.startsWith("outputs_"))).toEqual([false, false, false, false, true]);
  await db.query(`update public.credentials set status='revoked' where id=$1`, [f.body.credentialId]);
  const replay = await f.service(sql, false).launch(f.caller, f.body);
  expect(replay.sandbox.status).toBe("deleted");
  expect(replay.promptId).toBe(f.receipt.promptId);
  expect(replay.runtime).toEqual(result.runtime);
  expect(f.resolutions()).toBe(1);
  // The replay issues no runtime command.
  expect(await commands()).toEqual(afterStop);
});

test("unknown timeout and response loss survive restart and concurrent exact retries without rotating phase IDs", async () => {
  const db = database();
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
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 4 });
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

test("the published Docker launch schema admits a first prompt exactly when launch admission does", async () => {
  const f = await fixture();
  const published = publishedRequest("sandbox/launch");
  const { prompt: _prompt, ...base } = f.body;
  const snapshot = { ...base, hostId: undefined, snapshotId: randomUUID() };
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["Fix the failing test.", true],
    ["  padded  ", true],
    ["", false],
    ["   ", false],
    ["\t\n", false],
    ["  ﻿", false],
  ];
  for (const [prompt, admitted] of cases) {
    const body = prompt === undefined ? base : { ...base, prompt };
    expect(published.safeParse(body).success).toBe(admitted);
    expect(published.safeParse(prompt === undefined ? snapshot : { ...snapshot, prompt }).success).toBe(admitted);
    // Normalization runs before the placement switch: a disabled service answers an admitted body with unavailable.
    await rejected(f.service(sql, false).launch(f.caller, body), admitted ? "unavailable" : "invalid_request");
  }
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
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
  async function rejectedBeforeDispatch(work: Promise<unknown>) {
    let error: unknown;
    try {
      await work;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VaultError);
    expect(apiFailureCode(error)).toBe("dependency_unavailable");
    expect((error as Error).message).toContain("before dispatch (reservation)");
    expect((error as Error).message).not.toContain("private failure");
  }
  await rejectedBeforeDispatch(f.service(failClaim).launch(f.caller, f.body));
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
  await hosts.revoke(f.admin, f.hostId);
  await rejectedBeforeDispatch(f.service().launch(f.caller, f.body));
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
});

test("member removal and rejoin cannot continue a pending normal claim under a new actor epoch", async () => {
  const db = database();
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
  const db = database();
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

test.each([
  ["image", DOCKER_IMAGE_UNAVAILABLE_MESSAGE],
  ["disk", DOCKER_LAUNCH_FAILURE_MESSAGES.disk],
] as const)(
  "host failure retains its safe launch/status diagnostic instead of becoming an image error (%s)",
  async (reason, message) => {
    const f = await fixture();
    f.setFailure(reason);
    await rejected(f.service().launch(f.caller, f.body), "sandbox_not_ready");
    await expect(f.service().launch(f.caller, f.body)).rejects.toThrow(message);
    const runtimeReason =
      "Runtime model routing failed. Ask the server operator to check the configured model endpoint before launching again.";
    for (const [stored, expected] of [
      [message, message],
      [runtimeReason, runtimeReason],
      ["internal_private_diagnostic", DOCKER_LAUNCH_FAILURE_MESSAGES.startup],
    ]) {
      await database().query("update sandboxes set status_reason=$2 where id=$1", [f.body.requestId, stored]);
      await expect(f.service().launch(f.caller, f.body)).rejects.toThrow(expected);
      const status = await createDockerSandboxControls(sql, key, { clock: f.clock }).invoke(f.caller, "status", {
        id: f.body.requestId,
      });
      expect(status).toMatchObject({ result: { status: "failed", statusReason: expected } });
      const record = await f.service(sql, true, 10000, officialImage, true).launch(f.caller, f.body);
      expect(record).toMatchObject({ sandbox: { statusReason: expected } });
    }
  },
);

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
    image: officialSandboxImage(),
  });
  expect(result.ttlSeconds).toBe(3600);
  expect(result.promptId).toBeUndefined();
  expect(result.conversationId).toBeUndefined();
  const { post } = restControl(f, {
    dockerLaunch: f.service(sql, true, 10_000, `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"b".repeat(64)}`),
  });
  const replay = await post("sandbox/launch", { ...base, ttlSeconds: 3600 });
  publishedResponse("sandbox/launch").parse(replay);
  expect(replay).toEqual({ ...result, promptId: null, conversationId: null });
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 3 });
});

test("normal publication uses the runtime epoch rather than the independent lifecycle generation", async () => {
  const db = database();
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

/** The public REST control surface over a fixture's Docker services, authenticated as its owner. */
function restControl(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<ControlOptions> = {}) {
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
    ...overrides,
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
    const result = await response.json();
    expect({ path, status: response.status, result }).toMatchObject({ path, status: 200 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return result;
  }
  return { options, bearer, post };
}

test("SDK sends to a Docker sandbox meet the published Docker variant exactly when Docker admission accepts them", async () => {
  const f = await fixture();
  // A running sandbox: the keyed send is admitted natively, so no queued work outlives this test.
  await f.service().launch(f.caller, f.body);
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }),
  });
  const { options, bearer } = restControl(f, { dockerControls: controls });
  const sdk = new Armada({
    token: bearer,
    url: "https://armada.example",
    fetch: async (url, init) => {
      const response = await handleControlRequest(new Request(String(url), init), options);
      if (!response) throw Error("Missing normal control route");
      return response;
    },
  });
  const published = publishedRequest("sandbox/send");
  const docker = publishedRequest("sandbox/send", "Docker sandbox send");
  const ref = { org: f.actor.orgId, id: f.body.requestId };
  const keyed: DockerSendInput = { ...ref, prompt: "Keyed follow-up", request_id: randomUUID() };
  expect(docker.safeParse(keyed).success).toBe(true);
  expect(await sdk.send(keyed)).toMatchObject({ requestId: keyed.request_id, promptId: expect.any(String) });
  expect(f.native.at(-1)).toMatchObject({ op: "prompt", input: { text: keyed.prompt } });
  // Docker admission alone would take this 150 KiB prompt; the REST body limit refuses it
  // first, and the published variant says so in advance.
  const oversized: DockerSendInput = { ...ref, prompt: "x".repeat(150 * 1024), request_id: randomUUID() };
  expect(docker.safeParse(oversized).success).toBe(false);
  const dispatched = f.native.length;
  expect(await sdk.send(oversized).catch((caught: unknown) => caught)).toMatchObject({
    code: "invalid",
    status: 413,
    outcomeUnknown: false,
  });
  expect(f.native.length).toBe(dispatched);
  // The account queue keys a keyless Docker send before dispatch (covered below), so the published
  // variant accepts it.
  expect(docker.safeParse({ ...ref, prompt: "No request key" }).success).toBe(true);
  const refused: SendInput[] = [
    { ...ref, prompt: "Per-turn model", request_id: randomUUID(), model: "normal-http-model" },
  ];
  for (const input of refused) {
    // It stays a valid golden send, so only the Docker variant can tell the caller in advance.
    expect(published.safeParse(input).success).toBe(true);
    expect(docker.safeParse(input).success).toBe(false);
    const error = await sdk.send(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArmadaError);
    expect(error).toMatchObject({ code: "invalid_request", status: 400, outcomeUnknown: false });
  }
  // A REST caller reads Docker send guidance, not the generic launch-settings help.
  const raw = await handleControlRequest(
    new Request("https://armada.example/api/v1/sandbox/send", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(refused[0]),
    }),
    options,
  );
  expect(raw?.status).toBe(400);
  expect(await raw?.json()).toEqual({
    error: {
      code: "invalid_request",
      message: expect.stringContaining("model and reasoning_effort are refused"),
    },
  });
  // @ts-expect-error A Docker sandbox keeps the model chosen at launch.
  const override: DockerSendInput = { ...keyed, model: "normal-http-model" };
  void override;
});

test("Docker sends through the production-wired account queue key a legacy body, replay a keyed one, refuse overrides before queuing, and dispatch admitted rows", async () => {
  const f = await fixture();
  await f.service().launch(f.caller, f.body);
  // Wired as serve.ts does: REST sends reach the account queue first, and the queue
  // dispatches through the same route without itself, with Docker in dispatch mode.
  const accountTurns = createAccountTurnQueue(sql, key);
  const dockerControls = (dispatchQueued: boolean) =>
    createDockerSandboxControls(sql, key, {
      clock: f.clock,
      send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock, dispatchQueued }),
    });
  const { options, bearer, post } = restControl(f, { dockerControls: dockerControls(false), accountTurns });
  const { accountTurns: _queue, ...unqueued } = options;
  accountTurns.setDispatch((caller, input) =>
    dispatchControlCommand("sandbox/send", caller, { ...input }, { ...unqueued, dockerControls: dockerControls(true) }),
  );
  const sdk = new Armada({
    token: bearer,
    url: "https://armada.example",
    fetch: async (url, init) => {
      const response = await handleControlRequest(new Request(String(url), init), options);
      if (!response) throw Error("Missing normal control route");
      return response;
    },
  });
  const ref = { org: f.actor.orgId, id: f.body.requestId };
  const rows = async () =>
    (
      await database().query<{ request_id: string }>(
        "select request_id::text from public.account_turn_queue where sandbox_id=$1",
        [ref.id],
      )
    ).rows.map((row) => row.request_id);
  const refused: SendInput[] = [
    { ...ref, prompt: "Per-turn model", request_id: randomUUID(), model: "normal-http-model" },
    { ...ref, prompt: "   ", request_id: randomUUID() },
  ];
  for (const input of refused)
    expect(await sdk.send(input).catch((caught: unknown) => caught)).toMatchObject({
      code: "invalid_request",
      status: 400,
      outcomeUnknown: false,
    });
  expect(await rows()).toEqual([]);
  // The body installed iOS builds send (id, org, prompt): queued under a server-generated key.
  const legacy = { id: ref.id, org: ref.org, prompt: "Legacy keyless follow-up" };
  expect(await post("sandbox/send", legacy)).toMatchObject({ requestId: expect.any(String), status: "queued" });
  const generated = await rows();
  expect(generated).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
  const keyed: DockerSendInput = { ...ref, prompt: "Queued keyed follow-up", request_id: randomUUID() };
  const receipt = await sdk.send(keyed);
  expect(receipt).toMatchObject({ requestId: keyed.request_id, status: "queued" });
  // An identical retry returns the same durable receipt instead of queuing again.
  expect(await sdk.send(keyed)).toMatchObject({ requestId: keyed.request_id, promptId: receipt.promptId });
  expect((await rows()).sort()).toEqual([...generated, String(keyed.request_id)].sort());
  const dispatched = f.native.length;
  // The launch turn has finished, so the sandbox is free for the queued turn.
  await database().query(
    "insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled) select id,task_prompt_id,true from public.sandboxes where id=$1",
    [ref.id],
  );
  expect(await accountTurns.reconcileOne(new AbortController().signal)).toBe(true);
  await accountTurns.drain();
  // The oldest queued row, the legacy send, dispatches under its server-generated key.
  expect(f.native.slice(dispatched)).toEqual([
    expect.objectContaining({
      op: "prompt",
      requestId: `docker_prompt_${generated[0]}`,
      input: expect.objectContaining({ text: legacy.prompt }),
    }),
  ]);
});
test("canonical Docker admission replays a scoped key and makes the external reference discoverable", async () => {
  const f = await fixture();
  const { org, requestId: _requestId, ...fields } = f.body;
  const body = { ...fields, idempotencyKey: "customer_launch_1", externalRef: "customer:42" };
  const { options, post } = restControl(f, { dockerLaunch: f.service(sql, true, 10000, officialImage, true) });

  const admitted = (await post("sandbox/launch", body)) as DockerLaunchResult;
  expect(admitted.sandbox).toMatchObject({ status: "starting", externalRef: body.externalRef });
  expect(await post("sandbox/launch", { ...body, org: `normal-launch-${org}` })).toEqual(admitted);
  await expect(
    dispatchControlCommand("sandbox/launch", f.caller, { ...body, externalRef: "customer:43" }, options),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await post("sandbox/list", { org, externalRef: body.externalRef })).toMatchObject({
    sandboxes: [{ id: admitted.sandbox.id, externalRef: body.externalRef }],
  });
  expect(await post("sandbox/detail", { org, id: admitted.sandbox.id })).toMatchObject({
    externalRef: body.externalRef,
  });
  expect(await post("sandbox/list", { org, externalRef: "customer:43" })).toMatchObject({ sandboxes: [] });
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
  const { options, bearer, post } = restControl(f);
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
  // The published contract describes the dashboard's Docker request and its receipt.
  publishedRequest("sandbox/launch").parse(body);
  const launched = (await post("sandbox/launch", body)) as DockerLaunchResult;
  publishedResponse("sandbox/launch").parse(launched);
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
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 4 });
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
  const db = database();
  const f = await fixture();
  await f.service().launch(f.caller, f.body);
  for (const role of ["anon", "authenticated"]) {
    for (const table of ["docker_launch_requests", "docker_queued_prompts"]) {
      await db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`, [f.actor.userId]);
        await tx.exec(`set local role ${role}`);
        const grants = (
          await tx.query<{ table_access: boolean; column_access: boolean }>(
            `select has_table_privilege(current_user,'public.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as table_access,
         has_any_column_privilege(current_user,'public.${table}','SELECT,INSERT,UPDATE,REFERENCES') as column_access`,
          )
        ).rows[0];
        expect(grants).toEqual({ table_access: false, column_access: false });
      });
      await expect(
        db.transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`, [f.actor.userId]);
          await tx.exec(`set local role ${role}`);
          await tx.query(`select * from public.${table} where sandbox_id=$1`, [f.body.requestId]);
        }),
      ).rejects.toThrow("permission denied");
    }
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

test.each(["codex", "opencode"] as const)(
  "queued %s send passes the real MCP structured-output schema and keeps its native conversation",
  async (harness) => {
    const db = database();
    const f = await fixture({ harness });
    const launch = f.service(sql, true, 10000, officialImage, true);
    const { prompt: _prompt, ...body } = f.body;
    await launch.launch(f.caller, body);
    const stored = (
      await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
        "select request_enc from docker_launch_requests where sandbox_id=$1",
        [f.body.requestId],
      )
    ).rows[0];
    if (!stored) throw Error("missing launch");
    const planned = JSON.parse(await decryptSecret(stored.request_enc, key)).conversationId;
    const controls = createDockerSandboxControls(sql, key, {
      clock: f.clock,
      send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }),
    });
    const server = createArmadaServer(
      {
        caller: f.caller,
        data: createSqlData(sql)(f.caller),
        launchCredentials: credentials,
        dockerControls: controls,
        exposedSecrets: async () => [],
        provider: async () => {
          throw Error("Docker must not route to a cloud provider");
        },
        now: () => new Date(),
        sleep: async () => {},
      },
      "test",
    );
    const client = new Client({ name: "queued-receipt-schema", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const catalog = await client.listTools();
      const send = catalog.tools.find((t) => t.name === "send");
      if (!send?.outputSchema?.properties) throw Error("missing send output schema");
      const properties = send.outputSchema.properties as Record<string, { type: string }>;
      expect(properties.conversationId?.type).toBe("string");
      const requestId = randomUUID();
      const response = await client.callTool({
        name: "send",
        arguments: { id: f.body.requestId, request_id: requestId, prompt: "Accepted through the tool boundary" },
      });
      if (response.isError) throw Error(JSON.stringify(response._meta));
      expect(response.isError).not.toBe(true);
      const receipt = response.structuredContent as { promptId: string; conversationId: string; status: string };
      expect(receipt.status).toBe("queued");
      expect(receipt.conversationId).toMatch(/^[a-f0-9-]{36}$/);
      const conversationId = receipt.conversationId;
      expect(conversationId).toBe(planned);
      expect(f.native).toHaveLength(0);
      await launch.drain();
      await launch.drainQueued();
      expect(f.native.at(-1)).toMatchObject({ op: "prompt", input: { conversationId } });
      expect(
        (
          await db.query<{ native_conversation_id: string }>(
            "select native_conversation_id from docker_queued_prompts where sandbox_id=$1 and request_id=$2",
            [f.body.requestId, requestId],
          )
        ).rows[0]?.native_conversation_id,
      ).toBe(conversationId);
    } finally {
      await client.close();
      await server.close();
      await launch.close();
    }
  },
);

test("legacy initial prompt replay retains its already-enqueued conversation payload", async () => {
  const db = database();
  const f = await fixture();
  const server = f.service(sql, true, 10000, officialImage, true);
  await server.launch(f.caller, f.body);
  await server.drain();
  const claim = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      "select request_enc from docker_launch_requests where sandbox_id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!claim) throw Error("missing claim");
  const manifest = JSON.parse(await decryptSecret(claim.request_enc, key));
  delete manifest.conversationId;
  const commandId = `docker_prompt_${manifest.promptId}`;
  const command = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      "select request_enc from runtime_commands where sandbox_id=$1 and request_id=$2",
      [f.body.requestId, commandId],
    )
  ).rows[0];
  if (!command) throw Error("missing command");
  const old = JSON.parse(await decryptSecret(command.request_enc, key));
  delete old.input.conversationId;
  await db.query("update runtime_commands set request_enc=$3 where sandbox_id=$1 and request_id=$2", [
    f.body.requestId,
    commandId,
    await encryptSecret(JSON.stringify(old), key),
  ]);
  await db.query("update docker_launch_requests set request_enc=$2,result_enc=null where sandbox_id=$1", [
    f.body.requestId,
    await encryptSecret(JSON.stringify(manifest), key),
  ]);
  await db.query("update sandboxes set conversation_ids='{}'::text[] where id=$1", [f.body.requestId]);
  const actualConversation = f.receipt.conversationId;
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }),
  });
  const queued = await controls.invoke(f.caller, "send", {
    id: f.body.requestId,
    request_id: randomUUID(),
    prompt: "Legacy completed reply, unprojected conversation",
  });
  expect(queued).toMatchObject({ handled: true, result: { conversationId: actualConversation, status: "queued" } });
  expect(actualConversation).not.toBe(manifest.promptId);
  const before = f.native.length;
  await server.drain();
  expect((await server.launch(f.caller, f.body)).conversationId).toBe(f.receipt.conversationId);
  expect(f.native).toHaveLength(before);
  await publishFinished(f);
  await server.drainQueued();
  expect(f.native.at(-1)).toMatchObject({ op: "prompt", input: { conversationId: actualConversation } });
  await server.close();
});

async function publishFinished(f: Fixture, sequence = 0, promptId = f.receipt.promptId) {
  const db = database();
  const session = f.session();
  if (!session) throw Error("no runtime");
  const launch = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      "select request_enc from docker_launch_requests where sandbox_id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (launch) {
    const manifest = JSON.parse(await decryptSecret(launch.request_enc, key));
    if (manifest.conversationId) f.receipt.conversationId = manifest.conversationId;
  }
  const events: AgentEvent[] = [
    {
      id: randomUUID(),
      at: sequence + 1,
      kind: "prompt",
      promptId,
      conversationId: f.receipt.conversationId,
      text: "native turn",
      status: "finished",
    },
  ];
  const response = await createRuntimeEvents(authority, key).route(
    new Request("https://armada.example/api/runtime/events", {
      method: "POST",
      headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
      body: JSON.stringify({
        sandboxId: f.body.requestId,
        generation: session.epoch,
        events: events.map((event, i) => ({ sequence: sequence + i + 1, event })),
      }),
    }),
  );
  expect(response?.status).toBe(200);
}

test.each([false, true])(
  "send during accepted startup immediately returns a stable queued receipt and dispatches after preparation: initial %s",
  async (initial) => {
    const db = database();
    const f = await fixture({ distinctPromptIds: true });
    const server = f.service(sql, true, 10000, officialImage, true);
    const { prompt: _prompt, ...empty } = f.body;
    const accepted = await server.launch(f.caller, initial ? f.body : empty);
    expect(launchedDockerSandbox(accepted)).toBe(f.body.requestId);
    let waited = false;
    const sender = createDockerNormalSend(sql, key, {
      enabled: true,
      clock: {
        now: f.clock.now,
        wait: async () => {
          waited = true;
          throw Error("accepted send must not wait");
        },
      },
    });
    const controls = createDockerSandboxControls(sql, key, { send: sender, clock: f.clock });
    const args = { id: f.body.requestId, request_id: randomUUID(), prompt: "Follow up immediately" };
    const acceptedTurn = await controls.invoke(f.caller, "send", args);
    expect(acceptedTurn).toMatchObject({
      handled: true,
      result: { status: "queued", conversationId: expect.stringMatching(/^[a-f0-9-]{36}$/) },
    });
    if (!acceptedTurn.handled) throw Error("not handled");
    const queued = acceptedTurn.result as { promptId: string };
    expect(queued.promptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(waited).toBe(false);
    expect(f.native).toHaveLength(0);
    expect(await controls.invoke(f.caller, "send", args)).toEqual(acceptedTurn);
    await expect(controls.invoke(f.caller, "send", { ...args, prompt: "Changed" })).rejects.toThrow();
    expect(
      await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: queued.promptId }),
    ).toMatchObject({
      handled: true,
      result: { prompt: { promptId: queued.promptId, state: "queued" }, settled: false },
    });
    // The public REST routes (and so the SDK) observe the queued turn within the published contract.
    const rest = restControl(f, { dockerControls: controls });
    const ref = { org: f.actor.orgId, id: f.body.requestId, prompt_id: queued.promptId };
    for (const [route, input] of [
      ["sandbox/status", ref],
      ["sandbox/detail", ref],
      ["sandbox/wait", { ...ref, timeout_seconds: 0 }],
    ] as const) {
      const report = await rest.post(route, input);
      expect(report).toMatchObject({ prompt: { promptId: queued.promptId, state: "queued" }, settled: false });
      publishedResponse(route).parse(report);
    }
    // Logs report the queued turn. The published REST response and the MCP `logs` output schema
    // (closed, as MCP clients validate it) both accept it.
    const queuedLogs = await readLogs({ dockerControls: controls }, f.caller, f.body.requestId, {});
    expect(queuedLogs).toMatchObject({ queuedPrompt: { promptId: queued.promptId, state: "queued" } });
    publishedResponse("logs/read").parse(queuedLogs);
    z.fromJSONSchema(responseJsonSchema(z.object(LOGS_OUTPUT)) as Parameters<typeof z.fromJSONSchema>[0]).parse(
      queuedLogs,
    );
    await server.drain();
    if (initial) {
      await server.drainQueued();
      expect(f.native.filter((c) => (c as { op: string }).op === "prompt")).toHaveLength(1);
      await publishFinished(f);
    }
    await server.drainQueued();
    const dispatched = (
      await db.query<{ status: string; native_prompt_id: string }>(
        "select status,native_prompt_id from docker_queued_prompts where sandbox_id=$1",
        [f.body.requestId],
      )
    ).rows[0];
    const nativePrompt = f.promptReceipts.get(`docker_prompt_${args.request_id}`)?.promptId;
    if (!nativePrompt) throw Error("native prompt did not acknowledge");
    expect(dispatched).toEqual({ status: "admitted", native_prompt_id: nativePrompt });
    expect(f.native.at(-1)).toMatchObject({
      op: "prompt",
      input: { text: args.prompt, ...(initial ? { conversationId: f.receipt.conversationId } : {}) },
    });
    await publishFinished(f, initial ? 1 : 0, nativePrompt);
    expect(
      await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: queued.promptId }),
    ).toMatchObject({ handled: true, result: { prompt: { promptId: queued.promptId, state: "finished" } } });
    expect(await controls.invoke(f.caller, "logs", { id: f.body.requestId })).toMatchObject({
      handled: true,
      result: { events: expect.arrayContaining([expect.objectContaining({ promptId: queued.promptId })]) },
    });
    const before = f.native.length;
    await server.drainQueued();
    expect(f.native).toHaveLength(before);
    expect(await controls.invoke(f.caller, "send", args)).toEqual(acceptedTurn);
    await server.close();
  },
);

test.each([false, true])(
  "pre-ACK queued history and usage never expose transient native IDs: cancel %s",
  async (cancel) => {
    const db = database();
    const f = await fixture();
    const server = f.service(sql, true, 10000, officialImage, true);
    const { prompt: _prompt, ...empty } = f.body;
    await server.launch(f.caller, empty);
    const controls = createDockerSandboxControls(sql, key, {
      send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }),
      clock: f.clock,
    });
    const requestId = randomUUID();
    const accepted = await controls.invoke(f.caller, "send", {
      id: f.body.requestId,
      request_id: requestId,
      prompt: "Native journal before ACK",
    });
    if (!accepted.handled) throw Error("not handled");
    const { promptId } = accepted.result as { promptId: string };
    await server.drain();
    const waiting = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const originalWait = f.clock.wait;
    f.clock.wait = async (ms: number) => {
      const pending = (
        await db.query("select 1 from runtime_commands where sandbox_id=$1 and request_id=$2 and result_enc is null", [
          f.body.requestId,
          `docker_prompt_${requestId}`,
        ])
      ).rows.length;
      if (pending) {
        waiting.resolve();
        await release.promise;
      }
      await originalWait(ms);
    };
    const dispatch = server.drainQueued();
    await waiting.promise;
    await publishFinished(f);
    await db.query("update public.sandboxes set usage_turns=$2::jsonb where id=$1", [
      f.body.requestId,
      JSON.stringify({
        turnCount: 1,
        turns: [
          { promptId: f.receipt.promptId, model: "gpt-6.1-sol", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        ],
      }),
    ]);
    if (cancel) {
      const stopper = createDockerSandboxControls(sql, key, { clock: { now: f.clock.now, wait: originalWait } });
      await stopper.invoke(f.caller, "stop", { id: f.body.requestId });
      await server.drainQueued();
    }
    for (const direction of ["forward", "backward"]) {
      const logs = await controls.invoke(f.caller, "logs", { id: f.body.requestId, direction });
      expect(logs).toMatchObject({ handled: true, result: { events: [], cursor: null, hasMore: true } });
      expect(JSON.stringify(logs)).not.toContain(f.receipt.promptId);
    }
    expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: promptId })).toMatchObject({
      handled: true,
      result: { usage: null },
    });
    release.resolve();
    await dispatch;
    if (!cancel) {
      expect(await controls.invoke(f.caller, "logs", { id: f.body.requestId, direction: "backward" })).toMatchObject({
        handled: true,
        result: { events: expect.arrayContaining([expect.objectContaining({ promptId })]) },
      });
      expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: promptId })).toMatchObject({
        handled: true,
        result: { usage: { turns: [expect.objectContaining({ promptId })] } },
      });
    }
    await server.close();
  },
);

test("queued prompt receipt publication loss reconciles one native turn and preserves public history identity", async () => {
  const f = await fixture();
  let lost = false;
  const interrupted: Sql = {
    ...sql,
    query: async (q, v) => {
      if (!lost && q.includes("set status='admitted',native_prompt_id=")) {
        lost = true;
        throw Error("synthetic queue publication loss");
      }
      return sql.query(q, v);
    },
  };
  const server = f.service(interrupted, true, 10000, officialImage, true);
  const { prompt: _prompt, ...empty } = f.body;
  await server.launch(f.caller, empty);
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }),
  });
  const input = { id: f.body.requestId, request_id: randomUUID(), prompt: "Dispatch exactly once" };
  const admit = () =>
    observeRequest(
      async () => Response.json(await controls.invoke(f.caller, "send", input)),
      () => {},
    );
  const accepted = await admit();
  const queued = (await accepted?.json()) as Awaited<ReturnType<typeof controls.invoke>> | undefined;
  if (!queued?.handled) throw Error("not handled");
  const { promptId } = queued.result as { promptId: string };
  const replay = await admit();
  expect(await replay?.json()).toEqual(queued);
  expect(replay?.headers.get("x-request-id")).not.toBe(accepted?.headers.get("x-request-id"));
  await server.drain();
  await server.drainQueued();
  expect(lost).toBe(true);
  await publishFinished(f);
  // Journal may arrive before the queue projection write. The validated native receipt still links its public ID.
  expect(await controls.invoke(f.caller, "logs", { id: f.body.requestId })).toMatchObject({
    handled: true,
    result: { events: expect.arrayContaining([expect.objectContaining({ promptId })]) },
  });
  const recovered = f.service(sql, true, 10000, officialImage, true);
  await recovered.drainQueued();
  expect(f.native.filter((c) => (c as { op: string }).op === "prompt")).toHaveLength(1);
  expect(
    (
      await database().query("select correlation_id from runtime_commands where sandbox_id=$1 and request_id=$2", [
        input.id,
        `docker_prompt_${input.request_id}`,
      ])
    ).rows,
  ).toEqual([{ correlation_id: accepted?.headers.get("x-request-id") }]);
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: promptId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId, state: "finished" } },
  });
  await server.close();
  await recovered.close();
});

test("queued sends retain FIFO order across server recovery and stop fences dispatch", async () => {
  const f = await fixture({ distinctPromptIds: true });
  const server = f.service(sql, true, 10000, officialImage, true);
  const { prompt: _prompt, ...empty } = f.body;
  await server.launch(f.caller, empty);
  const sender = createDockerNormalSend(sql, key, { enabled: true, clock: f.clock });
  const controls = createDockerSandboxControls(sql, key, { send: sender, clock: f.clock });
  const one = { id: f.body.requestId, request_id: randomUUID(), prompt: "First queued" },
    two = { ...one, request_id: randomUUID(), prompt: "Second queued" };
  await controls.invoke(f.caller, "send", one);
  const accepted = await controls.invoke(f.caller, "send", two);
  if (!accepted.handled) throw Error("not handled");
  const { promptId } = accepted.result as { promptId: string };
  await server.drain();
  const recovered = f.service(sql, true, 10000, officialImage, true);
  await recovered.drainQueued();
  await recovered.drainQueued();
  expect(f.native.filter((c) => (c as { op: string }).op === "prompt")).toHaveLength(1);
  await publishFinished(f);
  await recovered.drainQueued();
  expect(
    (f.native.filter((c) => (c as { op: string }).op === "prompt") as { input: { text: string } }[]).map(
      (c) => c.input.text,
    ),
  ).toEqual([one.prompt, two.prompt]);
  // Existing queue replay is stable even after recovery; a later stop cannot re-wake it.
  expect(await controls.invoke(f.caller, "send", two)).toEqual(accepted);
  await controls.invoke(f.caller, "stop", { id: f.body.requestId });
  await recovered.drainQueued();
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: promptId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId, state: "interrupted" } },
  });
  await server.close();
  await recovered.close();
});

test("queued dispatch failure is visible by default until a newer ordinary send", async () => {
  const db = database();
  const f = await fixture();
  const server = f.service(sql, true, 10000, officialImage, true);
  const { prompt: _prompt, ...empty } = f.body;
  await server.launch(f.caller, empty);
  const sender = createDockerNormalSend(sql, key, { enabled: true, clock: f.clock });
  const controls = createDockerSandboxControls(sql, key, { send: sender, clock: f.clock });
  const queued = await controls.invoke(f.caller, "send", {
    id: f.body.requestId,
    request_id: randomUUID(),
    prompt: "Pinned model only",
  });
  if (!queued.handled) throw Error("not handled");
  const { promptId } = queued.result as { promptId: string };
  await server.drain();
  // Revoke the model binding after startup, at the real admission boundary rather than fake native output.
  await db.query("update public.credentials set status='revoked' where id=$1", [f.body.credentialId]);
  await server.drainQueued();
  // No native prompt may be enqueued with a revoked credential.
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId, state: "failed" } },
  });
  await db.query("update public.credentials set status='active' where id=$1", [f.body.credentialId]);
  const later = await sender.send(
    f.caller,
    { request_id: randomUUID(), prompt: "New ordinary turn" },
    { id: f.body.requestId, org_id: f.actor.orgId, owner_id: f.actor.userId, status: "ready", conversation_ids: [] },
  );
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId: later.promptId, state: "running" } },
  });
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: promptId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId, state: "failed" } },
  });
  await server.close();
});

test("startup failure terminalizes its accepted queued prompt with the real startup reason", async () => {
  const f = await fixture();
  const server = f.service(sql, true, 10000, officialImage, true);
  await server.launch(f.caller, f.body);
  const sender = createDockerNormalSend(sql, key, { enabled: true, clock: f.clock });
  const controls = createDockerSandboxControls(sql, key, { send: sender, clock: f.clock });
  const result = await controls.invoke(f.caller, "send", {
    id: f.body.requestId,
    request_id: randomUUID(),
    prompt: "Accepted before boot",
  });
  if (!result.handled) throw Error("not handled");
  const { promptId } = result.result as { promptId: string };
  f.setFailure("image");
  await server.drain();
  await server.drainQueued();
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: promptId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId, state: "failed", reason: DOCKER_IMAGE_UNAVAILABLE_MESSAGE }, settled: true },
  });
  expect(f.native).toHaveLength(0);
  await server.close();
});

test("send refreshes the first conversation when its ready row predates launch receipt publication", async () => {
  const f = await fixture();
  await f.service().launch(f.caller, f.body);
  const sender = createDockerNormalSend(sql, key, { enabled: true, clock: f.clock });
  const stale = {
    id: f.body.requestId,
    org_id: f.actor.orgId,
    owner_id: f.actor.userId,
    status: "ready",
    conversation_ids: [],
  };
  const requestId = randomUUID();
  await sender.send(f.caller, { request_id: requestId, prompt: "Continue the just-published conversation" }, stale);
  expect(f.native.at(-1)).toMatchObject({
    op: "prompt",
    input: { conversationId: f.receipt.conversationId, text: "Continue the just-published conversation" },
  });
});

test("stop after accepted starting launch bypasses queued startup and settles without allocating or prompting", async () => {
  const f = await fixture();
  const server = f.service(sql, true, 10000, officialImage, true);
  await server.launch(f.caller, f.body);
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    send: createDockerNormalSend(sql, key, { enabled: true, clock: f.clock }),
  });
  const status = await controls.invoke(f.caller, "status", { id: f.body.requestId });
  expect(status.handled && (status.result as DockerSandboxStatus).status).toBe("starting");
  const logs = await controls.invoke(f.caller, "logs", { id: f.body.requestId });
  expect(logs).toMatchObject({ handled: true, result: { events: [] } });
  const accepted = await controls.invoke(f.caller, "send", {
    id: f.body.requestId,
    request_id: randomUUID(),
    prompt: "Cancel this queued send",
  });
  if (!accepted.handled) throw Error("not handled");
  const queuedId = (accepted.result as { promptId: string }).promptId;
  expect(await controls.invoke(f.caller, "stop", { id: f.body.requestId })).toEqual({
    handled: true,
    result: { id: f.body.requestId, status: "stopped" },
  });
  expect(f.jobs.map((j) => (j as { operation: string }).operation)).toEqual(["stop"]);
  await server.drain();
  await server.drainQueued();
  expect(await controls.invoke(f.caller, "status", { id: f.body.requestId, prompt_id: queuedId })).toMatchObject({
    handled: true,
    result: { prompt: { promptId: queuedId, state: "failed" } },
  });
  expect(await hosts.poll(f.hostToken, f.installationId)).toBeNull();
  expect(f.native).toHaveLength(0);
  expect((await server.launch(f.caller, f.body)).sandbox.status).toBe("stopped");
  await server.close();
});

test("deferred launch reconciles an uncertain first-prompt receipt without marking it failed or dispatching twice", async () => {
  const f = await fixture();
  let failed = false;
  const interrupted: Sql = {
    ...sql,
    transaction: async (work) => {
      if (!sql.transaction) throw Error("transaction required");
      return sql.transaction((tx) =>
        work({
          query: (q, v) => {
            if (!failed && q.startsWith("update public.docker_launch_requests set result_enc=")) {
              failed = true;
              throw Error("synthetic lost receipt publication");
            }
            return tx.query(q, v);
          },
        }),
      );
    },
  };
  const server = f.service(interrupted, true, 10000, officialImage, true);
  const pending = await server.launch(f.caller, f.body);
  expect(pending.github).toEqual({
    status: "unavailable",
    message: "GitHub preparation has not completed for this launch.",
  });
  await server.drain();
  expect(failed).toBe(true);
  expect((await server.launch(f.caller, f.body)).sandbox.status).toBe("starting");
  const recovered = f.service(sql, true, 10000, officialImage, true);
  await recovered.drain();
  expect((await recovered.launch(f.caller, f.body)).promptId).toBe(f.receipt.promptId);
  expect((f.native as { op: string }[]).filter((c) => c.op === "prompt")).toHaveLength(1);
  await server.close();
  await recovered.close();
});

for (const scenario of ["success", "checkout-failed", "missing-github", "github-delivery-failed"] as const)
  test(`deferred repository launch returns before host work and durably completes: ${scenario}`, async () => {
    const db = database();
    const f = await fixture({
      checkoutExitCode: scenario === "checkout-failed" ? 1 : 0,
      githubConfigurationAcknowledged: scenario !== "github-delivery-failed",
    });
    const caller: Caller = { ...f.caller, via: "service" };
    if (scenario !== "missing-github")
      await db.query(
        `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
       values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')`,
        [f.actor.userId, await encryptSecret("offline-refresh", key), await encryptSecret("offline-github-token", key)],
      );
    const laterAccount = randomUUID();
    if (scenario === "success") {
      await db.query("update public.credentials set is_default=true where id=$1", [f.body.credentialId]);
      await db.query(
        "insert into public.credentials(id,version,scope,owner_id,kind,name,value_enc,is_default) values($1,1,'user',$2,'openai','Later API',$3,false)",
        [laterAccount, f.actor.userId, await encryptSecret("offline-later-default", key)],
      );
    }
    const { credentialId: _explicitAccount, ...omittedAccount } = f.body;
    const body = {
      ...(scenario === "success" ? omittedAccount : f.body),
      repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
    };
    const first = f.service(sql, true, 10000, officialImage, true);
    const accepted = await first.launch(caller, body);
    expect(accepted.sandbox.status).toBe("starting");
    expect(accepted.runtime).toBeNull();
    expect(accepted.promptId).toBeUndefined();
    expect(f.native).toHaveLength(0);
    // A fresh server instance resumes the durable manifest, not an HTTP continuation.
    const restarted = f.service(sql, true, 10000, officialImage, true);
    if (scenario === "success") {
      expect(accepted.sandbox.credentialId).toBe(f.body.credentialId);
      await db.query("update public.credentials set is_default=false where id=$1", [f.body.credentialId]);
      await db.query("update public.credentials set is_default=true where id=$1", [laterAccount]);
      await db.query(
        "update public.docker_launch_requests set worker_id=$2,worker_expires_at=now()+interval '1 hour' where sandbox_id=$1",
        [body.requestId, randomUUID()],
      );
      await restarted.drain();
      expect(f.native).toHaveLength(0);
      await db.query(
        "update public.docker_launch_requests set worker_expires_at=now()-interval '1 hour' where sandbox_id=$1",
        [body.requestId],
      );
    }
    await restarted.drain();
    const completed = await restarted.launch(caller, body);
    if (scenario === "success") {
      expect(completed.sandbox.credentialId).toBe(f.body.credentialId);
      expect(f.session()?.configuration).toMatchObject({ codexEnv: { OPENAI_API_KEY: f.secret } });
      expect(f.resolutions()).toBe(1);
      expect(f.checkoutStatuses).toEqual(["starting"]);
      expect(completed.promptId).toBe(f.receipt.promptId);
      expect(completed.runtime?.epoch).toBe(f.session()?.epoch);
      const before = f.native.length;
      await restarted.drain();
      expect(f.native).toHaveLength(before);
    } else {
      expect(completed.sandbox.status).toBe("failed");
      expect(completed.sandbox.statusReason).toBe(
        scenario === "missing-github"
          ? DOCKER_LAUNCH_FAILURE_MESSAGES.githubNotConnected
          : scenario === "github-delivery-failed"
            ? DOCKER_LAUNCH_FAILURE_MESSAGES.githubDelivery
            : DOCKER_LAUNCH_FAILURE_MESSAGES.checkout,
      );
      expect((f.native as { op: string }[]).some((c) => c.op === "prompt")).toBe(false);
      if (scenario === "missing-github") expect(f.native).toHaveLength(0);
      const controls = createDockerSandboxControls(sql, key);
      const status = await controls.invoke(caller, "status", { id: body.requestId });
      expect(status.handled && (status.result as DockerSandboxStatus).statusReason).toBe(
        completed.sandbox.statusReason,
      );
    }
    await first.close();
    await restarted.close();
  });

/** #2560: recorded launch stages of the sandbox's latest activation. */
async function launchStages(id: string) {
  const { rows } = await database().query<{ stage: string }>(
    "select stage from public.sandbox_launch_stages where sandbox_id=$1 and activation=(select max(activation) from public.sandbox_launch_stages where sandbox_id=$1)",
    [id],
  );
  return rows.map((row) => row.stage);
}

for (const checkoutExitCode of [0, 1])
  test(`Docker checkout exit ${checkoutExitCode} gates its first prompt and scopes GitHub access`, async () => {
    const db = database();
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
      expect(await launchStages(body.requestId)).not.toContain("checkout_done");
      return;
    }
    const launched = await f.service().launch(f.caller, body);
    expect(launched.github).toMatchObject({ status: "connected", login: "owner" });
    // #2560: the successful clone is timed.
    expect(await launchStages(body.requestId)).toContain("checkout_done");
    const native = f.native as { op: string; input?: { command?: string; cwd?: string } }[];
    expect(native.filter((c) => c.op !== "health").map((c) => c.op)).toEqual([
      "configureGitHub",
      "exec",
      "installSkills",
      "configureMcp",
      "prompt",
    ]);
    expect(launched.sandbox.skills?.map((receipt) => receipt.reference)).toEqual(["catalog/repository@1.0.0"]);
    expect(native.find((command) => command.op === "prompt")?.input?.cwd).toBe("/home/user/project");
    expect(
      await createDockerSandboxControls(sql, key, { clock: f.clock }).invoke(f.caller, "status", {
        id: body.requestId,
      }),
    ).toMatchObject({ handled: true, result: { repositoryDir: "project" } });
    // Retained pre-upgrade command IDs must keep their original home cwd.
    const retained = (
      await database().query<{ request_id: string; request_enc: Uint8Array<ArrayBuffer> }>(
        "select request_id,request_enc from runtime_commands where sandbox_id=$1 and starts_with(request_id,'docker_prompt_')",
        [body.requestId],
      )
    ).rows[0]!;
    const previous = JSON.parse(await decryptSecret(retained.request_enc, key));
    previous.input.cwd = "/home/user";
    await database().query("update runtime_commands set request_enc=$3 where sandbox_id=$1 and request_id=$2", [
      body.requestId,
      retained.request_id,
      await encryptSecret(JSON.stringify(previous), key),
    ]);
    const replay = await createDockerRuntimeLifecycle(sql, key, { enabled: true }).prompt(
      { userId: f.caller.userId, orgId: body.org },
      body.requestId,
      {
        requestId: retained.request_id.slice("docker_prompt_".length),
        text: previous.input.text,
        conversationId: previous.input.conversationId,
      },
    );
    expect(replay.state).toBe("admitted");

    expect(native[2]?.input?.command).toContain("'https://github.com/example/project.git' 'feature/work'");
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
  const db = database();
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
    "health",
    "configureMcp",
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
  const db = database();
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
    "health",
    "configureMcp",
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
  const db = database();
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
  const db = database();
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
  const db = database();
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
  expect(Object.keys(configuration.configuration.servers)).toEqual([
    `armada_${remote.id.replaceAll("-", "_")}`,
    "armada_self",
  ]);
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

test.each(["receipt", "runtime refusal"])(
  "Docker skill failure remains Docker-scoped and blocks the first prompt: %s",
  async (failure) => {
    const db = database();
    const f = await fixture({ refuseSkillInstall: failure === "runtime refusal" });
    if (failure === "receipt") f.setMalformedSkills();
    await rejected(
      f.service().launch(f.caller, { ...f.body, skills: ["catalog/notes@1.0.0"], connections: [] }),
      failure === "receipt" ? "unavailable" : "invalid_request",
    );
    expect(f.native.some((request) => (request as { op: string }).op === "prompt")).toBe(false);
    const row = (
      await db.query<{ skills: unknown[] }>("select skills from public.sandboxes where id=$1", [f.body.requestId])
    ).rows[0];
    expect(row?.skills).toEqual([]);
  },
);

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
  const db = database();
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
  const db = database();
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
test.each([false, true])(
  "Docker templates freeze pins and replay one host/snapshot allocation (snapshot=%s)",
  async (fromSnapshot) => {
    const db = database();
    const f = fromSnapshot ? await snapshotFixture() : await fixture();
    const snapshotId = fromSnapshot
      ? await readyTemplateSnapshot(f as Awaited<ReturnType<typeof snapshotFixture>>)
      : undefined;
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
        ...(snapshotId ? { snapshotId } : {}),
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
    if (snapshotId) {
      expect(
        (await db.query("select docker_snapshot_id,docker_image from sandboxes where id=$1", [f.body.requestId]))
          .rows[0],
      ).toEqual({ docker_snapshot_id: snapshotId, docker_image: `sha256:${"d".repeat(64)}` });
      expect(f.native).toContainEqual(expect.objectContaining({ op: "workspaceExec" }));
      await db.query("update docker_snapshots set status='failed',image_id=null,baseline_version=null where id=$1", [
        snapshotId,
      ]);
    }
    expect(await templates.command(f.caller, "launch", input, runtime)).toEqual(result);
    expect(dispatches).toBe(1);
  },
);

test("Docker template placement refuses inaccessible, revoked and replaced host identities before reservation", async () => {
  const db = database();
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

async function snapshotFixture(enabled = true, options: Parameters<typeof fixture>[0] = {}, defaultBranch = "main") {
  const db = database();
  const f = await fixture(options);
  await hosts.poll(f.hostToken, f.installationId, "2.55.0");
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
            default_branch: defaultBranch,
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

async function readyTemplateSnapshot(f: Awaited<ReturnType<typeof snapshotFixture>>) {
  const snapshotId = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: snapshotId,
    name: "template-source",
    visibility: "private",
    config: f.config,
  });
  const build = await hosts.poll(f.hostToken, f.installationId);
  if (build?.operation !== "buildSnapshot") throw Error("missing template snapshot build");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: snapshotId,
    outcome: "completed",
    imageId: `sha256:${"d".repeat(64)}`,
    baselineVersion: 1,
  });
  return snapshotId;
}

test.each([
  "private_other",
  "org_private",
  "org_shared",
  "wrong_host",
  "unready",
  "replaced",
  "removed_before_launch",
] as const)("Docker snapshot templates validate source scope/binding: %s", async (scenario) => {
  const db = database();
  const f = await snapshotFixture();
  const snapshotId = await readyTemplateSnapshot(f);
  const templates = createTemplateService(sql, key);
  const definition = { provider: "docker", hostId: f.hostId, snapshotId, harness: "codex" };
  const request = { org: f.actor.orgId, scope: "personal", name: "snapshot-template", definition };
  if (scenario === "private_other")
    await db.query("update docker_snapshots set owner_id=$2 where id=$1", [snapshotId, f.otherId]);
  if (scenario === "org_private") {
    request.scope = "org";
    await db.query("update docker_snapshots set owner_id=$2 where id=$1", [snapshotId, f.admin.userId]);
  }
  if (scenario === "org_shared") {
    request.scope = "org";
    await db.query("update docker_snapshots set visibility='org',owner_id=$2 where id=$1", [
      snapshotId,
      f.admin.userId,
    ]);
    const created = await templates.command(f.adminCaller, "create", request);
    expect(created.revision).toMatchObject({ definition: { snapshotId, hostId: f.hostId } });
    return;
  }
  if (scenario === "wrong_host") {
    const registration = await hosts.issueRegistration(f.admin);
    const other = await hosts.exchangeRegistration(registration.registrationToken, randomUUID());
    await db.query("update docker_snapshots set host_id=$2 where id=$1", [snapshotId, other.hostId]);
  }
  if (scenario === "unready")
    await db.query("update docker_snapshots set status='building',image_id=null,baseline_version=null where id=$1", [
      snapshotId,
    ]);
  if (scenario === "replaced")
    await db.query("update docker_snapshots set installation_id=$2 where id=$1", [snapshotId, randomUUID()]);
  if (scenario !== "removed_before_launch") {
    await expect(
      templates.command(scenario === "org_private" ? f.adminCaller : f.caller, "create", request),
    ).rejects.toThrow("environment_");
    return;
  }
  const created = await templates.command(f.caller, "create", request);
  await db.query("update docker_snapshots set status='failed',image_id=null,baseline_version=null where id=$1", [
    snapshotId,
  ]);
  const stores = createSqlData(sql)(f.caller);
  const launchDocker = () => {
    throw Error("unavailable snapshot must never dispatch");
  };
  await expect(
    templates.command(
      f.caller,
      "launch",
      {
        org: f.actor.orgId,
        id: (created.item as { id: string }).id,
        requestKey: "unavailable-snapshot",
      },
      {
        stores: { goldens: stores.goldens, sandboxes: stores.sandboxes, credentials },
        provider: async () => {
          throw Error("Docker cannot resolve cloud golden");
        },
        launchDocker,
      },
    ),
  ).rejects.toThrow("environment_");
  expect((await db.query("select id from sandboxes where id=$1", [f.body.requestId])).rows).toHaveLength(0);
});

test.each(["private", "org"] as const)(
  "host snapshot %s publication enforces visibility and launches the baked image without cloning again",
  async (visibility) => {
    const db = database();
    const branch = visibility === "private" ? "release+next" : "trunk";
    const daemonVersion = visibility === "private" ? VERSION : "2.51.0";
    const f = await snapshotFixture(true, {}, branch),
      id = randomUUID();
    // Admission needs a baseline-capable daemon; the org case downgrades before it builds a legacy queued request.
    expect(await hosts.poll(f.hostToken, f.installationId, VERSION)).toBeNull();
    const creator = visibility === "private" ? f.caller : f.adminCaller;
    const input = {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "local-snapshot",
      visibility,
      config: { ...f.config, repos: [{ url: f.config.repos[0]!.url }] },
    };
    if (visibility === "private") {
      expect(await hosts.poll(f.hostToken, f.installationId, "2.51.0")).toBeNull();
      await expect(f.snapshots.command(creator, "create", input)).rejects.toThrow(
        "This snapshot uses a ref that requires a newer Docker host daemon.",
      );
      expect(await hosts.poll(f.hostToken, f.installationId, daemonVersion)).toBeNull();
    }
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
    const build = await hosts.poll(f.hostToken, f.installationId, daemonVersion);
    if (build?.operation !== "buildSnapshot") throw Error("missing snapshot build");
    expect(build.build.config).toEqual({
      ...f.config,
      repos: [{ ...f.config.repos[0]!, branch }],
    });
    expect(build.request.image).toBe(officialSandboxImage());
    expect(build.build).toMatchObject({ armadaVersion: VERSION });
    for (const fields of [{ image: officialImage }, { baseImage: officialImage }, { builtOnVersion: "0.0.1" }])
      await expect(
        f.snapshots.command(creator, "create", { ...input, requestId: randomUUID(), ...fields }),
      ).rejects.toMatchObject({ code: "invalid" });
    expect(build.build.token).toBe(visibility === "private" ? "offline-snapshot-access" : "offline-admin-access");
    const image = `sha256:${"d".repeat(64)}`;
    // A build queued before the baseline requirement keeps its legacy receipt contract.
    if (visibility === "org")
      await db.query("update docker_snapshots set required_baseline_version=null where id=$1", [id]);
    const result = {
      requestId: id,
      outcome: "completed",
      imageId: image,
      ...(visibility === "private" ? { baselineVersion: 1 } : {}),
    } as const;
    await hosts.complete(f.hostToken, f.installationId, result);
    await hosts.complete(f.hostToken, f.installationId, result);
    expect(await f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id })).toMatchObject({
      snapshot: {
        id,
        status: "ready",
        image,
        hostAvailable: true,
        baselineVersion: visibility === "private" ? 1 : null,
        baselineOutdated: visibility === "org",
        ...(visibility === "org"
          ? { baselineWarning: expect.stringContaining("Docker host daemon 2.51.0 is outdated") }
          : {}),
      },
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
    // The published launch contract and the handler agree on the Docker source shapes:
    // a snapshot body without hostId is valid; no source, or a snapshot with repos, is refused by both.
    const published = publishedRequest("sandbox/launch");
    published.parse({ ...body, snapshotId: id });
    published.parse({ ...f.body, snapshotId: id });
    const repos = [{ url: "https://github.com/example/project.git" }];
    for (const refused of [body, { ...body, snapshotId: id, repos }, { ...f.body, snapshotId: id, repos }]) {
      const attempt = { ...refused, requestId: randomUUID() };
      expect(published.safeParse(attempt).success).toBe(false);
      await rejected(f.service().launch(f.caller, attempt), "invalid_request");
    }
    const launched = await f.service().launch(f.caller, { ...body, snapshotId: id });
    expect(launched.sandbox).toMatchObject({ image, snapshotId: id, hostId: f.hostId });
    expect(f.jobs[0]).toMatchObject({ request: { image, snapshot: { id, ownerId: creator.userId, visibility } } });
    expect((f.native as { op: string }[]).map((cmd) => cmd.op)).toEqual([
      "health",
      "configureGitHub",
      "workspaceExec",
      "health",
      "configureMcp",
      "prompt",
    ]);
    const refresh = (f.native as { op: string; input?: { command: string } }[]).find(
      (command) => command.op === "workspaceExec",
    );
    expect(refresh?.input?.command).toContain("git fetch origin");
    expect(refresh?.input?.command).not.toContain("credential.helper=");
    expect(refresh?.input?.command).not.toContain("git clone");
    expect(refresh?.input?.command).not.toContain("printf built");
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

test("snapshot caller-access port refuses before Docker host admission with the requested repository remedy", async () => {
  const f = await snapshotFixture(true, { repositoryAccessDenied: true });
  const id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "access-proof",
    visibility: "private",
    config: f.config,
  });
  const build = await hosts.poll(f.hostToken, f.installationId);
  if (build?.operation !== "buildSnapshot") throw Error("Snapshot fixture build missing");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: id,
    outcome: "completed",
    imageId: `sha256:${"f".repeat(64)}`,
    baselineVersion: 1,
  });
  const { hostId: _, ...body } = f.body;
  const before = await counts(f);
  await expect(
    f.service(sql, true, 10000, officialImage, true).launch(f.caller, { ...body, snapshotId: id }),
  ).rejects.toMatchObject({
    code: "no_credentials",
    message: expect.stringContaining("Repository project needs a GitHub connection"),
  });
  expect(await counts(f)).toEqual(before);
  expect(f.jobs).toEqual([]);
  expect(f.native).toEqual([]);
});

test.each([false, true])(
  "public snapshot refresh remains anonymous when GitHub is disconnected (deferred=%s)",
  async (deferred) => {
    const db = database();
    const f = await snapshotFixture(true, { publicRepositoryAccess: true });
    const id = randomUUID();
    await f.snapshots.command(f.caller, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "public-refresh",
      visibility: "private",
      config: f.config,
    });
    const build = await hosts.poll(f.hostToken, f.installationId);
    if (build?.operation !== "buildSnapshot") throw Error("Snapshot fixture build missing");
    await hosts.complete(f.hostToken, f.installationId, {
      requestId: id,
      outcome: "completed",
      imageId: `sha256:${"a".repeat(64)}`,
      baselineVersion: 1,
    });
    const { hostId: _, ...body } = f.body;
    const service = f.service(sql, true, 10000, officialImage, deferred);
    try {
      // Deferred work rechecks the caller after admission; public visibility remains provable anonymously.
      if (!deferred) await db.query("delete from github_connections where user_id=$1", [f.actor.userId]);
      let result = await service.launch(f.caller, { ...body, snapshotId: id });
      if (deferred) {
        await db.query("delete from github_connections where user_id=$1", [f.actor.userId]);
        await service.drain();
        result = await service.launch(f.caller, { ...body, snapshotId: id });
      }
      expect(result.sandbox.status).toBe("running");
      expect(result.github.status).toBe("not_connected");
      const operations = (f.native as { op: string }[]).map((command) => command.op);
      expect(operations).toEqual(["health", "workspaceExec", "health", "configureMcp", "prompt"]);
      const refresh = (f.native as { op: string; input?: { command: string } }[]).find(
        (command) => command.op === "workspaceExec",
      );
      expect(refresh?.input?.command).toContain("git fetch origin");
      expect(refresh?.input?.command).not.toContain("git clone");
      expect(refresh?.input?.command).not.toContain("printf built");
      // #2560: the successful snapshot refresh is timed.
      expect(await launchStages(result.sandbox.id)).toContain("checkout_done");
    } finally {
      await service.close();
    }
  },
);

test.each(["timeout", "stop"] as const)(
  "snapshot refresh wait honors launch admission while its runtime reply is withheld (%s)",
  async (mode) => {
    const f = await snapshotFixture(true, { withholdWorkspace: mode });
    const id = randomUUID();
    await f.snapshots.command(f.caller, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "bounded-refresh",
      visibility: "private",
      config: f.config,
    });
    const build = await hosts.poll(f.hostToken, f.installationId);
    if (build?.operation !== "buildSnapshot") throw Error("Snapshot fixture build missing");
    await hosts.complete(f.hostToken, f.installationId, {
      requestId: id,
      outcome: "completed",
      imageId: `sha256:${"c".repeat(64)}`,
      baselineVersion: 1,
    });
    const { hostId: _, ...body } = f.body;
    const startedAt = f.clock.now();
    await expect(f.service(sql, true, 5000).launch(f.caller, { ...body, snapshotId: id })).rejects.toBeInstanceOf(
      ProviderError,
    );
    const elapsed = f.clock.now() - startedAt;
    expect(elapsed).toBeLessThanOrEqual(5250);
    if (mode === "timeout") expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect((f.native as { op: string }[]).some((command) => command.op === "workspaceExec")).toBe(true);
    expect((f.native as { op: string }[]).some((command) => command.op === "prompt")).toBe(false);
  },
);

test.each(["auth", "auth-deferred", "network"] as const)(
  "snapshot refresh uses the shared authorization/fallback policy before prompt (%s)",
  async (mode) => {
    const db = database();
    const f = await snapshotFixture(true, { refreshFailure: mode === "network" ? "network" : "auth" });
    const id = randomUUID();
    await f.snapshots.command(f.caller, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "refresh-policy",
      visibility: "private",
      config: f.config,
    });
    const build = await hosts.poll(f.hostToken, f.installationId);
    if (build?.operation !== "buildSnapshot") throw Error("Snapshot fixture build missing");
    await hosts.complete(f.hostToken, f.installationId, {
      requestId: id,
      outcome: "completed",
      imageId: `sha256:${"e".repeat(64)}`,
      baselineVersion: 1,
    });
    const { hostId: _, ...body } = f.body;
    const request = { ...body, snapshotId: id };
    const service = f.service(sql, true, 10000, officialImage, mode === "auth-deferred");
    try {
      if (mode === "network") {
        const result = await service.launch(f.caller, request);
        expect(result.github.message).toContain("repository project");
        expect(result.github.message).toContain("snapshot checkout");
        expect((f.native as { op: string }[]).map((command) => command.op)).toEqual([
          "health",
          "configureGitHub",
          "workspaceExec",
          "health",
          "configureMcp",
          "prompt",
        ]);
      } else {
        if (mode === "auth-deferred") {
          // Admission is recorded as such; the worker's real outcome joins the admitting request's ID.
          const records: Record<string, unknown>[] = [];
          let admitted: Awaited<ReturnType<typeof service.launch>> | undefined;
          const response = await observeRequest(
            async () => {
              admitted = await service.launch(f.caller, request);
              return new Response(null, { status: 201 });
            },
            (line) => records.push(JSON.parse(line)),
          );
          expect(admitted?.sandbox.status).toBe("starting");
          const requestId = response?.headers.get("x-request-id");
          expect(records.filter((record) => record.event === "provider_call")).toEqual([
            expect.objectContaining({ requestId, provider: "docker", operation: "launch.admit", outcome: "ok" }),
          ]);
          // A retry of the pending admission is answered from the database: no host job, no record.
          const jobs = async () =>
            (
              await db.query("select request_id from docker_host_jobs where bound_sandbox_id=$1", [
                admitted?.sandbox.id,
              ])
            ).rows.length;
          const queuedJobs = await jobs();
          records.length = 0;
          await observeRequest(
            async () => {
              expect((await service.launch(f.caller, request)).sandbox.status).toBe("starting");
              return new Response(null, { status: 201 });
            },
            (line) => records.push(JSON.parse(line)),
          );
          expect(records.map((record) => record.event)).toEqual(["http_request"]);
          expect(await jobs()).toBe(queuedJobs);
          const background = spyOn(console, "error").mockImplementation(() => {});
          const warnings = spyOn(console, "warn").mockImplementation(() => {});
          try {
            await service.drain();
            const worker = background.mock.calls
              .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined))
              .filter((record) => record?.event === "provider_call" && record.operation === "launch");
            expect(worker).toEqual([expect.objectContaining({ requestId, provider: "docker", outcome: "error" })]);
            expect(warnings.mock.calls).toContainEqual([
              "docker_launch_failed",
              expect.objectContaining({ requestId }),
            ]);
          } finally {
            background.mockRestore();
            warnings.mockRestore();
          }
          expect(
            (
              await db.query<{ status_reason: string }>("select status_reason from sandboxes where id=$1", [
                f.body.requestId,
              ])
            ).rows[0]?.status_reason,
          ).toContain("Repository project needs a GitHub connection");
        }
        if (mode === "auth-deferred") {
          const replay = await service.launch(f.caller, request);
          expect(replay.sandbox).toMatchObject({
            status: "failed",
            statusReason: expect.stringContaining("Repository project needs a GitHub connection"),
          });
        } else
          await expect(service.launch(f.caller, request)).rejects.toMatchObject({
            code: "no_credentials",
            message: expect.stringContaining("Repository project needs a GitHub connection"),
          });
        expect((f.native as { op: string }[]).some((command) => command.op === "prompt")).toBe(false);
      }
      const refresh = (f.native as { op: string; input?: { command: string } }[]).find(
        (command) => command.op === "workspaceExec",
      );
      expect(refresh?.input?.command).toContain("git fetch origin");
      expect(refresh?.input?.command).not.toContain("credential.helper=");
      expect(refresh?.input?.command).not.toContain("git clone");
    } finally {
      await service.close();
    }
  },
);

test.each([
  ["owner-rejoined", false],
  ["issuer-rejoined", false],
  ["owner-rejoined", true],
] as const)("snapshot authorization fences %s (already delivered: %s)", async (reason, delivered) => {
  const db = database();
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
      baselineVersion: 1,
    });
  else expect(await hosts.poll(f.hostToken, f.installationId)).toBeNull();
  expect((await db.query("select status,image_id from public.docker_snapshots where id=$1", [id])).rows[0]).toEqual({
    status: "failed",
    image_id: null,
  });
});

test("snapshot building respects the existing Docker placement switch", async () => {
  const db = database();
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

test("a draining host refuses a snapshot build with the uninstall reason, not Host unavailable", async () => {
  const db = database();
  const f = await snapshotFixture();
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  await expect(
    f.snapshots.command(f.caller, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: randomUUID(),
      name: "draining",
      visibility: "private",
      config: f.config,
    }),
  ).rejects.toMatchObject({ code: "host_draining", message: expect.stringContaining("draining for uninstall") });
  expect((await db.query("select id from public.docker_snapshots where org_id=$1", [f.actor.orgId])).rows).toHaveLength(
    0,
  );
});

test("launching a saved snapshot on a draining host names the uninstall, not an unavailable snapshot", async () => {
  const db = database();
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "draining-source",
    visibility: "private",
    config: f.config,
  });
  const build = await hosts.poll(f.hostToken, f.installationId);
  if (build?.operation !== "buildSnapshot") throw Error("missing snapshot build");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: id,
    outcome: "completed",
    imageId: `sha256:${"b".repeat(64)}`,
    baselineVersion: 1,
  });
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  const { hostId: _, ...body } = f.body;
  await expect(f.service().launch(f.caller, { ...body, snapshotId: id })).rejects.toMatchObject({
    code: "host_draining",
    message: expect.stringContaining("draining for uninstall"),
  });
  expect(f.jobs).toEqual([]);
});

test("a retry of an already-admitted launch from a saved snapshot replays it after a drain", async () => {
  const db = database();
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "draining-retry",
    visibility: "private",
    config: f.config,
  });
  const build = await hosts.poll(f.hostToken, f.installationId);
  if (build?.operation !== "buildSnapshot") throw Error("missing snapshot build");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: id,
    outcome: "completed",
    imageId: `sha256:${"e".repeat(64)}`,
    baselineVersion: 1,
  });
  const { hostId: _, ...body } = f.body;
  const launched = await f.service().launch(f.caller, { ...body, snapshotId: id });
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  // Admission is historical: a lost response replays the saved sandbox, not a drain refusal.
  expect((await f.service().launch(f.caller, { ...body, snapshotId: id })).sandbox.id).toBe(launched.sandbox.id);
});

test("rebuilding a snapshot on a draining host names the uninstall, not a missing original host", async () => {
  const db = database();
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "draining-rebuild",
    visibility: "private",
    config: f.config,
  });
  const build = await hosts.poll(f.hostToken, f.installationId);
  if (build?.operation !== "buildSnapshot") throw Error("missing snapshot build");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: id,
    outcome: "completed",
    imageId: `sha256:${"c".repeat(64)}`,
    baselineVersion: 1,
  });
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  await expect(
    f.snapshots.command(f.caller, "rebuild", { org: f.actor.orgId, id, requestId: randomUUID() }),
  ).rejects.toMatchObject({ code: "host_draining", message: expect.stringContaining("draining for uninstall") });
});

test("a queued snapshot build interrupted by a drain persists the uninstall reason, not lost authorization", async () => {
  const db = database();
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "queued-drain",
    visibility: "private",
    config: f.config,
  });
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  // The daemon's next poll cannot take the queued build: the build fails with the action the user can take.
  expect(await hosts.poll(f.hostToken, f.installationId)).toBeNull();
  expect(
    (
      await db.query<{ status: string; failure_reason: string }>(
        "select status,failure_reason from public.docker_snapshots where id=$1",
        [id],
      )
    ).rows[0],
  ).toMatchObject({ status: "failed", failure_reason: expect.stringContaining("draining for uninstall") });
});

test("old or unreported Docker daemons get an actionable resume refusal before any job is queued", async () => {
  const db = database();
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

test("snapshot admission distinguishes daemon builds that report the same release", async () => {
  const f = await snapshotFixture();
  const route = createDockerHostRoutes(hosts, async () => ({ ok: true, caller: f.caller }), {
    snapshots: f.snapshots,
  });
  const poll = (capable: boolean) =>
    route(
      new Request("https://fixture.example/api/docker-host/poll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.hostToken}`,
          ...(capable ? { [DOCKER_HOST_SNAPSHOT_BASELINE_HEADER]: "1" } : {}),
        },
        body: JSON.stringify({ installationId: f.installationId, version: "2.54.0" }),
      }),
    );
  const requestId = randomUUID();
  const create = () =>
    route(
      new Request("https://fixture.example/api/v1/docker/snapshots/create", {
        method: "POST",
        body: JSON.stringify({
          org: f.actor.orgId,
          hostId: f.hostId,
          requestId,
          name: "baseline-required",
          config: f.config,
        }),
      }),
    );
  expect(await (await poll(false))?.json()).toMatchObject({ job: null });
  const response = await create();
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({
    error: {
      code: "host_update_required",
      message: expect.stringContaining("verify the developer baseline"),
    },
  });
  expect(await (await poll(true))?.json()).toMatchObject({ job: null });
  expect((await create())?.status).toBe(200);
});

test("a verified receipt survives retry from an older replica to the current route", async () => {
  const f = await snapshotFixture();
  const requestId = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId,
    name: "mixed-replicas",
    config: f.config,
  });
  const job = await hosts.poll(f.hostToken, f.installationId);
  if (job?.operation !== "buildSnapshot") throw Error("Missing build job");
  const route = createDockerHostRoutes(hosts, async () => ({ ok: false }));
  let firstRequest = true;
  const request = (async (url, init) => {
    if (firstRequest) {
      firstRequest = false;
      expect(JSON.parse(String(init?.body)).baselineVersion).toBe(1);
      return new Response(null, { status: 400 });
    }
    return (await route(new Request(String(url), init))) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  await httpApi(request).result(
    {
      server: "https://fixture.example",
      hostId: f.hostId,
      installationId: f.installationId,
      hostToken: f.hostToken,
      receipts: [],
    },
    {
      requestId,
      request: job.request,
      operation: "buildSnapshot",
      inputHash: "fixture",
      outcome: "completed",
      imageId: `sha256:${"a".repeat(64)}`,
      baselineVersion: 1,
    },
  );
  expect(await f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id: requestId })).toMatchObject({
    snapshot: { status: "ready", baselineVersion: 1 },
  });
});

test("a downgrade after snapshot admission cannot publish an unverified snapshot", async () => {
  const f = await snapshotFixture();
  const input = { org: f.actor.orgId, hostId: f.hostId, requestId: randomUUID(), name: "downgrade", config: f.config };
  await f.snapshots.command(f.caller, "create", input);
  const image = `sha256:${"d".repeat(64)}`;
  // An old replica does not read the new requirement before publishing.
  await expect(
    database().query("update docker_snapshots set status='ready',image_id=$2 where id=$1", [input.requestId, image]),
  ).rejects.toThrow("docker_snapshots_required_baseline_check");
  expect((await hosts.poll(f.hostToken, f.installationId, "2.54.0"))?.requestId).toBe(input.requestId);
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: input.requestId,
    outcome: "completed",
    imageId: image,
  });
  expect(await f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id: input.requestId })).toMatchObject({
    snapshot: { status: "failed", image: null, failureReason: expect.stringContaining("Update the host daemon") },
  });
});

test.each(["private", "org"] as const)(
  "snapshot rebuild %s publishes a new immutable build and retains its source and retry receipt",
  async (visibility) => {
    const db = database();
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
    const job = await hosts.poll(f.hostToken, f.installationId, "2.55.0");
    if (job?.operation !== "buildSnapshot") throw Error("Missing source build");
    await hosts.complete(f.hostToken, f.installationId, {
      requestId: id,
      outcome: "completed",
      imageId: `sha256:${"d".repeat(64)}`,
      baselineVersion: 1,
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

test.each([
  [{ baselineTool: "jq" } as const, "Snapshot baseline 1 requires a working jq at the declared version."],
  [{ missingRefIndex: 1 }, "Ref 'main' was not found in example/project. Check the branch or tag and retry."],
])(
  "failed snapshot machine facts persist a safe reason in get and list responses (%j)",
  async (diagnostic, failureReason) => {
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
      ...diagnostic,
    });
    expect(await f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id })).toMatchObject({
      snapshot: { id, status: "failed", image: null, failureReason },
    });
    expect(await f.snapshots.command(f.caller, "list", { org: f.actor.orgId })).toMatchObject({
      snapshots: [expect.objectContaining({ id, status: "failed", failureReason })],
    });
  },
);

test("a failed snapshot build retried with the same request records host work only once", async () => {
  const f = await snapshotFixture(),
    id = randomUUID();
  const input = {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "retried-build",
    visibility: "private",
    config: f.config,
  };
  const observed = async (work: () => Promise<unknown>) => {
    const records: Record<string, unknown>[] = [];
    let result: unknown;
    const response = (await observeRequest(
      async () => {
        result = await work();
        return Response.json({});
      },
      (line) => records.push(JSON.parse(line)),
    )) as Response;
    const requestId = response.headers.get("x-request-id");
    return { result, providerCalls: records.filter((r) => r.event === "provider_call"), requestId };
  };
  const created = await observed(() => f.snapshots.command(f.caller, "create", input));
  expect(created.providerCalls).toEqual([
    {
      event: "provider_call",
      requestId: created.requestId,
      provider: "docker",
      operation: "snapshot.create",
      outcome: "ok",
      durationMs: expect.any(Number),
    },
  ]);
  expect((await hosts.poll(f.hostToken, f.installationId))?.operation).toBe("buildSnapshot");
  await hosts.complete(f.hostToken, f.installationId, {
    requestId: id,
    outcome: "failed",
    reason: "snapshot_build_failed",
  });
  const retried = await observed(() => f.snapshots.command(f.caller, "create", input));
  expect(retried.result).toMatchObject({ snapshot: { id, status: "failed" } });
  expect(retried.providerCalls).toEqual([]);
  for (const read of [
    () => f.snapshots.command(f.caller, "get", { org: f.actor.orgId, id }),
    () => f.snapshots.command(f.caller, "list", { org: f.actor.orgId }),
  ])
    expect((await observed(read)).providerCalls).toEqual([]);
  expect(await hosts.poll(f.hostToken, f.installationId)).toBeNull();
});

test("a snapshot build that fails on the disk floor persists the disk reason the constraint admits", async () => {
  const db = database();
  const f = await snapshotFixture(),
    id = randomUUID();
  await f.snapshots.command(f.caller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId: id,
    name: "disk-floor-build",
    visibility: "private",
    config: f.config,
  });
  expect((await hosts.poll(f.hostToken, f.installationId))?.operation).toBe("buildSnapshot");
  await hosts.complete(f.hostToken, f.installationId, { requestId: id, outcome: "failed", reason: "disk_full" });
  expect(
    (
      await db.query<{ status: string; failure_reason: string }>(
        "select status,failure_reason from public.docker_snapshots where id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "failed", failure_reason: DOCKER_LAUNCH_FAILURE_MESSAGES.disk });
});

test("Docker normal launch uses the saved model unless explicitly overridden", async () => {
  for (const explicit of [false, true]) {
    const f = await fixture();
    await createSqlVaultStore(sql).setAgentDefault!(f.actor.userId, {
      harness: "codex",
      credentialId: f.body.credentialId,
      model: "gpt-6-astra",
    });
    const result = await f.service().launch(f.caller, { ...f.body, ...(explicit ? { model: "gpt-6.1-terra" } : {}) });
    expect(result.sandbox.model).toBe(explicit ? "gpt-6.1-terra" : "gpt-6-astra");
    await createSqlVaultStore(sql).setAgentDefault!(f.actor.userId, {
      harness: "codex",
      credentialId: null,
      model: "gpt-6.1-sol",
    });
    const replay = await f.service().launch(f.caller, { ...f.body, ...(explicit ? { model: "gpt-6.1-terra" } : {}) });
    expect(replay.sandbox.model).toBe(result.sandbox.model);
  }
});

test.each(["poll", "complete"] as const)(
  "snapshot %s infrastructure failure remains retryable without failing the build",
  async (operation) => {
    const f = await snapshotFixture(true);
    const id = randomUUID();
    await f.snapshots.command(f.caller, "create", {
      org: f.actor.orgId,
      hostId: f.hostId,
      requestId: id,
      name: "retryable-build",
      visibility: "private",
      config: f.config,
    });
    const cause = new Error("snapshot database unavailable");
    const failing: Sql = {
      query: (q, p) => sql.query(q, p),
      transaction: (work) =>
        sql.transaction!((tx) =>
          work({
            query: (q, p) => {
              if (q.includes("for update of s")) throw cause;
              return tx.query(q, p);
            },
          }),
        ),
    };
    const store = createDockerHostStore(failing, key);
    const result = {
      requestId: id,
      outcome: "completed" as const,
      imageId: `sha256:${"a".repeat(64)}`,
      baselineVersion: 1,
    };
    await expect(
      operation === "poll"
        ? store.poll(f.hostToken, f.installationId)
        : store.complete(f.hostToken, f.installationId, result),
    ).rejects.toMatchObject({
      name: "DockerHostUnavailable",
      cause,
    });
    const snapshot = (
      await database().query<{ status: string }>("select status from public.docker_snapshots where id=$1", [id])
    ).rows[0];
    expect(snapshot?.status).toBe("building");
    expect((await hosts.poll(f.hostToken, f.installationId))?.requestId).toBe(id);
    await hosts.complete(f.hostToken, f.installationId, result);
    expect(
      (await database().query<{ status: string }>("select status from public.docker_snapshots where id=$1", [id]))
        .rows[0]?.status,
    ).toBe("ready");
  },
);
