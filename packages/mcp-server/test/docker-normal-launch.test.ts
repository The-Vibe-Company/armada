import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AUTH_HEADER, Journal, Runner, type RunnerRequest } from "@armada/agent-runtime";
import { createSqlAuthStore } from "@armada/auth";
import {
  type AgentEvent,
  DOCKER_HOST_PROTOCOL,
  DOCKER_HOST_PROTOCOL_HEADER,
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
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
import { modalLaunchReceipt } from "@armada/core/contract";
import {
  createRoutineService,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  DockerTemplateAdmissionRefused,
  decryptSecret,
  encryptSecret,
  type TemplateRuntime,
} from "@armada/core/server";
import { dockerLaunchBody } from "../../../apps/dashboard/src/lib/docker-launch.ts";
import { httpApi } from "../../docker-host/src/host.ts";
import { Armada, ArmadaError, type SendInput } from "../../sdk/src/index.ts";
import { createTurnDispatchJob } from "../src/account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { apiFailureCode } from "../src/api-failure.ts";
import type { Caller } from "../src/caller.ts";
import {
  type ControlOptions,
  createQueuedSandboxDispatch,
  dispatchControlCommand,
  handleControlRequest,
} from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createDockerBootstrapService } from "../src/docker-bootstrap-service.ts";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { dockerLaunchRequestId } from "../src/docker-launch-identity.ts";
import { createDockerLaunchPlacement } from "../src/docker-launch-placement.ts";
import { createDockerOutputReader } from "../src/docker-outputs.ts";
import { createDockerRuntimeLifecycle } from "../src/docker-runtime-lifecycle.ts";
import { createDockerSandboxControls } from "../src/docker-sandbox-controls.ts";
import { createDockerSandboxService } from "../src/docker-sandbox-service.ts";
import { createDockerSnapshots } from "../src/docker-snapshots.ts";
import { createLaunchJob } from "../src/jobs/launch.ts";
import { createResumeJob } from "../src/jobs/resume.ts";
import { createJobsRunner } from "../src/jobs/runner.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { readLaunchAccountDefault } from "../src/launch-account-pool.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { createServerRoutineScheduler } from "../src/server-routines.ts";
import { runDockerStop } from "./docker-stop.fixture.ts";
import { useMigratedDatabase } from "./migrated-database.ts";
import { publishedRequest, publishedResponse } from "./published-response.ts";

const database = useMigratedDatabase();
afterEach(async () => {
  await database().query("delete from public.jobs where kind='launch' and outcome ? 'docker_actor_epoch'");
});
const sql: Sql = {
  query: (q, v) => database().query(q, v),
  transaction: (work) => database().transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const officialImage = `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`;
const key = Buffer.alloc(32, 19).toString("base64");
const hosts = createDockerHostStore(sql, key);
const authority = createRuntimeEnrolments(sql, key);
const credentials = launchCredentials(createSqlVaultStore(sql), key);
const bootstrapOptions = {
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
} as const;
const bootstrap = createDockerBootstrapService(sql, key, bootstrapOptions);
// The real migrated boundary owns normal-launch sequencing and durable retries.
// Existing private-lane tests own the individual host/runtime protocol matrices.
async function fixture(
  options: {
    harness?: Harness;
    checkoutExitCode?: number;
    refreshFailure?: "auth" | "network";
    repositoryAccessDenied?: boolean;
    publicRepositoryAccess?: boolean;
    withholdWorkspace?: { timeoutMs: number } | "stop";
    distinctPromptIds?: boolean;
    githubConfigurationAcknowledged?: boolean;
    refuseSkillInstall?: boolean;
    failRuntimeStartup?: boolean;
    daemonVersion?: string;
  } = {},
) {
  const db = database();
  const orgId = randomUUID(),
    userId = randomUUID(),
    adminId = randomUUID(),
    otherId = randomUUID(),
    credentialId = randomUUID();
  const installationId = randomUUID();
  const host = { hostId: randomUUID(), hostToken: randomBytes(32).toString("hex") };
  await db.query(
    `with users as (
       insert into auth.users(id) values($2),($3),($4)
     ), org as (
       insert into public.orgs(id,name) values($1,$5)
     ), members as (
       insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin'),($1,$4,'member')
     )
     insert into public.docker_hosts(
       id,org_id,owner_id,registration_expires_at,installation_id,hash,last_seen_at,daemon_version,daemon_protocol
     ) values($6,$1,$3,now()+interval '5 minutes',$7,$8,now(),$9,$10)`,
    [
      orgId,
      userId,
      adminId,
      otherId,
      `normal-launch-${orgId}`,
      host.hostId,
      installationId,
      createHash("sha256").update(host.hostToken).digest("hex"),
      options.daemonVersion ?? "2.28.0",
      DOCKER_HOST_PROTOCOL - 1,
    ],
  );
  const actor = { userId, orgId },
    admin = { userId: adminId, orgId };
  const caller: Caller = { userId, orgs: [{ orgId, role: "member" }], via: "supabase" };
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
          : options.harness === "antigravity"
            ? JSON.stringify({ method: "gemini-api-key", apiKey: secret })
            : secret,
        key,
      ),
      options.harness === "claude"
        ? "anthropic"
        : !options.harness || options.harness === "codex"
          ? "openai"
          : options.harness,
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
  let acknowledgeFirstPrompt: ((uncertain: boolean) => Promise<unknown>) | undefined;
  let deferFirstPrompt = false;
  let disconnectBeforePrompt = false;
  const receipt = { promptId: randomUUID(), conversationId: randomUUID(), status: "queued" };
  const promptReceipts = new Map<string, typeof receipt>();
  const jobs: unknown[] = [],
    native: unknown[] = [],
    checkoutStatuses: string[] = [];
  const clock = {
    now: () => now,
    async wait(ms: number) {
      now += ms;
      if (!drive) return;
      const pending = await db.query("select 1 from jobs where sandbox_id=$1 and kind='stop' and state='queued'", [
        body.requestId,
      ]);
      if (pending.rows.length) await runDockerStop(sql, key, body.requestId, sql, readStopOutputs);
      await step();
    },
  };
  const commands = createRuntimeCommands(authority, key, clock);
  const runtimeClock = {
    now: clock.now,
    async wait(ms: number) {
      now += ms;
      if (drive) await stepRuntime();
    },
  };
  const readStopOutputs = createDockerOutputReader(sql, key, runtimeClock);
  async function step(machineBootstrap = true, deferEnrolment = false) {
    let job: Awaited<ReturnType<typeof hosts.poll>> = null;
    if (await hosts.mayHaveWork(host.hostToken, installationId, false, [], false, false, machineBootstrap)) {
      const version = options.daemonVersion ?? "2.28.0";
      job = await hosts.poll(
        host.hostToken,
        installationId,
        version,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        false,
        false,
        false,
        machineBootstrap,
      );
    }
    if (job) {
      jobs.push(job);
      if (job.operation === "stop" || job.operation === "delete") session = undefined;
      if (!deferEnrolment && (job.operation === "bootstrap" || job.operation === "resume"))
        session = await authority.enrol(job.bootstrap.enrolmentToken);
      const failed = failCreate && job.operation === "create";
      await hosts.complete(host.hostToken, installationId, {
        requestId: job.requestId,
        outcome: failed ? "failed" : "completed",
        ...(!failed && (job.operation === "create" || job.operation === "stop") ? { machineId: "a".repeat(64) } : {}),
        ...(failed && failCreate !== "plain"
          ? { reason: failCreate === "image" ? ("image_unavailable" as const) : ("disk_full" as const) }
          : {}),
      });
    }
    await stepRuntime();
  }
  async function stepRuntime() {
    if (session) {
      if (
        disconnectBeforePrompt &&
        (
          await sql.query(
            "select 1 from runtime_commands where sandbox_id=$1 and starts_with(request_id,'docker_prompt_')",
            [body.requestId],
          )
        ).rows.length
      ) {
        drive = false;
        throw Error("synthetic runtime disconnect before first delivery");
      }
      const next = await commands.next(session.runtimeToken, session.epoch);
      if (next.command) {
        const command = next.command;
        native.push(command);
        if (command.op === "health" && options.failRuntimeStartup) {
          const response = await createRuntimeProgress(authority)(
            new Request("https://armada.example/api/runtime/progress", {
              method: "POST",
              headers: {
                authorization: `Bearer ${session.runtimeToken}`,
                "x-armada-runtime-epoch": session.epoch,
              },
              body: JSON.stringify({ stage: "runtime_failed", reason: "artifact_unavailable" }),
            }),
          );
          expect(response?.status).toBe(200);
          session = undefined;
          return;
        }
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
          else now = Math.max(now, options.withholdWorkspace.timeoutMs - 1);
          return;
        }
        if (command.op === "prompt" && command.input.conversationId)
          receipt.conversationId = command.input.conversationId as typeof receipt.conversationId;
        if (command.op === "prompt" && !promptReceipts.has(command.requestId))
          promptReceipts.set(
            command.requestId,
            options.distinctPromptIds && promptReceipts.size ? { ...receipt, promptId: randomUUID() } : receipt,
          );
        if (command.op === "prompt" && deferFirstPrompt) {
          const { runtimeToken, epoch } = session;
          acknowledgeFirstPrompt = (uncertain) =>
            commands.complete(runtimeToken, epoch, {
              epoch,
              requestId: command.requestId,
              status: uncertain ? 409 : 200,
              body: {
                version: 1,
                requestId: command.requestId,
                ...(uncertain
                  ? { error: "request_outcome_unknown" }
                  : { result: promptReceipts.get(command.requestId)! }),
              },
            });
          deferFirstPrompt = false;
          drive = false;
          throw Error("synthetic worker loss while the runtime owns the first turn");
        }
        if (command.op === "exec")
          checkoutStatuses.push(
            (await db.query<{ status: string }>("select status from public.sandboxes where id=$1", [body.requestId]))
              .rows[0]!.status,
          );
        if (command.op === "readOutputs") {
          await commands.complete(session.runtimeToken, session.epoch, {
            epoch: session.epoch,
            requestId: command.requestId,
            status: 200,
            body: {
              version: 1,
              requestId: command.requestId,
              result: command.part === undefined ? { files: [] } : { values: [] },
            },
          });
          return;
        }
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
  const resolver: Pick<LaunchCredentialResolver, "resolve" | "authorizeRepositories" | "defaults"> & {
    launchAccountDefault: NonNullable<typeof credentials.launchAccountDefault>;
  } = {
    launchAccountDefault: (userId, harness) => readLaunchAccountDefault(sql, userId, harness),
    defaults: async (...args) => credentials.defaults?.(...args),
    ...(publicRepositoryAccess ? { authorizeRepositories: publicRepositoryAccess } : {}),
    ...(options.repositoryAccessDenied
      ? {
          async authorizeRepositories(_actor, _resolved, repos) {
            throw new LaunchError(
              "no_credentials",
              `Repository ${repos[0]!.dir} needs a GitHub connection with read access. Run armada account login github, grant your account and the Armada GitHub App access, then launch again.`,
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
    commands: createRuntimeCommands(authority, key, runtimeClock),
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
    const bridge = createRuntimeCommands(createRuntimeEnrolments(target, key), key, runtimeClock);
    return createRuntimeMcp({ sql: target, key, origin: "https://armada.example", commands: bridge });
  }
  function service(
    target = sql,
    enabled = true,
    timeoutMs = 10_000,
    releaseImage: string | (() => never) | null = officialImage,
    deferLaunch = false,
    bootstrapService = bootstrap,
  ) {
    const launch = createDockerLaunchPlacement(target, key, {
      get officialImage() {
        return typeof releaseImage === "function" ? releaseImage() : (releaseImage ?? officialSandboxImage());
      },
      credentials: resolver,
      ...(enabled ? { bootstrap: bootstrapService } : {}),
      clock,
      timeoutMs,
      github,
      mcp: mcp(target),
    });
    const handler = createLaunchJob({ docker: launch.run });
    const jobs = createJobsStore(sql, key);
    const workerId = randomUUID();
    async function runClaim(canDispatch = async (_tx?: Sql) => true) {
      const job = await jobs.claim("launch", workerId, 30, 1);
      if (!job) return false;
      const result = await handler.run(job, {
        signal: new AbortController().signal,
        canDispatch: async (tx) => (await canDispatch(tx)) && (await jobs.inspect(job, workerId, tx)) === "dispatch",
        handoffGeneration: async () => {
          throw Error("Unexpected launch generation handoff.");
        },
      });
      if (!(await jobs.complete(job, workerId, result))) await jobs.retireStale(job, workerId, "no_dispatch");
      if (result.status !== "retry" || !drive) return false;
      await step();
      await db.query("update public.jobs set run_after=now() where id=$1", [job.id]);
      return true;
    }
    async function drain() {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!(await runClaim())) return;
      }
    }
    return {
      ...launch,
      runClaim,
      drain,
      async launch(...args: Parameters<typeof launch.admit>) {
        const result = await launch.admit(...args);
        if (deferLaunch || args[2] || result.sandbox.status !== "starting" || !drive) return result;
        await drain();
        return launch.admit(...args);
      },
    };
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
    async seedRunningSandbox() {
      const generation = randomUUID();
      await db.query(
        `insert into public.sandboxes(
           id,org_id,owner_id,access_owner_id,provider,provider_sandbox_id,harness,visibility,status,
           docker_host_id,docker_installation_id,docker_generation,docker_image,credential_id,credential_version,
           expires_at,conversation_ids,task_prompt_id
         ) values($1,$2,$3,$3,'docker',$4,$5,'private','running',$6,$7,$8,$9,$10,2,
           now()+interval '1 hour',$11,$12)`,
        [
          body.requestId,
          orgId,
          userId,
          `armada-${installationId}-${host.hostId}-${body.requestId}-${generation}`,
          body.harness,
          host.hostId,
          installationId,
          generation,
          officialImage,
          credentialId,
          [receipt.conversationId],
          receipt.promptId,
        ],
      );
      // Send admission still verifies the completed create and bootstrap against the current actor epoch.
      await db.query(
        `insert into public.docker_host_jobs(
           request_id,host_id,input_enc,outcome,completed_at,bound_sandbox_id,bound_actor_id,
           bound_actor_epoch,bound_operation
         )
         select gen_random_uuid(),$1,$2,'completed',now(),$3,e.user_id,e.epoch,operation
         from public.mcp_actor_epochs e cross join (values ('create'),('bootstrap')) as phases(operation)
         where e.org_id=$4 and e.user_id=$5`,
        [host.hostId, await encryptSecret("{}", key), body.requestId, orgId, userId],
      );
      const ticket = await createRuntimeEnrolments(sql, key, { allowDockerIssue: true }).issue({
        sandboxId: body.requestId,
        ownerId: userId,
        configuration: {},
      });
      session = await authority.enrol(ticket.enrolmentToken);
    },
    resume: (controls: ReturnType<typeof createDockerSandboxControls>) =>
      controls.invoke(caller, "resume", { id: body.requestId, request_id: randomUUID() }),
    step,
    deferFirstPrompt: (beforeDelivery = false) => {
      disconnectBeforePrompt = beforeDelivery;
      deferFirstPrompt = !beforeDelivery;
    },
    acknowledgeFirstPrompt: (uncertain: boolean) => acknowledgeFirstPrompt!(uncertain),
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

async function seedPersonalVariable(orgId: string, ownerId: string, name: string, value: string) {
  const id = randomUUID();
  await database().query(
    "insert into public.readable_variables(id,org_id,owner_id,scope,name,value) values($1,$2,$3,'personal',$4,$5)",
    [id, orgId, ownerId, name, value],
  );
  return id;
}

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
    (select count(*)::int from public.docker_launch_manifests where sandbox_id=$1) as claims,
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
        "select actor_epoch::text from public.docker_launch_manifests where sandbox_id=$1",
        [f.body.requestId],
      )
    ).rows,
  ).toEqual([{ actor_epoch: "0" }]);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 0, commands: 0 });
  await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [
    f.actor.orgId,
    f.actor.userId,
  ]);
  await rejected(service.launch(f.caller, f.body), "not_found");
});

test("normal launch drives create, bootstrap, health and one first prompt, seals its claim and replays current metadata", async () => {
  const db = database();
  const f = await fixture();
  const vault = createSqlVaultStore(sql);
  await vault.setAgentDefault!(f.actor.userId, {
    harness: "codex",
    credentialId: f.body.credentialId,
    model: "gpt-6-astra",
  });
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
    runtime: { kind: "armada", epoch: "1" },
    ttlSeconds: 14400,
    promptId: f.receipt.promptId,
    conversationId: f.receipt.conversationId,
  });
  expect(
    (
      await db.query<{ generation: string; epoch: string; runtime_generation: string }>(
        `select s.lifecycle_generation::text as generation,r.epoch::text,r.lifecycle_generation::text as runtime_generation
     from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id where s.id=$1`,
        [f.body.requestId],
      )
    ).rows[0],
  ).toEqual({ generation: "1", epoch: "1", runtime_generation: "1" });
  expect(result.sandbox.createdAt).toMatch(/^\d{4}-/);
  expect(result.expiresAt).toBe(result.sandbox.expiresAt as string);
  expect(result.sandbox.model).toBe("gpt-6-astra");
  expect(result.sandbox.reasoningEffort).toBeString();
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 4 });
  expect(JSON.stringify(f.jobs)).not.toContain(f.body.prompt);
  expect(JSON.stringify(f.jobs)).not.toContain(f.secret);
  expect(JSON.stringify(result)).not.toContain(f.secret);
  const claim = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer>; result_enc: Uint8Array<ArrayBuffer>; request_hash: string }>(
      `select request_enc,result_enc,request_hash from public.docker_launch_manifests where sandbox_id=$1`,
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
  await vault.setAgentDefault!(f.actor.userId, {
    harness: "codex",
    credentialId: f.body.credentialId,
    model: "gpt-6.1-sol",
  });
  expect(await f.service().launch(f.caller, f.body)).toMatchObject({
    sandbox: { id: result.sandbox.id, model: "gpt-6-astra" },
    promptId: result.promptId,
  });
  expect(f.resolutions()).toBe(1);
  await db.query("update public.sandboxes set status='deleted',stopped_at=now(),deleted_at=now() where id=$1", [
    f.body.requestId,
  ]);
  const beforeReplay = await counts(f);
  await db.query(`update public.credentials set status='revoked' where id=$1`, [f.body.credentialId]);
  const replay = await f
    .service(sql, false, 10_000, () => {
      throw new Error("The new release image pin is unavailable");
    })
    .launch(f.caller, f.body);
  expect(replay.sandbox.status).toBe("deleted");
  expect(replay.promptId).toBe(f.receipt.promptId);
  expect(replay.runtime).toEqual(result.runtime);
  expect(f.resolutions()).toBe(1);
  // The replay issues no runtime command.
  expect(await counts(f)).toEqual(beforeReplay);
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
  await createDockerSandboxService(sql).reserve(f.actor, {
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
  const { prompt: _prompt, requestId, hostId, ...fields } = f.body;
  const base = { ...fields, hostId, idempotencyKey: requestId };
  const snapshot = { ...fields, idempotencyKey: requestId, snapshotId: randomUUID() };
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["Fix the failing test.", true],
    ["  padded  ", true],
    ["", false],
    ["   ", false],
    ["\t\n", false],
    ["\u00a0\u2028\ufeff", false],
  ];
  for (const [prompt, admitted] of cases) {
    const body = prompt === undefined ? base : { ...base, prompt };
    expect(published.safeParse(body).success).toBe(admitted);
    expect(published.safeParse(prompt === undefined ? snapshot : { ...snapshot, prompt }).success).toBe(admitted);
    // Normalization runs before the placement switch: a disabled service answers an admitted body with unavailable.
    await rejected(
      f.service(sql, false).launch(f.caller, { ...f.body, prompt }),
      admitted ? "unavailable" : "invalid_request",
    );
  }
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
});

test("reservation checks the current credential pin before allocating", async () => {
  const db = database();
  const f = await fixture();
  const { credentialId, requestId } = f.body;
  const reserve = (actor = f.actor, credentialVersion = 2) =>
    createDockerSandboxService(sql).reserve(actor, {
      credentialId,
      credentialVersion,
      requestId,
      hostId: f.hostId,
      image: officialImage,
    });
  await expect(reserve({ ...f.actor, userId: f.otherId })).rejects.toThrow("Docker sandbox denied");
  await expect(reserve(f.actor, 1)).rejects.toThrow("Docker sandbox denied");
  await db.query("update public.credentials set status='revoked' where id=$1", [credentialId]);
  await expect(reserve()).rejects.toThrow("Docker sandbox denied");
  await db.query("update public.credentials set status='active',expires_at=now()-interval '1 second' where id=$1", [
    credentialId,
  ]);
  await expect(reserve()).rejects.toThrow("Docker sandbox denied");
  expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
  await db.query("update public.credentials set expires_at=null where id=$1", [credentialId]);
  expect((await reserve()).status).toBe("starting");
});

test("a plain Docker launch refuses a draining host even after a long drain", async () => {
  const db = database();
  const f = await fixture();
  await db.query("update public.docker_hosts set draining_at=now()-interval '2 hours' where id=$1", [f.hostId]);
  await expect(f.service().launch(f.caller, f.body)).rejects.toMatchObject({
    code: "host_draining",
    message: expect.stringContaining("draining for uninstall"),
  });
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
            if (q.startsWith("insert into public.jobs")) throw Error("private failure");
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
  expect((await f.service(sql, true, 10000).launch(f.caller, f.body)).sandbox.status).toBe("starting");
  await db.query(`delete from public.members where org_id=$1 and user_id=$2`, [f.actor.orgId, f.actor.userId]);
  await rejected(f.service().launch(f.caller, f.body), "not_found");
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'member')`, [
    f.actor.orgId,
    f.actor.userId,
  ]);
  await rejected(f.service().launch(f.caller, f.body), "not_found");
  expect(f.resolutions()).toBe(1);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 0, commands: 0 });
});

test("failed startup returns a safe failure without claiming stopped, and pending retry never starts replacement work", async () => {
  const db = database();
  const f = await fixture();
  f.setFailure();
  expect((await f.service().launch(f.caller, f.body)).sandbox.status).toBe("failed");
  const row = await createDockerSandboxService(sql).get(f.actor, f.body.requestId);
  expect(row.status).toBe("failed");
  expect(
    (
      await db.query<{ stopped_at: string | null }>(`select stopped_at from public.sandboxes where id=$1`, [
        f.body.requestId,
      ])
    ).rows[0]?.stopped_at,
  ).toBeNull();
  expect((await f.service().launch(f.caller, f.body)).sandbox.status).toBe("failed");
  expect(f.resolutions()).toBe(1);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 1, commands: 0 });
  const cleanup = createDockerSandboxControls(sql, key, { clock: f.clock });
  await cleanup.invoke(f.caller, "delete", { id: f.body.requestId });
  expect((await createDockerSandboxService(sql).get(f.actor, f.body.requestId)).status).toBe("deleted");
});

test("Docker launch replay preserves the runtime artifact failure message", async () => {
  const f = await fixture({ failRuntimeStartup: true });
  expect((await f.service().launch(f.caller, f.body)).sandbox).toMatchObject({
    status: "failed",
    statusReason: expect.stringContaining("artifact"),
  });
});

test.each([
  ["image", DOCKER_IMAGE_UNAVAILABLE_MESSAGE],
  ["disk", DOCKER_LAUNCH_FAILURE_MESSAGES.disk],
] as const)(
  "host failure retains its safe launch/status diagnostic instead of becoming an image error (%s)",
  async (reason, message) => {
    const f = await fixture();
    f.setFailure(reason);
    expect((await f.service().launch(f.caller, f.body)).sandbox.status).toBe("failed");
    expect((await f.service().launch(f.caller, f.body)).sandbox.statusReason).toBe(message);
    const runtimeReason =
      "Runtime model routing failed. Ask the server operator to check the configured model endpoint before launching again.";
    for (const [stored, expected] of [
      [message, message],
      [runtimeReason, runtimeReason],
      ["internal_private_diagnostic", DOCKER_LAUNCH_FAILURE_MESSAGES.startup],
    ]) {
      await database().query("update sandboxes set status_reason=$2 where id=$1", [f.body.requestId, stored]);
      expect((await f.service().launch(f.caller, f.body)).sandbox.statusReason).toEqual(expected ?? null);
      const status = await createDockerSandboxControls(sql, key, { clock: f.clock }).invoke(f.caller, "status", {
        id: f.body.requestId,
      });
      expect(status).toMatchObject({ result: { status: "failed", statusReason: expected } });
      const record = await f.service(sql, true, 10000, officialImage, true).launch(f.caller, f.body);
      expect(record).toMatchObject({ sandbox: { statusReason: expected } });
    }
  },
);

test("Docker launch replay updates the remedy in a stored GitHub access refusal", async () => {
  const f = await fixture();
  f.setFailure();
  expect((await f.service().launch(f.caller, f.body)).sandbox.status).toBe("failed");
  const stored =
    "Repository project needs a GitHub connection with read access. Run armada github connect, grant your account and the Armada GitHub App access, then launch again.";
  await database().query("update sandboxes set status_reason=$2 where id=$1", [f.body.requestId, stored]);
  const expected = stored.replace("armada github connect", "armada account login github");
  const record = await f.service(sql, true, 10_000, officialImage, true).launch(f.caller, f.body);
  expect(record.sandbox.statusReason).toEqual(expected ?? null);
});

test("prompt-free, image-free launch normalizes UUIDs, uses the default image, honors TTL and stops at runtime readiness", async () => {
  const f = await fixture({ daemonVersion: "2.27.0" });
  const { prompt: _prompt, requestId: idempotencyKey, ...base } = f.body;
  f.body.requestId = dockerLaunchRequestId(key, f.actor.userId, f.actor.orgId, idempotencyKey);
  const body = {
    ...base,
    org: base.org.toUpperCase(),
    hostId: base.hostId.toUpperCase(),
    credentialId: base.credentialId.toUpperCase(),
    requestId: f.body.requestId.toUpperCase(),
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
    admitHostLaunch: f.service(sql, true, 10_000, `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"b".repeat(64)}`)
      .launch,
  });
  const replay = await post("sandbox/launch", { ...base, idempotencyKey, ttlSeconds: 3600 });
  publishedResponse("sandbox/launch").parse(replay);
  expect(replay).toEqual({ sandbox: { id: result.sandbox.id, status: result.sandbox.status } });
  expect(
    (
      await database().query(
        `select actor,code from public.sandbox_transitions
         where sandbox_id=$1 and from_status='starting' and to_status='ready'`,
        [f.body.requestId],
      )
    ).rows,
  ).toEqual([{ actor: "runtime_enrolment", code: "runtime_enrolled" }]);
  expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 3 });
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
    admitHostLaunch: f.service().launch,
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
  await f.seedRunningSandbox();
  const { options, bearer } = restControl(f, { accountTurns: createAccountTurnQueue(sql, key) });
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
  const keyed: SendInput = { ...ref, prompt: "Keyed follow-up", request_id: randomUUID() };
  expect(docker.safeParse(keyed).success).toBe(true);
  expect(await sdk.send(keyed)).toMatchObject({ requestId: keyed.request_id, promptId: expect.any(String) });
  expect(f.native).toHaveLength(0);
  // Docker admission alone would take this 150 KiB prompt; the REST body limit refuses it
  // first, and the published variant says so in advance.
  const oversized: SendInput = { ...ref, prompt: "x".repeat(150 * 1024), request_id: randomUUID() };
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
});

test("Docker sends through the production-wired account queue key a legacy body, replay a keyed one, refuse overrides before queuing, and dispatch admitted rows", async () => {
  const f = await fixture();
  await f.seedRunningSandbox();
  const accountTurns = createAccountTurnQueue(sql, key);
  const dockerControls = createDockerSandboxControls(sql, key, { clock: f.clock, sendEnabled: true });
  const { options, bearer, post } = restControl(f, { dockerControls, accountTurns });
  const runner = createJobsRunner(createJobsStore(sql, key), {
    turn_dispatch: createTurnDispatchJob(sql, key, createQueuedSandboxDispatch(options)),
  });
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
  const dispatchedWhileBusy = f.native.length;
  expect(await runner.reconcileOne(new AbortController().signal)).toBe(true);
  await runner.drain();
  expect(f.native).toHaveLength(dispatchedWhileBusy);
  const keyed: SendInput = { ...ref, prompt: "Queued keyed follow-up", request_id: randomUUID() };
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
  await sql.query(
    "update jobs set run_after='-infinity' where sandbox_id=$1 and kind='turn_dispatch' and idem_key::jsonb->>5=$2",
    [ref.id, generated[0]],
  );
  expect(await runner.reconcileOne(new AbortController().signal)).toBe(true);
  await runner.drain();
  // The oldest queued row, the legacy send, dispatches under its server-generated key.
  expect(f.native.slice(dispatched)).toEqual([
    expect.objectContaining({
      op: "prompt",
      requestId: `docker_prompt_${generated[0]}`,
      input: expect.objectContaining({ text: legacy.prompt }),
    }),
  ]);
});
test.each(["rejects", "returns"] as const)(
  "expired shared Docker turn worker cannot settle a successor receipt when it %s",
  async (outcome) => {
    const f = await fixture();
    await f.seedRunningSandbox();
    await sql.query(
      `insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled)
     select id,task_prompt_id,true from public.sandboxes where id=$1`,
      [f.body.requestId],
    );
    const makeWorker = () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const accountTurns = createAccountTurnQueue(sql, key);
      const dockerControls = createDockerSandboxControls(sql, key, {
        clock: f.clock,
        sendEnabled: true,
        async prepareMcp() {
          entered.resolve();
          await release.promise;
          return undefined;
        },
      });
      const { options } = restControl(f, { accountTurns, dockerControls });
      const runner = createJobsRunner(
        createJobsStore(sql, key),
        {
          turn_dispatch: createTurnDispatchJob(sql, key, createQueuedSandboxDispatch(options)),
        },
        undefined,
        () => () => {},
      );
      return { accountTurns, runner, entered, release };
    };
    const a = makeWorker();
    const b = makeWorker();
    const id = f.body.requestId;
    const requestId = randomUUID();
    const signal = new AbortController().signal;
    await a.accountTurns.accept(f.caller, { id, request_id: requestId, prompt: "Follow up" });
    expect(await a.runner.reconcileOne(signal)).toBe(true);
    await a.entered.promise;
    await sql.query(
      `update public.account_turn_queue set dispatch_until=clock_timestamp()-interval '1 second'
     where sandbox_id=$1 and request_id=$2`,
      [id, requestId],
    );
    await sql.query(
      "update jobs set lease_until='-infinity' where sandbox_id=$1 and kind='turn_dispatch' and state='leased'",
      [id],
    );
    expect(await b.runner.reconcileOne(signal)).toBe(true);
    await b.entered.promise;
    try {
      if (outcome === "rejects") a.release.reject(new Error("Preparation failed after this worker lost the receipt"));
      else a.release.resolve();
      await a.runner.drain();
      const { rows } = await sql.query(
        "select state from public.account_turn_queue where sandbox_id=$1 and request_id=$2",
        [id, requestId],
      );
      expect(rows).toEqual([{ state: "dispatching" }]);
    } finally {
      b.release.resolve();
      await b.runner.drain();
    }
    expect(
      (
        await sql.query("select state from public.account_turn_queue where sandbox_id=$1 and request_id=$2", [
          id,
          requestId,
        ])
      ).rows,
    ).toEqual([{ state: "admitted" }]);
    expect(
      (f.native as RunnerRequest[]).filter((effect) => effect.requestId === `docker_prompt_${requestId}`),
    ).toHaveLength(1);
  },
);

test.each([false, true])(
  "ordinary Docker receipt replays its key for new and completed launches (completed=%s)",
  async (completed) => {
    const f = await fixture();
    const { org, requestId: _requestId, ...fields } = f.body;
    const body = { ...fields, idempotencyKey: "customer_launch_1", externalRef: "customer:42" };
    const { options, post } = restControl(f, {
      admitHostLaunch: f.service(sql, true, 10000, officialImage, true).launch,
    });

    const originalId = dockerLaunchRequestId(key, f.actor.userId, org, body.idempotencyKey);
    if (completed) {
      await f.service().launch(f.caller, { ...fields, org, requestId: originalId, externalRef: body.externalRef });
    }
    const admitted = modalLaunchReceipt.parse(await post("sandbox/launch", body));
    try {
      expect(admitted.sandbox).toEqual({ id: originalId, status: completed ? "running" : "starting" });
      expect(await post("sandbox/launch", { ...body, org: `normal-launch-${org}` })).toEqual(admitted);
      await expect(
        dispatchControlCommand("sandbox/launch", f.caller, { ...body, externalRef: "customer:43" }, options),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await post("sandbox/list", { org, externalRef: body.externalRef })).toMatchObject({
        sandboxes: [{ id: admitted.sandbox.id, externalRef: body.externalRef }],
      });
      expect(await post("sandbox/status", { org, id: admitted.sandbox.id })).toMatchObject({
        externalRef: body.externalRef,
      });
      expect(await post("sandbox/list", { org, externalRef: "customer:43" })).toMatchObject({ sandboxes: [] });
      expect((await counts({ ...f, body: { ...f.body, requestId: originalId } }))?.jobs).toBe(completed ? 2 : 0);
    } finally {
      // Later fixtures drain the shared database. Leave no live admission for their workers to claim.
      await sql.query("update public.sandboxes set status='failed' where id=$1", [admitted.sandbox.id]);
    }
  },
);

const competingPromptRefusals = [
  ["conversation_busy", "conversation_busy", true],
  ["native_auth_writer_busy (versioned)", "native_auth_writer_busy", true],
  ["native_auth_writer_busy (wire)", "native_auth_writer_busy", false],
] as const;
test.each(competingPromptRefusals)("Docker controls settle after %s", async (_caseName, refusal, versioned) => {
  const f = await fixture();
  const { options, bearer, post } = restControl(f);
  const throughRest = refusal === "conversation_busy";
  if (throughRest) {
    const idempotencyKey = `docker:${f.body.requestId}`;
    f.body.requestId = dockerLaunchRequestId(key, f.actor.userId, f.actor.orgId, idempotencyKey);
    const body = dockerLaunchBody({
      org: f.actor.orgId,
      hostId: f.hostId,
      harness: "codex",
      credentialId: f.body.credentialId,
      idempotencyKey,
      model: "normal-http-model",
      reasoningEffort: "high",
      prompt: f.body.prompt,
    });
    const malformed = await handleControlRequest(
      new Request("https://armada.test/api/v1/sandbox/launch", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ ...body, harness: undefined }),
      }),
      options,
    );
    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toMatchObject({ error: { code: "invalid" } });
    // An acknowledged timeout must preserve the dashboard's stable request key.
    f.setDrive(false);
    options.admitHostLaunch = f.service(sql, true, 10000).launch;
    const pending = await handleControlRequest(
      new Request("https://armada.example/api/v1/sandbox/launch", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      }),
      options,
    );
    expect(pending?.status).toBe(200);
    expect(await pending?.json()).toEqual({ sandbox: { id: f.body.requestId, status: "starting" } });
    f.setDrive(true);
    options.admitHostLaunch = f.service().launch;
    // The published contract describes the dashboard's Docker request and its receipt.
    publishedRequest("sandbox/launch").parse(body);
    const launched = modalLaunchReceipt.parse(await post("sandbox/launch", body));
    publishedResponse("sandbox/launch").parse(launched);
    expect(launched.sandbox.id).toBe(f.body.requestId);
    expect(launched).toEqual({ sandbox: { id: f.body.requestId, status: "running" } });
    expect(f.native).toContainEqual(
      expect.objectContaining({
        op: "prompt",
        input: expect.objectContaining({ text: f.body.prompt, model: "normal-http-model", reasoningEffort: "high" }),
      }),
    );
    expect(await counts(f)).toEqual({ sandboxes: 1, claims: 1, jobs: 2, commands: 4 });
    expect(await post("sandbox/launch", body)).toEqual(launched);
  } else {
    await f.seedRunningSandbox();
    const runtime = createDockerRuntimeLifecycle(sql, key);
    const prompt = {
      requestId: randomUUID(),
      text: f.body.prompt,
      conversationId: f.receipt.conversationId,
    };
    expect(await runtime.prompt(f.actor, f.body.requestId, prompt)).toMatchObject({ state: "pending" });
    await f.clock.wait(0);
    expect(await runtime.prompt(f.actor, f.body.requestId, prompt)).toMatchObject({
      state: "admitted",
      receipt: { promptId: f.receipt.promptId, conversationId: f.receipt.conversationId },
    });
  }
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
  const scope = { org: f.actor.orgId };
  const complete = (batch: AgentEvent[], sequence: number) =>
    createRuntimeEvents(authority, key).route(
      new Request("https://armada.example/api/runtime/events", {
        method: "POST",
        headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
        body: JSON.stringify({
          sandboxId: f.body.requestId,
          generation: session.epoch,
          events: batch.map((event, index) => ({ sequence: sequence + index, event })),
        }),
      }),
    );
  await sql.query("update runtime_commands set accepted_prompt_id=null where sandbox_id=$1", [f.body.requestId]);
  expect(await (await complete(events.slice(0, 2), 1))?.json()).toEqual({ acknowledgedSequence: 2 });
  expect(await post("sandbox/status", { ...scope, id: f.body.requestId })).toMatchObject({ status: "running" });
  const busyRequest = randomUUID();
  expect(
    await createDockerRuntimeLifecycle(sql, key).prompt(f.actor, f.body.requestId, {
      requestId: busyRequest,
      text: "Competing prompt",
      conversationId: f.receipt.conversationId,
    }),
  ).toMatchObject({ state: "pending" });
  const competing = createRuntimeCommands(authority, key);
  const requestId = `docker_prompt_${busyRequest}`;
  const rejectBusy = () =>
    competing.complete(session.runtimeToken, session.epoch, {
      epoch: session.epoch,
      requestId,
      status: 409,
      body: versioned ? { version: 1, requestId, error: refusal } : { error: refusal },
    });
  const journal = await complete(events.slice(2), 3);
  expect(journal?.status).toBe(200);
  expect(await journal?.json()).toEqual({ acknowledgedSequence: 3 });
  expect(await post("sandbox/status", { ...scope, id: f.body.requestId })).toMatchObject({ status: "running" });
  if (refusal === "conversation_busy") {
    await database().exec(
      "alter table sandbox_transitions add constraint test_reject_settlement check (code <> 'runtime_turn_settled') not valid",
    );
    try {
      await expect(rejectBusy()).rejects.toThrow();
      expect(await competing.result(f.actor.userId, f.body.requestId, `docker_prompt_${busyRequest}`)).toEqual({
        state: "pending",
      });
    } finally {
      await database().exec("alter table sandbox_transitions drop constraint test_reject_settlement");
    }
  }
  await rejectBusy();
  const status = (await post("sandbox/status", { ...scope, id: f.body.requestId })) as DockerSandboxStatus;
  expect(status).toMatchObject({
    id: f.body.requestId,
    provider: "docker",
    golden: null,
    status: "ready",
    settled: true,
    prompt: { promptId: f.receipt.promptId, state: "finished" },
  });
  if (!throughRest) return;
  const listed = (await post("sandbox/list", { ...scope, status: ["ready"] })) as {
    sandboxes: SandboxListMetadata[];
  };
  expect(listed.sandboxes).toHaveLength(1);
  expect(listed.sandboxes[0]).toMatchObject({
    id: f.body.requestId,
    provider: "docker",
    status: "ready",
  });
  const logs = (await post("logs/read", { ...scope, id: f.body.requestId })) as { events: AgentEvent[] };
  expect(logs.events).toEqual(events);
  expect(JSON.stringify(logs)).not.toContain(f.secret);
  const beforeStop = f.native.length;
  expect(await post("sandbox/stop", { ...scope, id: f.body.requestId })).toEqual({
    id: f.body.requestId,
    status: "stopped",
  });
  const deleted = await handleControlRequest(
    new Request(`https://armada.example/api/v1/sandboxes/${f.body.requestId}?org=${scope.org}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearer}` },
    }),
    options,
  );
  expect(deleted?.status).toBe(200);
  expect(await deleted?.json()).toEqual({
    id: f.body.requestId,
    status: "deleted",
  });
  expect(f.native.slice(beforeStop)).toEqual([expect.objectContaining({ op: "readOutputs", part: null })]);
  expect(f.resolutions()).toBe(1);
});

test("normal launch claims remain service-only even for their owner's user JWT", async () => {
  const db = database();
  const f = await fixture();
  const launch = f.service(sql, true, 10_000, officialImage, true);
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    sendEnabled: true,
  });
  await launch.launch(f.caller, f.body);
  try {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["docker_launch_manifests", "account_turn_queue"]) {
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
  } finally {
    await controls.invoke(f.caller, "stop", { id: f.body.requestId });
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

test("Docker launches Antigravity with its account confined to private enrolment", async () => {
  const f = await fixture({ harness: "antigravity" });
  const launched = await f.service().launch(f.caller, { ...f.body, model: "default" });
  expect(launched.sandbox.harness).toBe("antigravity");
  const config = f.session()?.configuration as Record<string, unknown>;
  const { antigravityCredential, ...rest } = config;
  expect(antigravityCredential).toEqual({ method: "gemini-api-key", apiKey: f.secret });
  expect(JSON.stringify([launched, f.jobs, f.native, rest])).not.toContain(f.secret);
  expect(f.native).toContainEqual(
    expect.objectContaining({
      op: "prompt",
      input: expect.objectContaining({ harness: "antigravity", model: "default" }),
    }),
  );
});

test("revocation between worker read and mailbox admission refuses the old launch", async () => {
  const f = await fixture();
  let revoked = false;
  const launch = f.service(
    {
      ...sql,
      async query(query, params) {
        const result = await sql.query(query, params);
        if (!revoked && query.includes("select s.docker_installation_id,")) {
          revoked = true;
          await sql.query("update mcp_actor_epochs set epoch=epoch+1 where org_id=$1 and user_id=$2", [
            f.actor.orgId,
            f.actor.userId,
          ]);
        }
        return result as Awaited<ReturnType<typeof sql.query>>;
      },
    } as Sql,
    true,
    10000,
    officialImage,
    true,
  );
  await launch.launch(f.caller, f.body);
  await launch.runClaim();
  expect(revoked).toBe(true);
  expect((await counts(f))?.jobs).toBe(0);
});

test("revoking the admitted actor rejects a previously delivered bootstrap ticket", async () => {
  const f = await fixture();
  const launch = f.service(sql, true, 10000, officialImage, true);
  await launch.launch(f.caller, f.body);
  await launch.runClaim();
  f.setDrive(false);
  await launch.runClaim();
  await f.step(true, true);
  const bootstrap = f.jobs.at(-1) as { operation: string; bootstrap: { enrolmentToken: string } };
  expect(bootstrap.operation).toBe("bootstrap");
  await sql.query("update mcp_actor_epochs set epoch=epoch+1 where org_id=$1 and user_id=$2", [
    f.actor.orgId,
    f.actor.userId,
  ]);
  await expect(authority.enrol(bootstrap.bootstrap.enrolmentToken)).rejects.toThrow();
});

test("launch keeps the runtime grant when enrolment races Machine bootstrap replay", async () => {
  const f = await fixture();
  let enrolDuringReplay = false;
  const bootstrapService = createDockerBootstrapService(
    {
      ...sql,
      async query(query, values) {
        if (enrolDuringReplay && values?.[0] === f.body.requestId && query.includes("bound_operation='bootstrap'")) {
          enrolDuringReplay = false;
          await f.step();
        }
        return sql.query(query, values);
      },
    },
    key,
    bootstrapOptions,
  );
  const launch = f.service(sql, true, 10000, officialImage, true, bootstrapService);
  await launch.launch(f.caller, f.body);
  await launch.runClaim();
  f.setDrive(false);
  await launch.runClaim();
  expect(f.session()).toBeUndefined();
  await sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='launch'", [f.body.requestId]);

  enrolDuringReplay = true;
  f.setDrive(true);
  await launch.drain();

  expect(enrolDuringReplay).toBe(false);
  expect(await launch.launch(f.caller, f.body)).toMatchObject({
    sandbox: { status: "running" },
    runtime: { kind: "armada", epoch: "1" },
    promptId: f.receipt.promptId,
  });
  expect(f.jobs.map((job) => (job as { operation: string }).operation)).toEqual(["create", "bootstrap"]);
});

test("a stale worker cannot enqueue runtime setup after enrolment", async () => {
  const f = await fixture();
  const launch = f.service(sql, true, 10000, officialImage, true);
  await launch.launch(f.caller, f.body);
  await launch.runClaim();
  await launch.runClaim();
  expect(f.session()).toBeDefined();
  await launch.runClaim(async (tx) => !tx);
  expect((await counts(f))?.commands).toBe(0);
});

test.each([false, true])(
  "launch deadline blocks daemon pickup and settles the reservation (after create=%s)",
  async (allocated) => {
    const f = await fixture();
    const launch = f.service(sql, true, 10000, officialImage, true);
    await launch.launch(f.caller, f.body);
    if (allocated) await launch.runClaim();
    f.setDrive(false);
    await launch.runClaim();
    await sql.query(
      "update jobs set deadline_at=now()-interval '1 second',run_after=now() where sandbox_id=$1 and kind='launch'",
      [f.body.requestId],
    );
    await f.step();
    expect(f.jobs).toHaveLength(allocated ? 1 : 0);
    await launch.runClaim();
    expect((await launch.launch(f.caller, f.body)).sandbox.status).toBe("failed");
    const cancelled = await sql.query(
      "select bound_operation from docker_host_jobs where bound_sandbox_id=$1 and cancelled_at is not null",
      [f.body.requestId],
    );
    expect(cancelled.rows).toEqual([{ bound_operation: allocated ? "bootstrap" : "create" }]);
  },
);

test("a daemon incapable of Machine bootstrap cannot receive a Machine launch create", async () => {
  const f = await fixture();
  const launch = f.service(sql, true, 10000, officialImage, true);
  await launch.launch(f.caller, f.body);
  f.setDrive(false);
  await launch.runClaim();
  await f.step(false);
  expect(f.jobs).toHaveLength(0);
  await f.step();
  expect(f.jobs).toHaveLength(1);
});

test.each(["available", "expired", "exhausted"] as const)(
  "committed create replay after launch yields respects the stop budget (%s)",
  async (budget) => {
    const f = await fixture();
    const server = f.service(sql, true, 10000, officialImage, true);
    await server.launch(f.caller, f.body);
    f.setDrive(false);
    await server.runClaim();
    expect(f.jobs).toHaveLength(0);
    const { requestId: sandboxId } = f.body;
    const requestId = randomUUID();
    const stop = await hosts.enqueueStop(f.actor, sandboxId, requestId);
    expect(stop).toBeString();
    try {
      await sql.query("update jobs set run_after=now() where sandbox_id=$1 and kind='launch'", [sandboxId]);
      await server.runClaim();
      if (budget === "expired") await sql.query("update jobs set deadline_at='-infinity' where id=$1", [stop]);
      if (budget === "exhausted") await sql.query("update jobs set attempts=max_attempts where id=$1", [stop]);
      await f.step();
      if (budget !== "available") {
        expect(f.jobs).toHaveLength(0);
        return;
      }
      expect(f.jobs).toEqual([expect.objectContaining({ operation: "create" })]);
      await runDockerStop(sql, key, sandboxId);
      await f.step();
      await runDockerStop(sql, key, sandboxId);
      expect(f.jobs).toEqual([
        expect.objectContaining({ operation: "create" }),
        expect.objectContaining({ operation: "stop" }),
      ]);
      expect((await server.launch(f.caller, f.body)).sandbox.status).toBe("stopped");
    } finally {
      await sql.query("delete from jobs where sandbox_id=$1 and kind='stop'", [sandboxId]);
    }
  },
);

test("stop after accepted starting launch bypasses queued startup and settles without allocating or prompting", async () => {
  const f = await fixture();
  const server = f.service(sql, true, 10000, officialImage, true);
  await server.launch(f.caller, f.body);
  const controls = createDockerSandboxControls(sql, key, {
    clock: f.clock,
    sendEnabled: true,
  });
  const status = await controls.invoke(f.caller, "status", { id: f.body.requestId });
  expect(status.handled && (status.result as DockerSandboxStatus).status).toBe("starting");
  const logs = await controls.invoke(f.caller, "logs", { id: f.body.requestId });
  expect(logs).toMatchObject({ handled: true, result: { events: [] } });
  const accountTurns = createAccountTurnQueue(sql, key);
  const accepted = await accountTurns.accept(f.caller, {
    id: f.body.requestId,
    request_id: randomUUID(),
    prompt: "Cancel this queued send",
  });
  const queuedId = accepted.promptId as string;
  const rest = restControl(f, { dockerControls: controls, accountTurns });
  expect(await rest.post("sandbox/stop", { id: f.body.requestId })).toMatchObject({
    id: f.body.requestId,
    status: "stopped",
  });
  await server.drain();
  expect(f.jobs).toEqual([]);

  expect(await accountTurns.status(f.caller, f.body.requestId, queuedId)).toMatchObject({ failed: true });
  expect(await hosts.poll(f.hostToken, f.installationId)).toBeNull();
  expect(f.native).toHaveLength(0);
  expect((await server.launch(f.caller, f.body)).sandbox.status).toBe("stopped");
});

test.each(["deadline", "uncertain ACK", "owner stop"] as const)(
  "inactive launch recovery preserves the first turn (%s)",
  async (cause) => {
    const uncertain = cause === "uncertain ACK";
    const f = await fixture();
    const server = f.service(sql, true, 10000, officialImage, true);
    await server.launch(f.caller, f.body);
    f.deferFirstPrompt();
    await server.drain();
    expect((f.native as { op: string }[]).filter((c) => c.op === "prompt")).toHaveLength(1);
    if (cause === "owner stop") {
      const requestId = randomUUID();
      const stop = await hosts.enqueueStop(f.actor, f.body.requestId, requestId);
      expect(stop).toBeString();
      expect(await hosts.enqueueStop(f.actor, f.body.requestId, requestId)).toBe(stop);
      expect(await runDockerStop(sql, key, f.body.requestId)).toMatchObject({ status: "retry", unattempted: true });
      const { runtimeToken, epoch } = f.session()!;
      expect((await createRuntimeCommands(authority, key).next(runtimeToken, epoch)).command?.op).toBe("getPrompt");
    }
    await sql.query(
      `update jobs set run_after=now(),
      deadline_at=case when $2 then now()-interval '1 second' else deadline_at end
      where sandbox_id=$1 and kind='launch'`,
      [f.body.requestId, cause !== "owner stop"],
    );
    const recovered = f.service(sql, true, 10000, officialImage, true);
    await recovered.runClaim();
    expect((await recovered.launch(f.caller, f.body)).sandbox.status).toBe("starting");

    await f.acknowledgeFirstPrompt(uncertain);
    await sql.query("update jobs set run_after=now() where sandbox_id=$1 and kind='launch'", [f.body.requestId]);
    await recovered.runClaim();
    const final = await recovered.launch(f.caller, f.body);
    expect(final.sandbox.status).toBe(uncertain ? "starting" : "running");
    if (!uncertain) {
      expect(final.conversationId).toBe(f.receipt.conversationId);
      expect(final.promptId).toBe(f.receipt.promptId);
      expect(
        (await sql.query("select conversation_ids,task_prompt_id from sandboxes where id=$1", [f.body.requestId])).rows,
      ).toEqual([{ conversation_ids: [f.receipt.conversationId], task_prompt_id: f.receipt.promptId }]);
    }
    expect(await authority.withSession(f.session()!.runtimeToken, f.session()!.epoch, async () => true)).toBe(true);
    expect(
      (
        await sql.query(
          "select request_id from runtime_commands where sandbox_id=$1 and starts_with(request_id,'docker_prompt_')",
          [f.body.requestId],
        )
      ).rows,
    ).toHaveLength(1);
    if (cause === "owner stop") {
      await runDockerStop(sql, key, f.body.requestId);
      await f.step();
      await runDockerStop(sql, key, f.body.requestId);
      expect(await recovered.launch(f.caller, f.body)).toMatchObject({
        sandbox: { status: "stopped" },
        promptId: f.receipt.promptId,
        conversationId: f.receipt.conversationId,
      });
    }
  },
);

test.each(["never delivered", "journaled before restart", "actor revoked", "attempts exhausted"] as const)(
  "an inactive Docker first prompt only reads the existing journal (%s)",
  async (delivery) => {
    const f = await fixture();
    const server = f.service(sql, true, 10000, officialImage, true);
    const journal = new Journal(":memory:", (text) => text);
    const grant = { token: randomUUID(), sandboxId: f.body.requestId, generation: "1", expiresAt: Date.now() + 60_000 };
    let starts = 0;
    const drivers = {
      codex: {
        start() {
          starts++;
          return { done: Promise.resolve("finished" as const), interrupt: async () => {}, steer: async () => {} };
        },
        close: async () => {},
      },
    };
    const handle = (runner: Runner, command: RunnerRequest) =>
      runner.handle(
        new Request("https://runner", {
          method: "POST",
          headers: { [AUTH_HEADER]: grant.token },
          body: JSON.stringify(command),
        }),
      );
    const journaled = delivery === "journaled before restart";
    try {
      await server.launch(f.caller, f.body);
      f.deferFirstPrompt(!journaled);
      await server.drain();
      let accepted: { promptId: string; conversationId: string } | undefined;
      if (journaled) {
        const first = (f.native as RunnerRequest[]).find((command) => command.op === "prompt")!;
        const original = new Runner(journal, grant, drivers);
        const response = await handle(original, { ...first, input: { ...first.input, cwd: process.cwd() } });
        expect(response.status).toBe(200);
        accepted = ((await response.json()) as { result: { promptId: string; conversationId: string } }).result;
      }
      if (delivery === "actor revoked")
        await sql.query("update members set role='admin' where org_id=$1 and user_id=$2", [
          f.actor.orgId,
          f.actor.userId,
        ]);
      await sql.query(
        `update jobs set run_after=now(),
           deadline_at=case when $2 then now()-interval '1 second' else deadline_at end,
           attempts=case when $3 then max_attempts+1 else attempts end
         where sandbox_id=$1 and kind='launch'`,
        [f.body.requestId, delivery === "never delivered" || journaled, delivery === "attempts exhausted"],
      );
      const { runtimeToken, epoch } = f.session()!;
      const commands = createRuntimeCommands(authority, key);
      const { command } = await commands.next(runtimeToken, epoch);
      const restarted = new Runner(journal, grant, drivers);
      const response = await handle(restarted, command!);
      expect(starts).toBe(journaled ? 1 : 0);
      await commands.complete(runtimeToken, epoch, {
        epoch,
        requestId: command!.requestId,
        status: response.status,
        body: await response.json(),
      });
      await server.runClaim();
      expect((await sql.query("select status from sandboxes where id=$1", [f.body.requestId])).rows).toEqual([
        { status: journaled ? "running" : "failed" },
      ]);
      if (accepted) {
        const final = await server.launch(f.caller, f.body);
        expect(final.promptId).toBe(accepted.promptId);
        expect(final.conversationId).toBe(accepted.conversationId);
      }
    } finally {
      journal.close();
    }
  },
);

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
        "update public.jobs set state='leased',lease_owner=$2,lease_until=now()+interval '1 hour' where sandbox_id=$1",
        [body.requestId, randomUUID()],
      );
      await restarted.drain();
      expect(f.native).toHaveLength(0);
      await db.query("update public.jobs set lease_until=now()-interval '1 hour' where sandbox_id=$1", [
        body.requestId,
      ]);
      await first.runClaim();
    }
    await restarted.drain();
    const completed = await restarted.launch(caller, body);
    if (scenario === "success") {
      expect(completed.sandbox.credentialId).toBe(f.body.credentialId);
      expect(f.session()?.configuration).toMatchObject({ codexEnv: { OPENAI_API_KEY: f.secret } });
      expect(f.resolutions()).toBe(1);
      expect(f.checkoutStatuses).toEqual(["ready"]);
      expect(completed.promptId).toBe(f.receipt.promptId);
      expect(completed.runtime?.epoch).toBe(f.session()?.epoch);
      expect(f.jobs.filter((job) => (job as { operation: string }).operation === "create")).toHaveLength(1);
      expect(
        (
          await db.query<{ machine_id: string }>(
            "select result_machine_id as machine_id from docker_host_jobs where bound_sandbox_id=$1 and bound_operation='create'",
            [body.requestId],
          )
        ).rows,
      ).toEqual([{ machine_id: "a".repeat(64) }]);
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
  });

/** #2560: recorded launch stages of the sandbox's latest activation. */
async function launchStages(id: string) {
  const { rows } = await database().query<{ stage: string }>(
    "select stage from public.sandbox_launch_stages where sandbox_id=$1 and activation=(select max(activation) from public.sandbox_launch_stages where sandbox_id=$1)",
    [id],
  );
  return rows.map((row) => row.stage);
}

async function repositoryFixture(checkoutExitCode = 0) {
  const f = await fixture({ checkoutExitCode });
  await database().query(
    `insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
     values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')`,
    [f.actor.userId, await encryptSecret("offline-refresh", key), await encryptSecret("offline-github-token", key)],
  );
  const repos = [{ url: "https://github.com/example/project.git", branch: "feature/work", dir: "project" }];
  return { f, body: { ...f.body, repos } };
}

function configuredGitHubCapability(f: Fixture) {
  const configured = (f.native as { op: string; configuration: { capability: string } }[]).findLast(
    (command) => command.op === "configureGitHub",
  );
  if (!configured) throw Error("missing GitHub configuration");
  return configured.configuration.capability;
}

function acquireGitHub(f: Fixture, capability: string, repository: string, operation: "git" | "gh" = "git") {
  return f.github.route(
    new Request("https://armada.example/api/runtime/github/credentials", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}` },
      body: JSON.stringify({ version: 1, repository, operation }),
    }),
  );
}

for (const checkoutExitCode of [0, 1])
  test(`Docker checkout exit ${checkoutExitCode} gates its first prompt`, async () => {
    const { f, body: repository } = await repositoryFixture(checkoutExitCode);
    const remote = await defaultRemote(f);
    const body = {
      ...repository,
      skills: ["catalog/repository@1.0.0"],
      connections: [remote.id],
    };
    if (checkoutExitCode !== 0) {
      expect((await f.service().launch(f.caller, body)).sandbox.status).toBe("failed");
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
    const replay = await createDockerRuntimeLifecycle(sql, key).prompt(
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
  });

test("Docker GitHub refresh and follow-up send configure the runtime and replay an admitted send", async () => {
  const { f, body } = await repositoryFixture();
  await f.service().launch(f.caller, body);
  const controls = createDockerSandboxControls(sql, key, { clock: f.clock, github: f.github });
  const initialCapability = configuredGitHubCapability(f);
  const rest = restControl(f, { dockerControls: controls, runtimeGitHub: f.github });
  const gitHubRef = { id: f.body.requestId, org: f.actor.orgId };
  const refreshed = await rest.post("github/refresh", gitHubRef);
  expect(publishedResponse("github/refresh").parse(refreshed)).toMatchObject({
    status: "connected",
    login: "owner",
    runtime: { epoch: f.session()?.epoch },
  });
  const runtimeStatus = await rest.post("github/runtime-status", gitHubRef);
  expect(publishedResponse("github/runtime-status").parse(runtimeStatus)).toMatchObject({
    configured: true,
    runtime: { epoch: f.session()?.epoch },
  });
  await expect(f.github.status({ ...f.caller, orgs: [] }, f.body.requestId)).rejects.toThrow();
  const beforeSend = f.native.length;
  const sendArgs = { id: f.body.requestId, request_id: randomUUID(), prompt: "Continue" };
  const sender = createDockerSandboxControls(sql, key, { sendEnabled: true, clock: f.clock, github: f.github });
  const sent = await sender.invoke(f.caller, "send", sendArgs, {});
  const noGitHub = createDockerSandboxControls(sql, key, {
    sendEnabled: true,
    clock: f.clock,
    github: {
      prepare: f.github.prepare,
      prepareTurn: async () => {
        throw Error("GitHub unavailable");
      },
    },
  });
  expect(await noGitHub.invoke(f.caller, "send", sendArgs, {})).toEqual(sent);
  await expect(noGitHub.invoke(f.caller, "send", { ...sendArgs, prompt: "Changed" }, {})).rejects.toThrow();
  expect((f.native.slice(beforeSend) as { op: string }[]).map((command) => command.op)).toEqual([
    "configureGitHub",
    "prompt",
  ]);
  const followUpCapability = configuredGitHubCapability(f);
  expect((await acquireGitHub(f, followUpCapability, "example/project"))?.status).toBe(200);
  expect((await acquireGitHub(f, followUpCapability, "example/other"))?.status).toBe(403);
  expect((await acquireGitHub(f, initialCapability, "example/project", "gh"))?.status).toBe(403);
});

test("Docker variable admission rejects unsafe names and inaccessible personal references without allocating", async () => {
  const f = await fixture();
  const variableId = await seedPersonalVariable(f.actor.orgId, f.otherId, "PRIVATE_REGION", "private");
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
      "select request_enc from public.docker_launch_manifests where sandbox_id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!claim) throw Error("missing manifest");
  const manifest = JSON.parse(await decryptSecret(claim.request_enc, key));
  expect(manifest.request.secrets).toEqual(body.secrets);
  expect(JSON.stringify(manifest)).not.toContain(canary);
  const sender = createDockerSandboxControls(sql, key, { sendEnabled: true, clock: f.clock });
  const args = { id: f.body.requestId, request_id: randomUUID(), prompt: "Continue" };
  const sent = await sender.invoke(f.caller, "send", args, {});
  await db.query("update public.application_secrets set status='revoked',value_enc=null where id=$1", [secretId]);
  expect(await sender.invoke(f.caller, "send", args, {})).toEqual(sent);
  const before = f.native.length;
  await expect(
    sender.invoke(f.caller, "send", { ...args, request_id: randomUUID(), prompt: "New turn" }, {}),
  ).rejects.toThrow();
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
  expect((await f.service(sql, true, 10000).launch(f.caller, body)).sandbox.status).toBe("starting");
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
    await f.service().launch(f.caller, { ...f.body, skills: ["catalog/notes@1.0.0"], connections: [] });
    expect(f.native.some((request) => (request as { op: string }).op === "prompt")).toBe(false);
    const row = (
      await db.query<{ skills: unknown[] }>("select skills from public.sandboxes where id=$1", [f.body.requestId])
    ).rows[0];
    expect(row?.skills).toEqual([]);
  },
);

test("Docker re-prepares bound MCP grants before follow-up and revokes old leases", async () => {
  const f = await fixture();
  await defaultRemote(f);
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
  await database().query("update sandboxes set mcp_generation=mcp_generation+1 where id=$1", [f.body.requestId]);
  const sender = createDockerSandboxControls(sql, key, {
    sendEnabled: true,
    clock: f.clock,
    prepareMcp: f.mcp().prepare,
  });
  await sender.invoke(f.caller, "send", { id: f.body.requestId, request_id: randomUUID(), prompt: "follow up" }, {});
  expect(configured()).toHaveLength(2);
  const second = leaseHash(configured()[1]!);
  expect(second).not.toBe(first);
  expect(await createSqlMcpLeasePort(sql).validate(first, "tools")).toBeNull();
  await hosts.revoke(f.admin, f.hostId);
  expect(await createSqlMcpLeasePort(sql).validate(second, "tools")).toBeNull();
});

test("legacy Docker claims without preparation keep their original hash and do not acquire later defaults", async () => {
  const db = database();
  const f = await fixture();
  f.setDrive(false);
  expect((await f.service(sql, true, 10000).launch(f.caller, f.body)).sandbox.status).toBe("starting");
  const row = (
    await db.query<{ request_enc: Uint8Array<ArrayBuffer>; request_hash: string }>(
      "select request_enc,request_hash from public.docker_launch_manifests where sandbox_id=$1",
      [f.body.requestId],
    )
  ).rows[0];
  if (!row) throw Error("missing original claim");
  const manifest = JSON.parse(await decryptSecret(row.request_enc, key));
  delete manifest.preparation;
  await db.query("update public.jobs set payload_enc=$2 where sandbox_id=$1 and kind='launch'", [
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
        "select request_hash from public.docker_launch_manifests where sandbox_id=$1",
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
test.each(["host", "snapshot", "revoked", "contended"])(
  "Docker template launch follows the shared reservation and authority checks (%s)",
  async (scenario) => {
    const fromSnapshot = scenario === "snapshot";
    const db = database();
    const f = fromSnapshot ? await snapshotFixture() : await fixture();
    const snapshotId = fromSnapshot ? await seedReadySnapshot(f) : undefined;
    const templates = createTemplateService(sql, key);
    const variableId = await seedPersonalVariable(
      f.actor.orgId,
      f.actor.userId,
      "APP_REGION",
      "offline-template-region",
    );
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
    let dispatches = 0;
    const runtime: TemplateRuntime = {
      stores: { goldens: stores.goldens, sandboxes: stores.sandboxes, credentials },
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
    const admitted = await templates.command(f.caller, "launch", input, runtime);
    expect(admitted).toMatchObject({ state: "succeeded", provider: "docker", status: "starting" });
    expect(f.jobs).toHaveLength(0);
    if (scenario === "revoked") {
      let checks = 0;
      await f.service().runClaim(async (tx) => {
        if (!tx && ++checks === 2) await templates.command(f.caller, "delete", { org: f.actor.orgId, id });
        return true;
      });
      expect((await counts(f))?.jobs).toBe(0);
      return;
    }
    let contended = false;
    const lockFault: Sql = {
      ...sql,
      transaction: (work) =>
        sql.transaction!((tx) =>
          work({
            query(statement, params) {
              if (!contended && f.session() && statement.includes("for share of t nowait")) {
                contended = true;
                throw Object.assign(Error("Template lock held"), { code: "55P03" });
              }
              return tx.query(statement, params);
            },
          }),
        ),
    };
    await f.service(scenario === "contended" ? lockFault : sql).drain();
    if (scenario === "contended") expect(contended).toBe(true);
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
      launchDocker: async (body, admission) => {
        if (change === "revoked") await db.query("update docker_hosts set revoked_at=now() where id=$1", [f.hostId]);
        if (change === "replaced")
          await db.query("update docker_hosts set installation_id=$2 where id=$1", [f.hostId, randomUUID()]);
        if (change === "issuer_removed") {
          await db.query(
            "insert into members(org_id,user_id,role) values($1,$2,'admin') on conflict(org_id,user_id) do update set role='admin'",
            [f.actor.orgId, f.actor.userId],
          );
          await db.query("delete from members where org_id=$1 and user_id=$2", [f.actor.orgId, f.admin.userId]);
        }
        f.body.requestId = body.requestId as typeof f.body.requestId;
        return f.service().launch(f.caller, body, admission);
      },
    };
    const launch = templates.command(
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
    const result = await launch;
    expect(result.state).toBe("failed");
    if (change === "replaced") expect(result.reason).toBe("environment_binding_changed");
    expect(await counts(f)).toEqual({ sandboxes: 0, claims: 0, jobs: 0, commands: 0 });
  }
});

test("a Docker routine settles the scheduled occurrence from its shared launch receipt", async () => {
  const f = await fixture();
  const org = f.actor.orgId;
  const templates = createTemplateService(sql, key);
  const { item } = await templates.command(f.caller, "create", {
    org,
    scope: "personal",
    name: "Routine host",
    definition: { provider: "docker", hostId: f.hostId, harness: "codex" },
  });
  const routine = (
    await createRoutineService(sql).command(f.caller, "create", {
      org,
      scope: "personal",
      name: "Inspect",
      templateId: (item as { id: string }).id,
      templateRevision: 1,
      prompt: f.body.prompt,
      intervalHours: 1,
      maxRunsPerDay: 24,
      ttlSeconds: 600,
    })
  ).item as { id: string };
  await sql.query("update routines set status='enabled',next_due_at=now()-interval '1 second' where id=$1", [
    routine.id,
  ]);
  const launch = f.service(sql, true, 10000, officialImage, true);
  const { options: control } = restControl(f, { admitHostLaunch: launch.launch });
  const scheduler = createServerRoutineScheduler({
    sql,
    control,
    templates,
    providers: control.providers!,
    data: createSqlData(sql),
  });
  await scheduler.tick();
  await scheduler.drain();
  const readRun = async () =>
    (
      await sql.query<{ id: string; sandbox_id: string; state: string; prompt_id: string | null }>(
        "select id,sandbox_id,state,prompt_id from routine_runs where routine_id=$1 and state<>'skipped'",
        [routine.id],
      )
    ).rows[0]!;
  const admitted = await readRun();
  expect(admitted).toMatchObject({ state: "reconciling", prompt_id: null });
  expect(f.jobs).toHaveLength(0);
  f.body.requestId = admitted.sandbox_id as typeof f.body.requestId;
  await launch.drain();
  await sql.query("update routine_runs set lease_until=now()-interval '1 second' where id=$1", [admitted.id]);
  await scheduler.tick();
  await scheduler.drain();
  expect(await readRun()).toMatchObject({
    state: "succeeded",
    sandbox_id: admitted.sandbox_id,
    prompt_id: f.receipt.promptId,
  });
  expect(await counts(f)).toMatchObject({ sandboxes: 1, claims: 1, jobs: 2 });
});

test.each(["lost_response", "superseded_refusal"])("Docker template replay after %s", async (scenario) => {
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
    launchDocker: async (body, admission) => {
      dispatches++;
      f.body.requestId = body.requestId as typeof f.body.requestId;
      if (scenario === "superseded_refusal" && dispatches === 1) {
        await templates.command(f.caller, "launch", input, runtime);
        throw new DockerTemplateAdmissionRefused("host_full", "Docker host capacity unavailable.");
      }
      const source: Sql =
        scenario === "lost_response"
          ? {
              ...sql,
              async transaction(work) {
                const result = await sql.transaction!(work);
                if ((await counts(f))?.claims) throw Error("Reservation commit reply lost");
                return result;
              },
            }
          : sql;
      return f.service(source).launch(f.caller, body, admission);
    },
  };
  const input = {
    org: f.actor.orgId,
    id: (created.item as { id: string }).id,
    requestKey: "lost-response",
    prompt: f.body.prompt,
  };
  const start = templates.command(f.caller, "launch", input, runtime);
  if (scenario === "lost_response") await expect(start).rejects.toThrow();
  else expect(await start).toMatchObject({ status: "starting" });
  expect(await templates.command(f.caller, "launch", input, runtime)).toMatchObject({
    state: "succeeded",
    status: "starting",
    id: f.body.requestId,
  });
  expect(dispatches).toBe(scenario === "lost_response" ? 1 : 2);
  expect(await counts(f)).toMatchObject({ sandboxes: 1, claims: 1, jobs: 0 });
});

async function snapshotFixture(enabled = true, options: Parameters<typeof fixture>[0] = {}, defaultBranch = "main") {
  const db = database();
  const f = await fixture({ daemonVersion: "2.55.0", ...options });
  const [refresh, actorAccess, adminAccess] = await Promise.all([
    encryptSecret("offline-refresh", key),
    encryptSecret("offline-snapshot-access", key),
    encryptSecret("offline-admin-access", key),
  ]);
  await db.query(
    `insert into public.github_connections
      (user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
     values ($1,123,'owner','Owner',$3,$4,now()+interval '2 hours'),
            ($2,124,'owner','Owner',$3,$5,now()+interval '2 hours')`,
    [f.actor.userId, f.admin.userId, refresh, actorAccess, adminAccess],
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
  return { ...f, snapshots, adminCaller, config: snapshotConfig };
}

const snapshotConfig = {
  repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
  init: ["printf built > /home/user/proof"],
};

async function seedReadySnapshot(
  f: Awaited<ReturnType<typeof fixture>>,
  config = snapshotConfig,
  { name = "fixture-snapshot", visibility = "private" }: { name?: string; visibility?: "private" | "org" } = {},
) {
  const id = randomUUID();
  await database().query(
    `insert into public.docker_snapshots(
       id,org_id,owner_id,host_id,installation_id,name,visibility,config,request_hash,actor_epoch,issuer_epoch,
       generation,base_image,status,image_id,build_expires_at,built_on_version,baseline_version,required_baseline_version
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,$11,'ready',$12,now()+interval '1 hour',$13,1,1)`,
    [
      id,
      f.actor.orgId,
      visibility === "org" ? f.admin.userId : f.actor.userId,
      f.hostId,
      f.installationId,
      name,
      visibility,
      JSON.stringify(config),
      "b".repeat(64),
      randomUUID(),
      officialSandboxImage(),
      `sha256:${"d".repeat(64)}`,
      VERSION,
    ],
  );
  return id;
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
  const f = await fixture({ daemonVersion: "2.55.0" });
  const snapshotId = await seedReadySnapshot(f, { repos: [], init: [] });
  const templates = createTemplateService(sql, key);
  const definition = { provider: "docker", hostId: f.hostId, snapshotId, harness: "codex" };
  const request = { org: f.actor.orgId, scope: "personal", name: "snapshot-template", definition };
  const adminCaller: Caller = { ...f.caller, userId: f.admin.userId, orgs: [{ orgId: f.actor.orgId, role: "admin" }] };
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
    const created = await templates.command(adminCaller, "create", request);
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
      templates.command(scenario === "org_private" ? adminCaller : f.caller, "create", request),
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
    const created = await f.snapshots.command(creator, "create", input);
    expect(created).toMatchObject({ snapshot: { id, status: "building", visibility, builtOnVersion: VERSION } });
    expect(
      (await db.query("select base_image,built_on_version from public.docker_snapshots where id=$1", [id])).rows[0],
    ).toEqual({ base_image: officialSandboxImage(), built_on_version: VERSION });
    if (visibility === "private") {
      await expect(
        db.query("update public.docker_snapshots set built_on_version='0.0.1' where id=$1", [id]),
      ).rejects.toThrow("Snapshot base is immutable");
      await expect(
        db.query("update public.docker_snapshots set base_image=$2 where id=$1", [
          id,
          `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"e".repeat(64)}`,
        ]),
      ).rejects.toThrow("Snapshot base is immutable");
    }
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
    if (visibility === "private") {
      for (const fields of [{ image: officialImage }, { baseImage: officialImage }, { builtOnVersion: "0.0.1" }])
        await expect(
          f.snapshots.command(creator, "create", { ...input, requestId: randomUUID(), ...fields }),
        ).rejects.toMatchObject({ code: "invalid" });
    }
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
          ? {
              baselineWarning: expect.stringContaining("This snapshot was built without a reported developer baseline"),
            }
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
    const { hostId: _, prompt: _prompt, ...body } = f.body;
    // The published launch contract and the handler agree on the Docker source shapes:
    // a snapshot body without hostId is valid; no source, or a snapshot with repos, is refused by both.
    const published = publishedRequest("sandbox/launch");
    const { requestId: idempotencyKey, ...fields } = body;
    published.parse({ ...fields, idempotencyKey, snapshotId: id });
    published.parse({ ...fields, idempotencyKey, snapshotId: id, hostId: f.hostId });
    if (visibility === "private") {
      const repos = [{ url: "https://github.com/example/project.git" }];
      for (const refused of [body, { ...body, snapshotId: id, repos }, { ...f.body, snapshotId: id, repos }]) {
        const attempt = { ...refused, requestId: randomUUID() };
        const { requestId, ...publicFields } = attempt;
        expect(published.safeParse({ ...publicFields, idempotencyKey: requestId }).success).toBe(false);
        await rejected(f.service().launch(f.caller, attempt), "invalid_request");
      }
    }
    const launched = await f.service().launch(f.caller, { ...body, snapshotId: id });
    expect(launched.sandbox).toMatchObject({ image, snapshotId: id, hostId: f.hostId });
    const { post } = restControl(f);
    const status = await post("sandbox/status", { org: f.actor.orgId, id: launched.sandbox.id });
    expect(publishedResponse("sandbox/status").parse(status)).toMatchObject({
      snapshotId: id,
      hostId: f.hostId,
      image,
    });
    expect(f.jobs[0]).toMatchObject({ request: { image, snapshot: { id, ownerId: creator.userId, visibility } } });
    expect((f.native as { op: string }[]).map((cmd) => cmd.op)).toEqual([
      "health",
      "configureGitHub",
      "workspaceExec",
      "health",
      "configureMcp",
    ]);
    const refresh = (f.native as { op: string; input?: { command: string } }[]).find(
      (command) => command.op === "workspaceExec",
    );
    expect(refresh?.input?.command).toContain("git fetch origin");
    expect(refresh?.input?.command).not.toContain("credential.helper=");
    expect(refresh?.input?.command).not.toContain("git clone");
    expect(refresh?.input?.command).not.toContain("printf built");

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
  const id = await seedReadySnapshot(f);
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
    const id = await seedReadySnapshot(f);
    const { hostId: _, ...body } = f.body;
    const service = f.service(sql, true, 10000, officialImage, deferred);
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
  },
);

test.each(["timeout", "stop"] as const)(
  "snapshot refresh wait honors launch admission while its runtime reply is withheld (%s)",
  async (mode) => {
    const timeoutMs = 5000;
    const f = await snapshotFixture(true, { withholdWorkspace: mode === "timeout" ? { timeoutMs } : "stop" });
    const id = await seedReadySnapshot(f);
    const { hostId: _, ...body } = f.body;
    const startedAt = f.clock.now();
    const result = await f.service(sql, true, timeoutMs).launch(f.caller, { ...body, snapshotId: id });
    expect(result.promptId).toBeUndefined();
    const elapsed = f.clock.now() - startedAt;
    if (mode === "timeout") expect(elapsed).toBe(timeoutMs);
    else expect(elapsed).toBeLessThan(timeoutMs);
    expect((f.native as { op: string }[]).some((command) => command.op === "workspaceExec")).toBe(true);
    expect((f.native as { op: string }[]).some((command) => command.op === "prompt")).toBe(false);
  },
);

test.each(["auth", "auth-deferred", "network"] as const)(
  "snapshot refresh uses the shared authorization/fallback policy before prompt (%s)",
  async (mode) => {
    const db = database();
    const f = await snapshotFixture(true, { refreshFailure: mode === "network" ? "network" : "auth" });
    const id = await seedReadySnapshot(f);
    const { hostId: _, ...body } = f.body;
    const request = { ...body, snapshotId: id };
    const service = f.service(sql, true, 10000, officialImage, mode === "auth-deferred");
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
          (await db.query("select request_id from docker_host_jobs where bound_sandbox_id=$1", [admitted?.sandbox.id]))
            .rows.length;
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
        const warnings = spyOn(console, "warn");
        try {
          await service.drain();
          const worker = warnings.mock.calls
            .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined))
            .filter((record) => record?.event === "provider_call" && record.operation === "launch");
          expect(worker).toEqual([expect.objectContaining({ requestId, provider: "docker", outcome: "error" })]);
          expect(warnings.mock.calls).toContainEqual(["docker_launch_failed", expect.objectContaining({ requestId })]);
        } finally {
          warnings.mockRestore();
        }
        expect(
          (
            await db.query(
              "select from_status, to_status, actor, code from sandbox_transitions where sandbox_id=$1 and to_status='failed'",
              [f.body.requestId],
            )
          ).rows,
        ).toEqual([
          {
            from_status: "ready",
            to_status: "failed",
            actor: "lifecycle_runner",
            code: "docker_launch_failed",
          },
        ]);
        expect(
          (
            await db.query<{ status_reason: string }>("select status_reason from sandboxes where id=$1", [
              f.body.requestId,
            ])
          ).rows[0]?.status_reason,
        ).toContain("Repository project needs a GitHub connection");
      }
      const replay = await service.launch(f.caller, request);
      expect(replay.sandbox).toMatchObject({
        status: "failed",
        statusReason: expect.stringContaining("Repository project needs a GitHub connection"),
      });
      expect((f.native as { op: string }[]).some((command) => command.op === "prompt")).toBe(false);
    }
    const refresh = (f.native as { op: string; input?: { command: string } }[]).find(
      (command) => command.op === "workspaceExec",
    );
    expect(refresh?.input?.command).toContain("git fetch origin");
    expect(refresh?.input?.command).not.toContain("credential.helper=");
    expect(refresh?.input?.command).not.toContain("git clone");
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
  const f = await fixture({ daemonVersion: "2.55.0" });
  const id = await seedReadySnapshot(f);
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
  const f = await snapshotFixture();
  const id = await seedReadySnapshot(f);
  const { hostId: _, ...body } = f.body;
  const launched = await f.service().launch(f.caller, { ...body, snapshotId: id });
  await db.query(`update public.docker_hosts set draining_at=now() where id=$1`, [f.hostId]);
  // Admission is historical: a lost response replays the saved sandbox, not a drain refusal.
  expect((await f.service().launch(f.caller, { ...body, snapshotId: id })).sandbox.id).toBe(launched.sandbox.id);
});

test("rebuilding a snapshot on a draining host names the uninstall, not a missing original host", async () => {
  const db = database();
  const f = await snapshotFixture();
  const id = await seedReadySnapshot(f);
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
  const { requestId, credentialId, harness } = f.body;
  const generation = randomUUID();
  await db.query(
    `insert into public.sandboxes(
       id,org_id,owner_id,access_owner_id,provider,provider_sandbox_id,harness,visibility,status,
       docker_host_id,docker_installation_id,docker_generation,docker_image,credential_id,credential_version,
       expires_at,stopped_at
     ) values($1,$2,$3,$3,'docker',$4,$5,'private','stopped',$6,$7,$8,$9,$10,2,now()+interval '1 hour',now())`,
    [
      requestId,
      f.actor.orgId,
      f.actor.userId,
      `armada-${f.installationId}-${f.hostId}-${requestId}-${generation}`,
      harness,
      f.hostId,
      f.installationId,
      generation,
      officialImage,
      credentialId,
    ],
  );
  const unavailable = async () => {
    throw Error("Resume must be refused before provider work.");
  };
  const resume = createResumeJob({
    sql,
    key,
    commands: createRuntimeCommands(createRuntimeEnrolments(sql, key), key, f.clock),
    turns: createAccountTurnQueue(sql, key),
    provider: unavailable,
    prepare: unavailable,
    prepareMcp: unavailable,
    restoreScopedAccess: unavailable,
  });
  const controls = createDockerSandboxControls(sql, key, { resume: resume.resumeDocker });
  const before = await counts(f);
  for (const protocol of [null, DOCKER_HOST_PROTOCOL + 1]) {
    await db.query("update docker_hosts set daemon_protocol=$2 where id=$1", [f.hostId, protocol]);
    await expect(f.resume(controls)).rejects.toMatchObject({
      code: "docker_host_upgrade_required",
      message: expect.stringContaining("Upgrade the Docker host daemon"),
    });
    expect(await counts(f)).toEqual(before);
    expect(
      (await db.query("select 1 from public.jobs where sandbox_id=$1 and kind='resume'", [requestId])).rows,
    ).toEqual([]);
    expect((await createDockerSandboxService(sql).get(f.actor, requestId)).status).toBe("stopped");
  }
});

test("snapshot admission requires a protocol-aware host poll", async () => {
  const f = await snapshotFixture();
  const route = createDockerHostRoutes(hosts, async () => ({ ok: true, caller: f.caller }), {
    snapshots: f.snapshots,
  });
  await database().query("update docker_hosts set daemon_protocol=null where id=$1", [f.hostId]);
  const poll = () =>
    route(
      new Request("https://fixture.example/api/docker-host/poll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.hostToken}`,
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL - 1),
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
  const response = await create();
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({
    error: {
      code: "docker_host_upgrade_required",
      message: expect.stringContaining("Upgrade the Docker host daemon"),
    },
  });
  expect(await (await poll())?.json()).toMatchObject({ job: null });
  expect((await create())?.status).toBe(200);
});

test("a verified receipt publishes an organization snapshot through the daemon result route", async () => {
  const f = await snapshotFixture();
  const requestId = randomUUID();
  await f.snapshots.command(f.adminCaller, "create", {
    org: f.actor.orgId,
    hostId: f.hostId,
    requestId,
    name: "mixed-replicas",
    visibility: "org",
    config: f.config,
  });
  const job = await hosts.poll(f.hostToken, f.installationId);
  if (job?.operation !== "buildSnapshot") throw Error("Missing build job");
  const route = createDockerHostRoutes(hosts, async () => ({ ok: false }));
  const request = (async (url, init) => {
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
    snapshot: { status: "ready", visibility: "org", baselineVersion: 1 },
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
    const f = await snapshotFixture();
    const id = await seedReadySnapshot(f, f.config, { name: "rebuild-source", visibility });
    const requestId = randomUUID();
    const creator = visibility === "private" ? f.caller : f.adminCaller;
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

test("Docker refuses models outside the Morph account and freezes its OpenCode default for replay", async () => {
  const f = await fixture({ harness: "opencode" });
  const body = { ...f.body, credentialId: randomUUID() };
  await sql.query(
    "insert into public.credentials(id,version,scope,owner_id,kind,value_enc) values($1,1,'user',$2,'morph',$3)",
    [
      body.credentialId,
      f.actor.userId,
      await encryptSecret(
        JSON.stringify({ apiKey: f.secret, models: ["vendor/saved-model", "vendor/alternate"] }),
        key,
      ),
    ],
  );
  const launcher = f.service(sql, true, 10000, officialImage, true);
  await expect(launcher.launch(f.caller, { ...body, model: "vendor/unlisted" })).rejects.toMatchObject({
    code: "invalid_request",
    message: "Choose a Morph plan model configured on this account.",
  });

  const admitted = await launcher.launch(f.caller, body);
  try {
    expect(admitted.sandbox).toMatchObject({ status: "starting", model: "armada/vendor/saved-model" });
    const resolutions = f.resolutions();
    expect((await launcher.launch(f.caller, body)).sandbox.model).toBe(admitted.sandbox.model);
    expect(f.resolutions()).toBe(resolutions);
    await expect(launcher.launch(f.caller, { ...body, model: "armada/deepseek-flash" })).rejects.toMatchObject({
      code: "conflict",
    });
  } finally {
    const controls = createDockerSandboxControls(sql, key, { clock: f.clock });
    await controls.invoke(f.caller, "stop", { id: admitted.sandbox.id });
  }
});

test.each(["account_full", "incompatible_model"] as const)(
  "Docker pool fallback persists %s in its launch manifest",
  async (reason) => {
    const capped = reason === "account_full";
    const harness = capped ? "codex" : "opencode";
    const f = await fixture({ harness });
    const db = database();
    const second = randomUUID();
    if (capped) {
      await db.query("update credentials set max_agents=1 where id=$1", [f.body.credentialId]);
      await f.seedRunningSandbox();
    }
    const value = capped
      ? "offline-fallback"
      : JSON.stringify({
          apiKey: "offline-fallback",
          endpoint: { version: 1, baseUrl: "https://models.example/v1", models: ["other-model"] },
        });
    await db.query(
      "insert into credentials(id,scope,owner_id,kind,name,value_enc) values($1,'user',$2,$4,'fallback',$3)",
      [second, f.actor.userId, await encryptSecret(value, key), capped ? "openai" : "opencode"],
    );
    await db.query("insert into agent_defaults(user_id,harness,credential_id,credential_ids) values($1,$4,$2,$3)", [
      f.actor.userId,
      f.body.credentialId,
      [f.body.credentialId, second],
      harness,
    ]);
    const { credentialId: _explicit, ...implicit } = f.body;
    const body = { ...implicit, requestId: randomUUID(), ...(capped ? {} : { model: "armada/other-model" }) };
    const server = f.service(sql, true, 10_000, officialImage, true);
    const admitted = await server.launch(f.caller, body);
    expect(admitted.sandbox).toMatchObject({ credentialId: second, credentialVersion: 1, status: "starting" });
    const {
      rows: [row],
    } = await db.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
      "select request_enc from docker_launch_manifests where sandbox_id=$1",
      [body.requestId],
    );
    expect(JSON.parse(await decryptSecret(row!.request_enc, key))).toMatchObject({
      credentialId: second,
      credentialVersion: 1,
      accountSkips: [{ credentialId: f.body.credentialId, reason: { code: reason } }],
    });
  },
);

test("Docker normal launch uses the saved model unless explicitly overridden", async () => {
  for (const explicit of [false, true]) {
    const f = await fixture();
    await createSqlVaultStore(sql).setAgentDefault!(f.actor.userId, {
      harness: "codex",
      credentialId: f.body.credentialId,
      model: "gpt-6-astra",
    });
    const launch = f.service(sql, true, 10_000, officialImage, true);
    const body = { ...f.body, ...(explicit ? { model: "gpt-6.1-terra" } : {}) };
    const result = await launch.launch(f.caller, body);
    try {
      expect(result.sandbox).toMatchObject({ status: "starting", model: explicit ? "gpt-6.1-terra" : "gpt-6-astra" });
      await createSqlVaultStore(sql).setAgentDefault!(f.actor.userId, {
        harness: "codex",
        credentialId: null,
        model: "gpt-6.1-sol",
      });
      const replay = await launch.launch(f.caller, body);
      expect(replay.sandbox).toMatchObject({ id: result.sandbox.id, model: result.sandbox.model });
    } finally {
      const controls = createDockerSandboxControls(sql, key, { clock: f.clock });
      await controls.invoke(f.caller, "stop", { id: f.body.requestId });
    }
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
