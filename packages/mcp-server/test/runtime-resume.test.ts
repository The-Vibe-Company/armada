import { describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { createMemoryAuthStore, sha256Hex } from "@armada/auth";
import {
  createSqlVaultStore,
  DelegatedAuthority,
  decryptSecret,
  encryptSecret,
  type Harness,
  type Provider,
  SANDBOX_STOP_MARGIN_SECONDS,
  type Sql,
} from "@armada/core/server";
import { fakeBoat, retainedSandbox, sandbox as sdkSandbox } from "../../provider-boat/test/support.ts";
import { admitClaimedAccountTurn, dispatchAccountTurn } from "../src/account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { boatRuntimeResume } from "../src/boat-runtime-resume.ts";
import { createQueuedSandboxDispatch, dispatchControlCommand } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { createResumeJob } from "../src/jobs/resume.ts";
import { createJobsStore, JOBS_WAKE } from "../src/jobs/store.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "../src/runtime-enrolment.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { createRuntimeHistory } from "../src/runtime-history.ts";
import { BoatResumeActivationUncertain, createRuntimeResume } from "../src/runtime-resume.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { createSandboxArmadaAccess } from "../src/sandbox-armada-access.ts";
import { createSandboxLifecycle, transitionSandbox } from "../src/sandbox-lifecycle.ts";
import { runtimeWakes } from "../src/wake-bus.ts";
import { archivedBoat, runBoatStop } from "./boat-stop.fixture.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { configureRuntimeFixture, runtimeFixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { runClaimedStop } from "./stop-job.fixture.ts";
import { bunLikeSql, ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function stopped(harness: Harness = "codex", provider: "boat" | "modal" = "boat", idle = false) {
  const f = await runtimeFixture(await sharedDatabase(), provider, harness, idle);
  return configureRuntimeFixture(f, async () => {
    const cp = await createRuntimeCheckpoint(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
    )(f.caller, { id: f.row.id, request_id: crypto.randomUUID(), runtimeVersion: 1 });
    await f.db.query("update sandboxes set stop_requested_at=now(),status='stopping' where id=$1", [f.row.id]);
    await f.db.query("update sandboxes set stop_requested_at=null,status='stopped',stopped_at=now() where id=$1", [
      f.row.id,
    ]);
    return Object.assign(f, { cp });
  });
}
const input = (id: string) => ({
  id,
  request_id: crypto.randomUUID(),
  runtimeVersion: 1 as const,
  prompt: "continue the previous conversation",
});

test("a stopped Antigravity Modal sandbox refuses resume before activation", async () => {
  const f = await stopped("antigravity", "modal", true);
  const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => {
    throw Error("Antigravity must not activate retained compute");
  });
  await expect(resume(f.caller, input(f.row.id))).rejects.toMatchObject({
    code: "unavailable",
    message: "This harness cannot resume a stopped conversation.",
  });
  const turns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
  const service = createResumeJob({
    sql: f.sql,
    key: ENCRYPTION_KEY,
    commands: f.bridge,
    turns,
    async provider() {
      throw Error("Unsupported harness must not allocate.");
    },
    async prepare() {
      throw Error("Unsupported harness must not prepare a ticket.");
    },
    async prepareMcp() {
      return undefined;
    },
    async restoreScopedAccess() {},
  });
  const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, resume, undefined, service.wake);
  await expect(send(f.caller, input(f.row.id), undefined, { fromQueue: true })).rejects.toMatchObject({
    code: "unavailable",
    message: "This harness cannot resume a stopped conversation.",
  });
  expect((await f.db.query("select 1 from jobs where sandbox_id=$1 and kind='resume'", [f.row.id])).rows).toEqual([]);
  expect((await f.db.query("select 1 from runtime_resumes where sandbox_id=$1", [f.row.id])).rows).toEqual([]);
});

describe("historical Modal resume receipt", () => {
  const fixture = scopedRuntimeFixture(() => stopped("codex", "modal"), { perTest: true });
  test("replays the original durable receipt through the new route", async () => {
    const f = await fixture();
    const request = input(f.row.id);
    const conversation = f.first.conversationId!;
    const hash = await sha256Hex(
      JSON.stringify({
        id: request.id,
        requestId: request.request_id,
        conversation,
        prompt: request.prompt,
      }),
    );
    const receipt = {
      id: request.id,
      requestId: request.request_id,
      promptId: "accepted",
      conversationId: conversation,
      status: "running",
      resumed: true,
      runtime: { kind: "armada", epoch: "2" },
      sourceCheckpoint: { epoch: "1", watermark: f.cp.checkpoint.watermark },
    };
    await f.sql.query(
      `insert into public.runtime_resumes(sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,
        conversation_id,model,reasoning_effort,phase,receipt,verified_at)
        values($1,$2,1,2,$3,$4,$5,'gpt-5.4','high','complete',$6::jsonb,now())`,
      [request.id, request.request_id, f.cp.checkpoint.watermark, hash, conversation, JSON.stringify(receipt)],
    );
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge);
    expect(await resume(f.caller, request)).toEqual(receipt as Awaited<ReturnType<typeof resume>>);
    const turns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
    expect(await turns.accept(f.caller, request)).toEqual(receipt);
    await expect(turns.accept(f.caller, { ...request, model: "changed" })).rejects.toMatchObject({ code: "invalid" });

    await expect(resume(f.caller, { ...request, prompt: "changed" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("Modal retained stop", () => {
  const fixture = scopedRuntimeFixture(async () => runtimeFixture(await sharedDatabase(), "modal"), {
    perTest: true,
  });

  test.each([false, true])(
    "retained stop publishes the checkpoint and captures output once (recover=%s)",
    async (recover) => {
      const f = await fixture();
      let needsRetry = recover;
      let captures = 0;
      let state: "ready" | "stopped" = "ready";
      let retained: { epoch: string; watermark: number } | undefined;
      const host = {
        id: "modal",
        async get() {
          return { id: f.row.providerSandboxId, state, providerState: state, physicalGeneration: "1" };
        },
        async readOutputs() {
          captures++;
          return [{ name: "last.txt", bytes: new Uint8Array([42]) }];
        },
        async runtimeStopMachine({ checkpoint }: { checkpoint: typeof retained }) {
          return {
            physical: { machineId: f.row.providerSandboxId, generation: 1 },
            machine: {
              async stop({ sandboxId, generation }: { sandboxId: string; generation: number }) {
                if (needsRetry) {
                  needsRetry = false;
                  throw Error("Worker interrupted after final output capture");
                }
                retained = checkpoint;
                state = "stopped";
                return { sandboxId, generation, kind: "image", ref: "image" };
              },
            },
          };
        },
      };
      const serve = createRuntimeServing(f.sql, ENCRYPTION_KEY);
      const store = createSqlVaultStore(f.sql);
      const providers = providerRegistry({
        vault: store,
        encryptionKey: ENCRYPTION_KEY,
        providerFor: () => {
          throw Error("Unexpected Boat fallback");
        },
        modalTokensFor: async () => ({ tokenId: "id", tokenSecret: "secret", scope: "org" }),
        modalProviderFor: () => ({
          provider: host as unknown as Provider,
          captureRuntimeWork: async () => ({ status: "clean" }),
        }),
        runtimeProviderFor: serve,
      });
      const controls = {
        authStore: createMemoryAuthStore(),
        supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
        store,
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(f.sql),
        providers,
        runtimeStopCheckpoint: createRuntimeStopCheckpoint(
          f.sql,
          createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge),
        ),
      };
      const stop = () => dispatchControlCommand("sandbox/stop", f.caller, { id: f.row.id }, controls);
      expect(await stop()).toMatchObject({ status: "stopping" });
      const resolve = async () => providers.resolve((await controls.data(f.caller).sandboxes.get(f.row.id))!, f.caller);
      if (recover) {
        const first = await runClaimedStop(f.sql, resolve, false);
        expect(first.result.status).toBe("retry");
        expect(first.job.outcome).toBeNull();
        expect(
          (await f.db.query("select outcome->'output' as output from jobs where id=$1", [first.job.id])).rows,
        ).toMatchObject([{ output: { inline: [{ name: "last.txt" }] } }]);
        await f.db.query("update jobs set lease_until=now()-interval '1 second' where id=$1", [first.job.id]);
      }
      expect((await runClaimedStop(f.sql, resolve)).result.status).toBe("done");
      expect(captures).toBe(1);
      expect((await controls.data(f.caller).sandboxes.get(f.row.id))?.status).toBe("stopped");
      expect(retained).toMatchObject({ epoch: "1", watermark: expect.any(Number) });
    },
  );
});

describe.each([
  ["boat", "codex"],
  ["boat", "claude"],
] as readonly ["boat" | "modal", Harness][])("retained runtime resume (%s/%s)", (provider, harness) => {
  // Cold WASM/migrations and building the stopped checkpoint are prerequisites,
  // not resume/replay work. Keep the behavior timeout and real assertions intact.
  const fixture = scopedRuntimeFixture(() => stopped(harness, provider), { timeout: 20_000 });

  test("explicit resume wakes a checkpointed runtime in the same conversation; replay never activates or starts a turn twice", async () => {
    const f = await fixture();
    const old = f.active;
    f.deliverPromptEventsBeforeReply();
    let activations = 0;
    let preparations = 0;
    let githubPreparations = 0;
    const resume = createRuntimeResume(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
      async () => ({
        async start(_signal, restore) {
          activations++;
          return f.reboot(restore);
        },
        async checkDispatchCoverage() {},
        async stop() {
          throw Error("Healthy resume must not stop compute");
        },
      }),
      provider === "modal"
        ? async () => {
            preparations++;
            return undefined;
          }
        : undefined,
      async (caller, id) => {
        expect(caller.userId).toBe(f.caller.userId);
        expect(id).toBe(f.row.id);
        expect(f.starts).toHaveLength(1);
        githubPreparations++;
        return { status: "connected" as const, login: "owner" };
      },
    );
    const request = { id: f.row.id, request_id: crypto.randomUUID(), prompt: "continue the previous conversation" };
    const before = await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id);
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, resume);
    const controls = {
      authStore: createMemoryAuthStore(),
      supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
      store: createSqlVaultStore(f.sql),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(f.sql),
      providers: {
        async resolve() {
          throw Error("Runtime resume uses its own placement");
        },
      },
      runtimeResume: resume,
    };
    await expect(
      dispatchControlCommand(
        "sandbox/resume-runtime-v1",
        f.caller,
        { ...request, runtimeVersion: 1, conversation_id: f.first.conversationId },
        controls,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      status: 409,
      message: expect.stringContaining("Launch another sandbox"),
    });
    expect(activations).toBe(0);
    const result = (await dispatchControlCommand(
      "sandbox/resume-runtime-v1",
      f.caller,
      { ...request, runtimeVersion: 1 },
      controls,
    )) as Awaited<ReturnType<typeof resume>>;
    expect(result).toMatchObject({
      resumed: true,
      conversationId: f.first.conversationId,
      runtime: { kind: "armada", epoch: "2" },
      sourceCheckpoint: { epoch: "1", watermark: f.cp.checkpoint.watermark },
    });
    expect(result.promptId).not.toBe(f.first.promptId);
    await expect(f.authority.withSession(old.runtimeToken, old.epoch, async () => true)).rejects.toThrow();
    expect(await send(f.caller, request)).toEqual(result);
    expect(activations).toBe(1);
    expect(githubPreparations).toBe(1);
    if (provider === "modal") expect(preparations).toBe(1);
    expect(f.starts).toEqual([undefined, "native-thread"]);
    const row = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!;
    expect(row.status).toBe("ready");
    expect(row.lifecycleGeneration).toBe((before?.lifecycleGeneration ?? 0) + 1);
    expect(
      (
        await f.db.query(
          `select actor,code,generation::text from sandbox_transitions
           where sandbox_id=$1 and ((from_status='stopped' and to_status='starting')
             or (from_status='starting' and to_status='running'))
           order by (from_status='stopped') desc`,
          [f.row.id],
        )
      ).rows,
    ).toEqual([
      { actor: "resume_admission", code: "runtime_resume_admitted", generation: String(row.lifecycleGeneration) },
      { actor: "runtime_enrolment", code: "runtime_enrolled", generation: String(row.lifecycleGeneration) },
    ]);
    expect(row.expiresAt).toBe(before?.expiresAt);
    expect(row.stoppedAt).toBeNull();
    expect(row.taskPromptId).toBe(result.promptId);
    expect(
      (await createRuntimeHistory(f.sql, ENCRYPTION_KEY)(f.caller, f.row.id, {})).events.some(
        (e) => e.promptId === f.first.promptId,
      ),
    ).toBe(true);
    await expect(send(f.caller, { ...request, prompt: "different" })).rejects.toMatchObject({ code: "conflict" });
    expect(activations).toBe(1);
  });
});

async function seedStoppedBoatExtension(f: Awaited<ReturnType<typeof stopped>>) {
  const job = await f.db.query<{ id: string }>(
    `insert into public.jobs (kind,sandbox_id,generation,org_id,idem_key,deadline_at,max_attempts)
     select 'boat_runtime_extend',id,lifecycle_generation,org_id,id::text,expires_at,1
       from public.sandboxes where id=$1 returning id`,
    [f.row.id],
  );
  const jobId = job.rows[0]!.id;
  await f.db.query(
    `insert into public.boat_runtime_extension_state (sandbox_id,pending_job_id)
     values ($1,$2)`,
    [f.row.id, jobId],
  );
  return jobId;
}

describe("retained Boat extension supersession", () => {
  const fixture = scopedRuntimeFixture(() => stopped(), { perTest: true });

  test("detaches extension intent before restore and rejects a late acknowledgement from the prior epoch", async () => {
    const f = await fixture();
    const jobId = await seedStoppedBoatExtension(f);
    const prior = f.active;
    const command = {
      version: 1,
      op: "extendCommandAuthority",
      sandboxId: f.row.id,
      requestId: `extend_${jobId}`,
      epoch: prior.epoch,
      expiresAt: Date.parse(f.row.expiresAt!),
    };
    await f.db.query(
      `insert into public.runtime_commands (sandbox_id,request_id,epoch,request_enc) values ($1,$2,$3,$4)`,
      [f.row.id, command.requestId, prior.epoch, await encryptSecret(JSON.stringify(command), ENCRYPTION_KEY)],
    );
    let atRestore: unknown;
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        const { rows } = await f.db.query(
          `select e.pending_job_id, j.state, s.lifecycle_generation>j.generation as advanced
           from public.boat_runtime_extension_state e
           join public.sandboxes s on s.id=e.sandbox_id
           join public.jobs j on j.sandbox_id=s.id and j.id=$2 where s.id=$1`,
          [f.row.id, jobId],
        );
        atRestore = rows;
        return f.reboot(restore);
      },
      async checkDispatchCoverage() {},
      async stop() {},
    }));
    await expect(resume(f.caller, input(f.row.id))).resolves.toMatchObject({ resumed: true });
    expect(atRestore).toEqual([{ pending_job_id: null, state: "queued", advanced: true }]);
    await expect(
      f.bridge.complete(prior.runtimeToken, prior.epoch, {
        requestId: command.requestId,
        epoch: prior.epoch,
        status: 200,
        body: {
          version: 1,
          requestId: command.requestId,
          result: { epoch: prior.epoch, expiresAt: command.expiresAt },
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeEnrolmentDenied);
    const { rows } = await f.db.query(
      `select e.pending_job_id,c.result_enc is not null as acknowledged
       from public.boat_runtime_extension_state e
       join public.runtime_commands c on c.sandbox_id=e.sandbox_id and c.request_id=$2
       where e.sandbox_id=$1`,
      [f.row.id, command.requestId],
    );
    expect(rows).toEqual([{ pending_job_id: null, acknowledged: false }]);
  });
});

describe("runtime resume admission rollback", () => {
  const fixture = scopedRuntimeFixture(() => stopped(), { perTest: true });

  const faults = [
    "generation conflict",
    "elapsed expiry",
    "transition",
    "launch stage",
    "reread",
    "pre-commit",
    "extension cleanup response",
  ];

  test.each(faults)("leaves the retained stop intact after %s", async (fault) => {
    const f = await fixture();
    const request = input(f.row.id);
    const rollback = Error("Injected admission rollback");
    if (fault === "extension cleanup response") await seedStoppedBoatExtension(f);
    const read = async () =>
      (
        await f.db.query(
          `select status, lifecycle_generation::text, activity_lease_id, stopped_at::text, expires_at::text,
            (select pending_job_id from public.boat_runtime_extension_state where sandbox_id=s.id) as pending_job_id,
            (select count(*)::int from public.runtime_resumes where sandbox_id=s.id) as intents,
            (select count(*)::int from public.sandbox_transitions where sandbox_id=s.id and to_status='starting') as edges
           from public.sandboxes s where id=$1`,
          [f.row.id],
        )
      ).rows;
    const before = await read();
    let prepared = false;
    const admissionSql: typeof f.sql = {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!(async (tx) => {
          let stageUpdated = false;
          const result = await work({
            ...tx,
            async query<T>(statement: string, params?: unknown[]) {
              if (stageUpdated && fault === "reread") throw rollback;
              if (statement.includes("from public.sandbox_transition(")) {
                if (fault === "transition") throw rollback;
                if (fault === "generation conflict") {
                  return tx.query<T>(statement, [params![0], Number(params![1]) + 1, ...params!.slice(2)]);
                }
                if (fault === "elapsed expiry" && params?.[5] === "runtime_resume_admitted") {
                  const expiry = await tx.query<{ expires_ms: number }>(
                    `update public.sandboxes set expires_at=now()+interval '1 second' where id=$1
                        returning ceil(extract(epoch from expires_at)*1000)::float8 as expires_ms`,
                    [f.row.id],
                  );
                  setSystemTime(new Date(expiry.rows[0]!.expires_ms + 1));
                  try {
                    return await tx.query<T>(statement, params);
                  } finally {
                    setSystemTime();
                  }
                }
              }
              if (statement.startsWith("update public.sandbox_launch_stages")) {
                if (fault === "launch stage") throw rollback;
                stageUpdated = true;
              }
              const result = await tx.query<T>(statement, params);
              if (
                fault === "extension cleanup response" &&
                statement.startsWith("update public.boat_runtime_extension_state")
              )
                throw rollback;
              return result;
            },
          });
          if (fault === "pre-commit") throw rollback;
          return result;
        }),
    };
    const resume = createRuntimeResume(admissionSql, ENCRYPTION_KEY, f.bridge, async () => {
      prepared = true;
      throw Error("Unexpected placement preparation");
    });
    const attempt = resume(f.caller, request);
    if (fault === "generation conflict" || fault === "elapsed expiry") {
      await expect(attempt).rejects.toMatchObject({ code: "conflict" });
    } else {
      await expect(attempt).rejects.toThrow(rollback.message);
    }
    expect(prepared).toBe(false);
    expect(await read()).toEqual(before);
  });
});

describe("queued Boat wake admission", () => {
  const provider = "boat" as "boat" | "modal";
  const fixture = scopedRuntimeFixture(() => stopped("codex", provider), { perTest: true });

  const scenarios = [
    "current",
    "health admission loss",
    "verification loss",
    "prompt admission loss",
    "publication loss",
    "scoped grant loss",
    "unenrolled failure",
    "unenrolled claim loss",
    "restore admission loss",
    "before ticket loss",
    "before ticket loss with covering Boat deadline",
    "ticket commit loss",
    "heartbeat loss",
    "ambiguous deferral claim loss",
    "stale",
    "retarget failure",
    "wrong request",
    "replaced epoch",
  ] as const;

  const cases = scenarios.filter(
    (scenario) => !["scoped grant loss", "restore admission loss", "ticket commit loss"].includes(scenario),
  );
  test.each(cases)("fences queued wake admission and publication (%s)", async (scenario) => {
    const coveringBoatDeadline = scenario === "before ticket loss with covering Boat deadline";
    const boatTicketRecovery = provider === "boat" && (scenario === "before ticket loss" || coveringBoatDeadline);
    const scoped = scenario === "scoped grant loss";
    const unenrolled = scenario === "unenrolled failure" || scenario === "unenrolled claim loss";
    const ambiguous = scenario === "ambiguous deferral claim loss";
    const heartbeat = scenario === "heartbeat loss";
    const f = await fixture();
    const access = scoped ? await scopedAccessFor(f) : undefined;
    const request = input(f.row.id);
    const before = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!.lifecycleGeneration!;
    const store = createJobsStore(f.sql, ENCRYPTION_KEY);
    const id = await store.enqueue(
      "turn_dispatch",
      f.row.id,
      before,
      request.request_id,
      { requestId: request.request_id },
      { orgId: f.row.orgId, maxAttempts: 2 },
    );
    await f.db.query(
      `insert into account_turn_queue
             (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,
              conversation_id,queued_generation,state,dispatch_generation,dispatch_until)
           select id,$2,credential_id,owner_id,org_id,1,credential_version,'fixture',''::bytea,$3,
                  lifecycle_generation,'dispatching',lifecycle_generation,'infinity'
           from sandboxes where id=$1`,
      [f.row.id, request.request_id, f.first.conversationId],
    );
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, heartbeat ? 120 : 30, 1))!;
    expect(job.id).toBe(id);
    if (scenario === "stale") await f.db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
    const read = async () =>
      (
        await f.db.query(
          `select s.status,s.lifecycle_generation::text,j.generation::text,
                  exists(select 1 from runtime_resumes r where r.sandbox_id=s.id and r.request_id=$2) as intent
               from jobs j join sandboxes s on s.id=j.sandbox_id where j.id=$1`,
          [id, request.request_id],
        )
      ).rows[0];
    let preparations = 0;
    let stops = 0;
    const readActivityUntil = async (tx: Sql = f.sql) =>
      (await tx.query<{ activity_until: string }>("select activity_until::text from sandboxes where id=$1", [f.row.id]))
        .rows[0]?.activity_until;
    let activityUntil: string | undefined;
    let heartbeatLost = false;
    let replacementEpoch: string | undefined;
    let restores = 0;
    let bootstraps = 0;
    const hasTicket = async () =>
      Boolean(
        (
          await f.db.query("select 1 from runtime_enrolments where sandbox_id=$1 and enrolment_hash is not null", [
            f.row.id,
          ])
        ).rows.length,
      );
    const prepare: NonNullable<Parameters<typeof createRuntimeResume>[3]> = async (_caller, sandbox) => {
      preparations++;
      expect(await read()).toEqual({
        status: "starting",
        lifecycle_generation: String(before + 1),
        generation: String(before + 1),
        intent: true,
      });
      if (boatTicketRecovery) {
        if (preparations === 1)
          return {
            async start(_signal, _restore, confirmActivation) {
              restores++;
              await confirmActivation!();
              await f.db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
              throw Error("Claim lost after confirmed Boat activation");
            },
            async stop() {
              throw Error("Unexpected inline stop");
            },
          };
        return boatRuntimeResume({
          sql: f.sql,
          vault: createSqlVaultStore(f.sql),
          key: ENCRYPTION_KEY,
          modelAuth: createModelAuthOwnership(f.sql, ENCRYPTION_KEY),
          policy: {
            async start(value) {
              if (!value.ticketGuard) throw Error("Expected recovered bootstrap");
              await value.activate?.(value.signal);
              await f.authority.issue({
                sandboxId: value.sandbox.id,
                ownerId: f.caller.userId,
                configuration: {},
                expectedProviderSandboxId: value.sandbox.providerSandboxId,
                expectedGeneration: value.sandbox.lifecycleGeneration!,
                ticketGuard: value.ticketGuard,
                ...(value.assertDispatch ? { assertClaim: value.assertDispatch } : {}),
              });
              bootstraps++;
              throw Error("Fixture ends at ticket issuance");
            },
          },
        })(f.caller, sandbox);
      }
      return {
        async start(_signal, restore, confirmActivation) {
          if (heartbeat) {
            await f.sql.query("update sandboxes set activity_until=clock_timestamp()+interval '1 minute' where id=$1", [
              f.row.id,
            ]);
            activityUntil = await readActivityUntil();
            jest.advanceTimersByTime(30_000);
            throw Error("Placement ends before runtime enrolment");
          }
          if (ambiguous) {
            activityUntil = await readActivityUntil();
            throw new BoatResumeActivationUncertain(Error("Activation response lost"));
          }
          if (unenrolled) {
            if (provider === "modal") await confirmActivation!();
            if (scenario === "unenrolled claim loss")
              await f.db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
            throw Error("Runtime did not enrol");
          }
          f.deliverPromptEventsBeforeReply();
          const ready = await f.reboot(restore);
          if (scenario === "replaced epoch") {
            const ticket = await f.authority.issue({
              sandboxId: f.row.id,
              ownerId: f.caller.userId,
              configuration: {},
            });
            replacementEpoch = (await f.authority.enrol(ticket.enrolmentToken)).epoch;
          }
          return ready;
        },
        async checkDispatchCoverage() {},
        async stop() {
          if (!unenrolled && !ambiguous) throw Error("Unexpected stop during queued wake");
          stops++;
        },
      };
    };
    const resume = createRuntimeResume(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
      prepare,
      undefined,
      undefined,
      access?.restoreEnrolled,
    );
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, resume);
    const sentRequest = scenario === "wrong request" ? input(f.row.id) : request;
    const wakeEvidence = async (tx: Sql = f.sql) =>
      (
        await tx.query<{ health: boolean; verified: boolean; prompt: boolean; published: boolean }>(
          `select
                 exists(select 1 from runtime_commands where sandbox_id=$1 and epoch=r.target_epoch
                   and request_id<>$3) as health,
                 r.verified_at is not null as verified,
                 exists(select 1 from runtime_commands where sandbox_id=$1 and epoch=r.target_epoch
                   and request_id=$3) as prompt,
                 r.receipt is not null as published
               from runtime_resumes r where r.sandbox_id=$1 and r.request_id=$2`,
          [f.row.id, request.request_id, `resume_${request.request_id}`],
        )
      ).rows[0];
    const claim = {
      async canDispatch(tx?: Parameters<typeof store.inspect>[2]) {
        if (!tx && scenario === "ticket commit loss" && (await hasTicket()))
          await f.db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
        if (tx && ambiguous) {
          const { rows } = await tx.query<{ activity_until: string }>(
            "select activity_until::text from sandboxes where id=$1",
            [f.row.id],
          );
          if (rows[0]?.activity_until !== activityUntil)
            await tx.query("update jobs set lease_until='-infinity' where id=$1", [id]);
        }
        if (heartbeat && tx && activityUntil !== undefined) {
          heartbeatLost ||= (await readActivityUntil(tx)) !== activityUntil;
          if (heartbeatLost) return false;
        }
        if ((await store.inspect(job, owner, tx)) !== "dispatch") return false;
        if (!tx || !scenario.endsWith(" loss")) return true;
        const evidence = await wakeEvidence(tx);
        switch (scenario) {
          case "health admission loss":
            return !evidence?.health;
          case "verification loss":
            return !evidence?.verified;
          case "prompt admission loss":
            return !evidence?.prompt;
          case "publication loss":
            return !evidence?.published;
          case "scoped grant loss":
            return !(await acknowledgedScopedGrant(tx, f.row.id));
          default:
            return true;
        }
      },
      handoffGeneration: (handoff: Parameters<typeof store.handoffGeneration>[2]) =>
        store.handoffGeneration(job, owner, handoff),
    };
    const attempt = () => send(f.caller, sentRequest, claim);
    if (scenario === "current") {
      const dispatch = createQueuedSandboxDispatch({
        authStore: createMemoryAuthStore(),
        supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(f.sql),
        providers: {
          async resolve() {
            throw new Error("Runtime send does not call a native provider.");
          },
        },
        runtimeSend: send,
      });
      const { runtimeVersion: _version, ...sendInput } = sentRequest;
      const receipt = await dispatch(f.caller, sendInput, claim);
      expect(receipt).toMatchObject({ resumed: true, requestId: request.request_id });

      await f.db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
      await f.sql.query("update account_turn_queue set input_enc=$3 where sandbox_id=$1 and request_id=$2", [
        f.row.id,
        request.request_id,
        await encryptSecret(JSON.stringify(sendInput), ENCRYPTION_KEY),
      ]);
      const successor = crypto.randomUUID();
      const retry = (await store.claim("turn_dispatch", successor, 30, 1))!;
      const successorClaim = {
        job: retry,
        canDispatch: async (tx?: Sql) => (await store.inspect(retry, successor, tx)) === "dispatch",
        handoffGeneration: () => Promise.reject(Error("A completed wake cannot advance generation again.")),
      };
      const admission = await admitClaimedAccountTurn(f.sql, successorClaim);
      if (!admission) throw new Error("Expected the successor to recover the completed wake.");
      await dispatchAccountTurn(f.sql, ENCRYPTION_KEY, admission.entry, admission.caller, dispatch, successorClaim);
      const {
        rows: [saved],
      } = await f.sql.query<{ state: string; result_enc: Uint8Array<ArrayBuffer> }>(
        "select state,result_enc from account_turn_queue where sandbox_id=$1 and request_id=$2",
        [f.row.id, request.request_id],
      );
      expect(saved?.state).toBe("admitted");
      expect(JSON.parse(await decryptSecret(saved!.result_enc, ENCRYPTION_KEY))).toEqual(receipt);
      expect(preparations).toBe(1);
      expect(f.starts).toHaveLength(2);
    } else if (scenario === "replaced epoch") {
      await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
      expect(replacementEpoch).toBe("3");
      const { rows } = await f.db.query("select request_id from runtime_commands where sandbox_id=$1 and epoch=$2", [
        f.row.id,
        replacementEpoch,
      ]);
      expect(rows).toHaveLength(0);
    } else if (scenario === "restore admission loss") {
      await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
      expect(preparations).toBe(1);
      expect(restores).toBe(0);
      expect(await read()).toMatchObject({ status: "starting", intent: true });
    } else if (scenario === "before ticket loss" || coveringBoatDeadline) {
      await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
      expect(await hasTicket()).toBe(false);
      expect(restores).toBe(1);
      expect(bootstraps).toBe(0);
      await f.db.query("update jobs set generation=$2 where id=$1", [id, before]);
      const successor = crypto.randomUUID();
      const retry = (await store.claim("turn_dispatch", successor, 30, 1))!;
      expect(retry.generation).toBe(String(before + 1));
      const successorClaim = {
        job: retry,
        canDispatch: async (tx?: Sql) => (await store.inspect(retry, successor, tx)) === "dispatch",
        handoffGeneration: () => Promise.reject(Error("A confirmed restore cannot advance generation again.")),
      };
      expect((await admitClaimedAccountTurn(f.sql, successorClaim))?.entry.request_id).toBe(request.request_id);
      if (boatTicketRecovery) {
        const deadline = new Date("2099-01-01T00:00:00Z");
        const { requests, restore } = interceptBoatResume(() =>
          Response.json({
            ok: true,
            sandbox: sdkSandbox({
              id: "physical",
              state: "running",
              archiveAfter: coveringBoatDeadline ? deadline.toISOString() : undefined,
            }),
          }),
        );
        try {
          await expect(send(f.caller, request, successorClaim)).rejects.toMatchObject({ code: "conflict" });
          expect(preparations).toBe(2);
          expect(bootstraps).toBe(coveringBoatDeadline ? 1 : 0);
          if (!coveringBoatDeadline) expect(await hasTicket()).toBe(false);
          const observation = await f.db.query(
            `select observed_provider_id, observed_generation::int, observed_expires_at
             from public.boat_runtime_extension_state where sandbox_id=$1`,
            [f.row.id],
          );
          expect(observation.rows).toEqual(
            coveringBoatDeadline
              ? [{ observed_provider_id: "physical", observed_generation: before + 1, observed_expires_at: deadline }]
              : [],
          );
          expect(requests).toHaveLength(1);
          expect(await read()).toMatchObject({ status: "stopping" });
        } finally {
          restore();
        }
      } else {
        await expect(send(f.caller, request, successorClaim)).rejects.toMatchObject({ code: "conflict" });
        expect(bootstraps).toBe(1);
      }
      expect(restores).toBe(1);
    } else if (scenario === "ticket commit loss") {
      await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
      expect(restores).toBe(1);
      expect(bootstraps).toBe(0);
      expect(await hasTicket()).toBe(true);
      expect(await read()).toMatchObject({ status: "starting", intent: true });
    } else if (heartbeat) {
      jest.useFakeTimers();
      try {
        await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
        expect(heartbeatLost).toBe(true);
        expect(await readActivityUntil()).toBe(activityUntil);
        expect(await read()).toMatchObject({ status: "starting", intent: true });
      } finally {
        jest.useRealTimers();
      }
    } else if (unenrolled || ambiguous) {
      await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
      const settled = scenario === "unenrolled failure";
      const expected = settled
        ? provider === "modal"
          ? { status: "stopping", phase: "abandoned", stops: 0 }
          : { status: "failed", phase: "failed", stops: 0 }
        : { status: "starting", phase: "dispatched", stops: 0 };
      expect(await read()).toMatchObject({ status: expected.status, intent: true });
      const { rows } = await f.db.query<{ phase: string; activity_until: string | null }>(
        `select r.phase,s.activity_until::text from runtime_resumes r join sandboxes s on s.id=r.sandbox_id
         where r.sandbox_id=$1 and r.request_id=$2`,
        [f.row.id, request.request_id],
      );
      expect(rows[0]?.phase).toBe(expected.phase);
      if (ambiguous) {
        expect(activityUntil).toBeDefined();
        expect(rows[0]?.activity_until).toBe(activityUntil!);
      }
      expect(stops).toBe(expected.stops);
    } else if (scenario.endsWith(" loss")) {
      await expect(attempt()).rejects.toThrow();
      expect(await read()).toMatchObject({ status: "starting", intent: true });
      expect(await wakeEvidence()).toEqual({
        health: scenario !== "health admission loss",
        verified: scoped || scenario === "prompt admission loss" || scenario === "publication loss",
        prompt: scenario === "publication loss",
        published: false,
      });
      expect(f.starts).toHaveLength(scenario === "publication loss" ? 2 : 1);
      if (scoped) expect(await acknowledgedScopedGrant(f.sql, f.row.id)).toBe(false);
      await f.db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
      const accepted = await f.bridge.result(f.caller.userId, f.row.id, `resume_${request.request_id}`, "2");
      expect(accepted.state).toBe(scenario === "publication loss" ? "finished" : "missing");
      const successor = crypto.randomUUID();
      const retry = (await store.claim("turn_dispatch", successor, 30, 1))!;
      expect(retry.id).toBe(id);
      const successorClaim = {
        job: retry,
        canDispatch: async (tx?: Sql) => (await store.inspect(retry, successor, tx)) === "dispatch",
        handoffGeneration: () => Promise.reject(Error("An enrolled wake cannot advance generation again.")),
      };
      const admission = await admitClaimedAccountTurn(f.sql, successorClaim);
      expect(admission?.entry.request_id).toBe(request.request_id);
      await expect(send(f.caller, request, successorClaim)).resolves.toMatchObject({
        resumed: true,
        requestId: request.request_id,
      });
      expect(preparations).toBe(provider === "boat" && accepted.state === "missing" ? 2 : 1);
      expect(f.starts).toHaveLength(2);
      if (scoped) expect(await acknowledgedScopedGrant(f.sql, f.row.id)).toBe(true);
    } else {
      if (scenario === "retarget failure") {
        await f.db.exec(
          `alter table jobs add constraint test_refuse_turn_retarget check (generation = ${before}) not valid`,
        );
        try {
          await expect(attempt()).rejects.toThrow("test_refuse_turn_retarget");
        } finally {
          await f.db.exec("alter table jobs drop constraint test_refuse_turn_retarget");
        }
      } else {
        await expect(attempt()).rejects.toThrow(
          scenario === "stale"
            ? "Turn job lease is no longer current"
            : "Queued wake does not match the claimed turn job.",
        );
      }
      expect(preparations).toBe(0);
      expect(await read()).toEqual({
        status: "stopped",
        lifecycle_generation: String(before),
        generation: String(before),
        intent: false,
      });
    }
  });
});

test("an already enrolled uncertain resume reconciles on a fresh server without another activation or ticket", async () => {
  const f = await stopped();
  try {
    let activations = 0;
    const request = input(f.row.id);
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        activations++;
        f.deliverPromptEventsBeforeReply();
        return f.reboot(restore);
      },
      async checkDispatchCoverage() {},
      async stop() {
        throw Error("Live enrolled uncertainty must remain reconcilable");
      },
    }));
    await f.db.exec(
      "alter table sandbox_transitions add constraint test_reject_settlement check (code <> 'runtime_turn_settled') not valid",
    );
    try {
      await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
      expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.status).toBe("starting");
      expect(
        (
          await f.db.query(
            `select 1 from sandbox_transitions
             where sandbox_id=$1 and from_status='starting' and to_status='running'`,
            [f.row.id],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await f.db.exec("alter table sandbox_transitions drop constraint test_reject_settlement");
    }
    const recover = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge);
    await f.db.query("update sandboxes set activity_until='infinity' where id=$1", [f.row.id]);
    await expect(
      recover(f.caller, request, {
        async canDispatch(tx) {
          const { rows } = await (tx ?? f.sql).query(
            "select id from public.sandboxes where id=$1 and activity_until='infinity'",
            [f.row.id],
          );
          return rows.length === 1;
        },
        async handoffGeneration() {
          throw new Error("An existing resume intent never advances the generation.");
        },
      }),
    ).rejects.toThrow("Queued runtime turn lease is no longer current.");
    expect(
      (await f.db.query("select activity_until='infinity' as preserved from sandboxes where id=$1", [f.row.id])).rows,
    ).toEqual([{ preserved: true }]);
    const recovered = await recover(f.caller, request);
    expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.status).toBe("ready");
    expect(recovered.runtime.epoch).toBe("2");
    expect(activations).toBe(1);
    expect(f.starts).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("a wake that loses its activity lease after prompt acceptance cannot publish", async () => {
  const f = await stopped();
  try {
    const request = input(f.row.id);
    const replacementLease = crypto.randomUUID();
    const bridge: typeof f.bridge = {
      ...f.bridge,
      async call(...args) {
        const reply = await f.bridge.call(...args);
        if (args[1].op === "prompt") {
          await f.db.query("update sandboxes set activity_lease_id=$2 where id=$1", [f.row.id, replacementLease]);
        }
        return reply;
      },
    };
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, bridge, async () => ({
      start: async (_signal, restore) => f.reboot(restore),
      async checkDispatchCoverage() {},
      async stop() {
        throw Error("The stale wake no longer owns the sandbox");
      },
    }));
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await f.db.query(
          `select s.status,s.task_prompt_id,s.activity_lease_id,r.receipt,
             exists(select 1 from runtime_commands c where c.sandbox_id=s.id
               and c.request_id='resume_'||r.request_id::text and c.accepted_prompt_id is not null) as accepted,
             exists(select 1 from sandbox_transitions t where t.sandbox_id=s.id
               and t.from_status='starting' and t.to_status='running') as journaled
           from sandboxes s join runtime_resumes r on r.sandbox_id=s.id
           where s.id=$1 and r.request_id=$2`,
          [f.row.id, request.request_id],
        )
      ).rows,
    ).toEqual([
      {
        status: "starting",
        task_prompt_id: null,
        activity_lease_id: replacementLease,
        receipt: null,
        accepted: true,
        journaled: false,
      },
    ]);
  } finally {
    await f.close();
  }
});

describe.each(["missing-proof", "prefix", "taint", "account", "owner", "expired"] as const)(
  "unsafe resume (%s)",
  (mode) => {
    // Building the stopped checkpoint is a prerequisite, not refusal work: under a
    // contended CI shard it alone exceeded the 5s test budget (#2592). The refusal
    // itself and every assertion stay inside the timed test.
    const fixture = scopedRuntimeFixture(() => stopped(), { timeout: 20_000 });

    test(`resume refuses unsafe state before preparing or activating compute (${mode})`, async () => {
      const f = await fixture();
      let calls = 0;
      if (mode === "missing-proof") await f.db.query("delete from runtime_checkpoints where sandbox_id=$1", [f.row.id]);
      if (mode === "prefix")
        await f.db.query("update runtime_checkpoints set watermark=watermark+1 where sandbox_id=$1", [f.row.id]);
      if (mode === "taint")
        await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.row.id]);
      if (mode === "expired")
        await f.db.query("update sandboxes set expires_at=now()-interval '1 minute' where id=$1", [f.row.id]);
      if (mode === "account") await f.db.query("update credentials set status='revoked' where id=$1", [f.account.id]);
      const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => {
        calls++;
        throw Error("Must not resolve management/model credentials");
      });
      await expect(
        resume(mode === "owner" ? { ...f.caller, userId: f.people.admin } : f.caller, input(f.row.id)),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(f.starts).toHaveLength(1);
    });
  },
);

test("activation uncertainty never dispatches again under another key or on retry", async () => {
  const f = await stopped();
  try {
    let starts = 0,
      stops = 0;
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start() {
        starts++;
        throw Error("unknown provider outcome");
      },
      async stop() {
        stops++;
      },
    }));
    const request = input(f.row.id);
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    await expect(resume(f.caller, input(f.row.id))).rejects.toThrow();
    expect(starts).toBe(1);
    expect(stops).toBe(0);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an unenrolled Boat resume returns to a confirmed retained stop before another request can resume", async () => {
  const f = await stopped();
  try {
    const callerStore = createSqlData(f.sql)(f.caller).sandboxes;
    let starts = 0;
    let refusedTicket = "";
    let refusalStatus: number | undefined;
    let requestSideStops = 0;
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        starts++;
        if (starts > 1) return f.reboot(restore);
        refusedTicket = (
          await f.authority.issue({
            sandboxId: f.row.id,
            ownerId: f.caller.userId,
            configuration: {},
          })
        ).enrolmentToken;
        const response = await f.authority.route(
          new Request("https://armada.example/api/runtime/enrol", {
            method: "POST",
            headers: { authorization: `Bearer ${refusedTicket}`, "x-armada-runtime-protocol": "0" },
          }),
        );
        refusalStatus = response?.status;
        throw Error("runtime_protocol_unsupported");
      },
      async checkDispatchCoverage() {},
      async stop() {
        requestSideStops++;
      },
    }));
    const first = input(f.row.id);
    await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
    expect(refusalStatus).toBe(409);
    expect(requestSideStops).toBe(0);
    expect((await callerStore.get(f.row.id))?.status).toBe("stopping");
    await expect(f.authority.enrol(refusedTicket)).rejects.toThrow("runtime_enrolment_denied");
    await expect(resume(f.caller, input(f.row.id))).rejects.toMatchObject({ code: "conflict" });

    const legacyDue = await f.db.query("select id from sandboxes where id=$1 and reconcile_after<=now()", [f.row.id]);
    expect(legacyDue.rows).toHaveLength(0);
    const worker = createSandboxLifecycle(f.sql, async () => {
      throw Error("Stop job owns provider I/O.");
    });
    expect(await worker.reconcileOne()).toBe(true);
    expect(await runBoatStop(f.sql, archivedBoat(false))).toBe("retry");
    expect((await callerStore.get(f.row.id))?.status).toBe("stopping");
    await expect(resume(f.caller, input(f.row.id))).rejects.toMatchObject({ code: "conflict" });
    await f.db.query("update jobs set run_after=now() where sandbox_id=$1 and kind='stop'", [f.row.id]);
    expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
    expect((await callerStore.get(f.row.id))?.status).toBe("stopped");
    await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
    expect((await resume(f.caller, input(f.row.id))).sourceCheckpoint.epoch).toBe(f.cp.runtime.epoch);
    expect(starts).toBe(2);
  } finally {
    await f.close();
  }
});

const observationErrors = new Map([
  ["transient observation failure", 503],
  ["unavailable observation without retry marker", 502],
  ["non-retryable observation conflict", 409],
]);

const inconclusiveObservationStates = new Map([
  ["unrecognized state", "unrecognized"],
  ["archive in progress", "archiving"],
  ["failed machine state without confirmed exit", "error"],
]);

const interruptedResumeProofs = [
  "activation receipt",
  "pending ticket",
  "observed archive",
  "observed running",
  ...observationErrors.keys(),
  "cancelled observation",
  ...inconclusiveObservationStates.keys(),
];

test.each(interruptedResumeProofs)(
  "the worker reconciles an interrupted Boat resume with %s evidence",
  async (proof) => {
    const f = await stopped();
    try {
      const first = input(f.row.id);
      let ticket: string | undefined;
      let started = false;
      const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
        async start(_signal, restore, confirmActivation) {
          if (started) return f.reboot(restore);
          started = true;
          if (proof === "activation receipt") await confirmActivation!();
          else if (proof === "pending ticket") {
            ticket = (await f.authority.issue({ sandboxId: f.row.id, ownerId: f.caller.userId, configuration: {} }))
              .enrolmentToken;
          }
          await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
          throw Error("Owner lost its lease before it could hand off");
        },
        async checkDispatchCoverage() {},
        async stop() {
          throw Error("The request has no cleanup authority");
        },
      }));
      await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
      const store = createSqlData(f.sql)(f.caller).sandboxes;
      expect((await store.get(f.row.id))?.status).toBe("starting");
      const running = { body: { sandbox: sdkSandbox({ id: f.row.providerSandboxId, state: "running" }) } };
      const cancelled = proof === "cancelled observation" ? new AbortController() : undefined;
      const interruption = Error("Lifecycle lane cancelled");
      const observationError = observationErrors.get(proof);
      const inconclusiveState = inconclusiveObservationStates.get(proof);
      const { provider, requests } = fakeBoat(
        ...(observationError ? [{ status: observationError }] : []),
        ...(inconclusiveState
          ? [{ body: { sandbox: sdkSandbox({ id: f.row.providerSandboxId, state: inconclusiveState }) } }]
          : []),
        ...(proof === "observed archive" || observationError || cancelled || inconclusiveState
          ? [{ body: { sandbox: retainedSandbox({ id: f.row.providerSandboxId, snapshotAvailable: false }) } }]
          : []),
        ...(proof === "observed running" ? [running, running, {}] : []),
        { body: { sandbox: retainedSandbox({ id: f.row.providerSandboxId }) } },
      );
      const worker = createSandboxLifecycle(f.sql, async () => ({
        ...provider,
        async get(id) {
          if (cancelled && !cancelled.signal.aborted) {
            cancelled.abort(interruption);
            throw interruption;
          }
          return provider.get(id);
        },
      }));
      if (cancelled) {
        const outcome = await worker.reconcileOne(cancelled.signal).catch((error) => error);
        expect((await store.get(f.row.id))?.status).toBe("starting");
        expect(outcome).toBe(interruption);
        expect(await worker.reconcileOne()).toBe(false);
        await f.db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [
          f.row.id,
        ]);
      }
      expect(await worker.reconcileOne()).toBe(true);
      if (observationError || inconclusiveState) {
        expect(requests.map(({ method }) => method)).toEqual(["GET"]);
        expect((await store.get(f.row.id))?.status).toBe("starting");
        expect(await worker.reconcileOne()).toBe(false);
        await f.db.query("update sandboxes set reconcile_after=now() where id=$1", [f.row.id]);
        expect(await worker.reconcileOne()).toBe(true);
      }
      expect((await store.get(f.row.id))?.status).toBe("stopping");
      if (proof === "observed running") expect(requests.map(({ method }) => method)).toEqual(["GET"]);
      if (ticket) await expect(f.authority.enrol(ticket)).rejects.toThrow("runtime_enrolment_denied");
      expect(await worker.reconcileOne()).toBe(true);
      expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
      expect((await store.get(f.row.id))?.status).toBe("stopped");
      await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
      expect((await resume(f.caller, input(f.row.id))).sourceCheckpoint.epoch).toBe(f.cp.runtime.epoch);
    } finally {
      await f.close();
    }
  },
);

test.each(["transition", "abandonment", "pre-commit"])(
  "an interrupted resume rolls back when %s fails",
  async (fault) => {
    const f = await stopped();
    try {
      const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
        async start() {
          await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
          throw Error("Request owner exited before activation");
        },
        async stop() {
          throw Error("Request owner has no cleanup authority");
        },
      }));
      await expect(resume(f.caller, input(f.row.id))).rejects.toMatchObject({ code: "conflict" });
      const store = createSqlData(f.sql)(f.caller).sandboxes;
      expect((await store.get(f.row.id))?.status).toBe("starting");

      const archive = { id: f.row.providerSandboxId, snapshotAvailable: false };
      const { provider, requests } = fakeBoat(
        { body: { sandbox: retainedSandbox(archive) } },
        { body: { sandbox: retainedSandbox(archive) } },
        { body: { sandbox: retainedSandbox({ ...archive, snapshotAvailable: true }) } },
      );
      const rollback = Error("Injected handoff rollback");
      let injectFault = true;
      const faultSql = bunLikeSql(f.db, (statement) => {
        const isFaultPoint =
          (fault === "transition" && statement.includes("from public.sandbox_transition(")) ||
          (fault === "abandonment" && statement.startsWith("update public.runtime_resumes set phase='abandoned'"));
        if (injectFault && isFaultPoint) {
          injectFault = false;
          throw rollback;
        }
      });
      const workerSql: typeof f.sql = {
        ...faultSql,
        transaction: (work) =>
          faultSql.transaction!(async (tx) => {
            const result = await work(tx);
            if (injectFault && fault === "pre-commit" && result === true) {
              injectFault = false;
              throw rollback;
            }
            return result;
          }),
      };
      const readHandoff = async () =>
        (
          await f.db.query<{ phase: string; generation: number; stop_generation: number; edges: number }>(
            `select r.phase, s.lifecycle_generation::int as generation, s.stop_generation::int as stop_generation,
            (select count(*)::int from public.sandbox_transitions t where t.sandbox_id=s.id
              and t.from_status='starting' and t.to_status='stopping'
              and t.actor='runtime_resume' and t.code='runtime_resume_unenrolled') as edges
           from public.runtime_resumes r join public.sandboxes s on s.id=r.sandbox_id where s.id=$1`,
            [f.row.id],
          )
        ).rows[0];
      const before = await readHandoff();
      if (!before) throw Error("Missing dispatched resume.");
      expect(before).toMatchObject({ phase: "dispatched", edges: 0 });
      const worker = createSandboxLifecycle(workerSql, async () => provider);

      await expect(worker.reconcileOne()).rejects.toBe(rollback);
      expect(await readHandoff()).toEqual(before);
      expect((await store.get(f.row.id))?.status).toBe("starting");
      expect(await worker.reconcileOne()).toBe(false);

      await f.db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [f.row.id]);
      expect(await worker.reconcileOne()).toBe(true);
      expect((await store.get(f.row.id))?.status).toBe("stopping");
      expect(await readHandoff()).toEqual({
        phase: "abandoned",
        generation: before.generation + 1,
        stop_generation: before.stop_generation + 1,
        edges: 1,
      });

      expect(await worker.reconcileOne()).toBe(true);
      expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
      expect((await store.get(f.row.id))?.status).toBe("stopped");
      expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    } finally {
      await f.close();
    }
  },
);

test.each(["expired reconcile lease", "removed owner membership"])(
  "interrupted resume stop cannot commit with %s",
  async (conflict) => {
    const f = await stopped();
    try {
      const lease = crypto.randomUUID();
      const {
        rows: [starting],
      } = await f.db.query<{ generation: number }>(
        `update public.sandboxes set status='starting', stopped_at=null,
         activity_lease_id=$2, activity_until=now()-interval '1 minute',
         reconcile_lease=$2, reconcile_lease_until=now()+$3::interval
       where id=$1 returning lifecycle_generation::int as generation`,
        [f.row.id, lease, conflict === "expired reconcile lease" ? "-1 minute" : "1 minute"],
      );
      if (!starting) throw Error("Missing starting sandbox.");
      if (conflict === "removed owner membership") {
        const removed = await f.db.query(
          `delete from public.members m using public.sandboxes s
           where s.id=$1 and m.org_id=s.org_id and m.user_id=s.owner_id returning m.user_id`,
          [f.row.id],
        );
        expect(removed.rows).toEqual([{ user_id: f.caller.userId }]);
      }
      expect(
        await transitionSandbox(f.sql, {
          sandboxId: f.row.id,
          expectedGeneration: starting.generation,
          fromStates: ["starting"],
          toState: "stopping",
          actor: "runtime_resume",
          code: "runtime_resume_unenrolled",
          effects: [],
          settlement: { lease, statusReason: null, stopRequestedAt: null, stoppedAt: null },
        }),
      ).toEqual({ kind: "conflict" });
      expect(
        (
          await f.db.query("select status, lifecycle_generation::int as generation from public.sandboxes where id=$1", [
            f.row.id,
          ])
        ).rows[0],
      ).toEqual({ status: "starting", generation: starting.generation });
    } finally {
      await f.close();
    }
  },
);

test("failed GitHub reauthorization prevents resumed inference and can reconcile without reactivation", async () => {
  const f = await stopped();
  try {
    let activations = 0,
      attempts = 0;
    const resume = createRuntimeResume(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
      async () => ({
        async start(_signal, restore) {
          activations++;
          return f.reboot(restore);
        },
        async checkDispatchCoverage() {},
        async stop() {},
      }),
      undefined,
      async () => {
        attempts++;
        if (attempts === 1) throw Error("GitHub preparation failed");
        return { status: "connected" as const, login: "owner" };
      },
    );
    const request = input(f.row.id);
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts).toHaveLength(1);
    expect((await resume(f.caller, request)).resumed).toBe(true);
    expect(activations).toBe(1);
    expect(attempts).toBe(2);
    expect(f.starts).toHaveLength(2);
    await resume(f.caller, request);
    expect(attempts).toBe(2);
  } finally {
    await f.close();
  }
});

test("an old runtime without verified restore health cannot receive a resumed prompt", async () => {
  const f = await stopped();
  try {
    let activations = 0;
    const request = input(f.row.id);
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        activations++;
        return f.reboot(restore, false);
      },
      async stop() {},
    }));
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(activations).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

function interceptBoatResume(reply: (url: string) => Response | Promise<Response>) {
  const requests: string[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation((async (value: Parameters<typeof fetch>[0]) => {
    const url = String(value instanceof Request ? value.url : value);
    requests.push(url);
    return reply(url);
  }) as typeof fetch);
  return { requests, restore: () => network.mockRestore() };
}

test("Boat refuses a new resume prompt when its physical deadline shortens after enrolment", async () => {
  const f = await stopped();
  const logicalDeadline = new Date("2099-01-01T00:00:00Z");
  const coveringDeadline = new Date(logicalDeadline.getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000);
  let restored = false;
  let enrolled = false;
  let postEnrolmentChecks = 0;
  let activations = 0;
  const { restore } = interceptBoatResume((url) => {
    if (url.endsWith("/resume")) {
      restored = true;
      activations++;
    } else if (enrolled) postEnrolmentChecks++;
    return Response.json({
      ok: true,
      sandbox: restored
        ? sdkSandbox({
            id: "physical",
            state: "running",
            archiveAfter: (enrolled ? logicalDeadline : coveringDeadline).toISOString(),
          })
        : retainedSandbox({ id: "physical", snapshotAvailable: true }),
    });
  });
  try {
    await f.db.query("update sandboxes set expires_at=$2 where id=$1", [f.row.id, logicalDeadline.toISOString()]);
    const prepare = boatRuntimeResume({
      sql: f.sql,
      vault: createSqlVaultStore(f.sql),
      key: ENCRYPTION_KEY,
      modelAuth: createModelAuthOwnership(f.sql, ENCRYPTION_KEY),
      policy: {
        async start(value) {
          await value.activate?.(value.signal);
          const ready = await f.reboot(value.restoreCheckpoint!);
          enrolled = true;
          return {
            ...ready,
            prompt: async () => {
              throw Error("Resume must dispatch through the enrolled command bridge");
            },
          };
        },
      },
    });
    const request = input(f.row.id);
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, prepare);
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(postEnrolmentChecks).toBe(1);
    const withoutBoatPolicy = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge);
    await expect(withoutBoatPolicy(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(postEnrolmentChecks).toBe(2);
    expect(activations).toBe(1);
    expect(await f.bridge.result(f.caller.userId, f.row.id, `resume_${request.request_id}`, "2")).toEqual({
      state: "missing",
    });
  } finally {
    restore();
    await f.close();
  }
});

const boatResumeRecoveryCases = [
  "confirmed",
  "tainted",
  "lease expired",
  "archive unverified",
  "short coverage",
  "missing coverage",
  "coverage lease lost",
  "ticket write failure",
  "response lost",
  "handoff rollback",
  "transition fault",
  "phase fault",
  "commit fault",
];

test.each(boatResumeRecoveryCases)(
  "Boat resume activation and recovery respect retained disk and lease authority (%s)",
  async (condition) => {
    const taint = condition === "tainted";
    const expired = condition === "lease expired";
    const unverified = condition === "archive unverified";
    const rollbackHandoff = condition === "handoff rollback";
    const fault = condition.endsWith(" fault");
    const responseLost = condition === "response lost" || rollbackHandoff;
    const f = await stopped();
    const shortCoverage = condition === "short coverage";
    const missingCoverage = condition === "missing coverage";
    const coverageLeaseLost = condition === "coverage lease lost";
    const ticketWriteFailure = condition === "ticket write failure";
    let attemptedTicketWrite = false;
    const authority = ticketWriteFailure
      ? createRuntimeEnrolments(
          bunLikeSql(f.db, (statement) => {
            if (!statement.startsWith("insert into public.runtime_enrolments as r")) return;
            attemptedTicketWrite = true;
            throw Error("Injected ticket write failure");
          }),
          ENCRYPTION_KEY,
        )
      : f.authority;
    const unsafeCoverage = shortCoverage || missingCoverage;
    const logicalDeadline = new Date("2099-01-01T00:00:00Z");
    const physicalDeadline = new Date(logicalDeadline.getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000);
    let activated = false;
    let activeReads = 0;
    let canIssueTicket = false;
    let beforeFailure: { generation: number; stop_generation: number } | undefined;
    const { requests, restore } = interceptBoatResume(async (url) => {
      if (url.endsWith("/resume")) {
        activated = true;
        if (responseLost) return new Response(null, { status: 504 });
        if (expired)
          await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
      }
      if (url.endsWith("/stop")) activated = false;
      const afterRestore = activated && !url.endsWith("/resume") && ++activeReads > 1;
      if (afterRestore && coverageLeaseLost)
        await f.db.query(
          `update sandboxes set activity_until='-infinity',
             reconcile_lease=$2,reconcile_lease_until='infinity' where id=$1`,
          [f.row.id, crypto.randomUUID()],
        );
      return Response.json({
        ok: true,
        sandbox: activated
          ? sdkSandbox({
              id: "physical",
              state: "running",
              archiveAfter:
                afterRestore && missingCoverage
                  ? undefined
                  : new Date(physicalDeadline.getTime() - (afterRestore && shortCoverage ? 1_000 : 0)).toISOString(),
            })
          : retainedSandbox({ id: "physical", snapshotAvailable: !unverified }),
      });
    });
    try {
      await f.db.query("update sandboxes set expires_at=$2 where id=$1", [f.row.id, logicalDeadline.toISOString()]);
      const prepare = boatRuntimeResume({
        sql: f.sql,
        vault: createSqlVaultStore(f.sql),
        key: ENCRYPTION_KEY,
        modelAuth: createModelAuthOwnership(f.sql, ENCRYPTION_KEY),
        policy: {
          async start(value) {
            if (taint) {
              const { rows } = await f.db.query<{ generation: number; stop_generation: number }>(
                `update public.sandboxes
                 set application_secret_tainted=true,reconcile_after='infinity'::timestamptz where id=$1
                 returning lifecycle_generation::int as generation, stop_generation::int`,
                [f.row.id],
              );
              beforeFailure = rows[0];
            }
            await value.activate?.(value.signal);
            if (condition === "confirmed" || coverageLeaseLost || ticketWriteFailure) {
              await authority.issue({
                sandboxId: value.sandbox.id,
                ownerId: f.caller.userId,
                configuration: {},
                expectedProviderSandboxId: value.sandbox.providerSandboxId,
                expectedGeneration: value.sandbox.lifecycleGeneration!,
                ...(value.ticketGuard ? { ticketGuard: value.ticketGuard } : {}),
              });
            }
            canIssueTicket = true;
            throw Error("Fixture ends before ticket issuance");
          },
        },
      });
      let handoffRolledBack = false;
      const faultSql = bunLikeSql(f.db, (statement) => {
        if (
          (condition === "transition fault" &&
            canIssueTicket &&
            statement.includes("from public.sandbox_transition(")) ||
          (condition === "phase fault" && statement.startsWith("update public.runtime_resumes set phase=$3"))
        ) {
          handoffRolledBack = true;
          throw Error("Injected request handoff rollback");
        }
      });
      const requestSql: typeof f.sql =
        rollbackHandoff || fault
          ? {
              ...f.sql,
              transaction: (work) =>
                faultSql.transaction!(async (tx) => {
                  const result = await work(tx);
                  if (
                    (rollbackHandoff && result === undefined) ||
                    (condition === "commit fault" && result === "stopping")
                  ) {
                    handoffRolledBack = true;
                    throw Error("Injected request handoff rollback");
                  }
                  return result;
                }),
            }
          : f.sql;
      const request = input(f.row.id);
      await expect(
        createRuntimeResume(requestSql, ENCRYPTION_KEY, f.bridge, prepare)(f.caller, request),
      ).rejects.toThrow();
      const observation = await f.db.query(
        `select observed_provider_id, observed_generation::int, observed_expires_at
         from public.boat_runtime_extension_state where sandbox_id=$1`,
        [f.row.id],
      );
      expect(observation.rows).toEqual(
        condition === "confirmed"
          ? [{ observed_provider_id: "physical", observed_generation: 2, observed_expires_at: physicalDeadline }]
          : [],
      );
      expect(attemptedTicketWrite).toBe(ticketWriteFailure);
      expect(handoffRolledBack).toBe(rollbackHandoff || fault);
      expect(canIssueTicket).toBe(
        !taint &&
          !expired &&
          !unverified &&
          !responseLost &&
          !unsafeCoverage &&
          !coverageLeaseLost &&
          !ticketWriteFailure,
      );
      const { rows } = await f.db.query(
        `select l.stage, case when l.stage='accepted' then l.at=r.created_at else l.at>=r.created_at end as dated_correctly
           from public.sandbox_launch_stages l
           join public.runtime_resumes r on r.sandbox_id=l.sandbox_id and r.request_id=$2
          where l.sandbox_id=$1 and l.activation=2 order by l.stage`,
        [f.row.id, request.request_id],
      );
      expect(rows).toEqual([
        { stage: "accepted", dated_correctly: true },
        ...(taint || unverified || responseLost
          ? []
          : [
              ...(expired || unsafeCoverage ? [] : [{ stage: "machine_started", dated_correctly: true }]),
              { stage: "provider_claimed", dated_correctly: true },
            ]),
      ]);
      expect(requests.some((path) => path.endsWith("/resume"))).toBe(!taint && !unverified);
      const store = createSqlData(f.sql)(f.caller).sandboxes;
      expect((await store.get(f.row.id))?.status).toBe(
        taint ? "failed" : expired || responseLost || fault || coverageLeaseLost ? "starting" : "stopping",
      );
      const expectedEdge = taint
        ? { to_status: "failed", code: "restore_unconfirmed", phase: "failed" }
        : { to_status: "stopping", code: "runtime_resume_unenrolled", phase: "abandoned" };
      const result = await f.db.query(
        `select t.to_status, t.code, r.phase
           from public.runtime_resumes r
           left join public.sandbox_transitions t on t.sandbox_id=r.sandbox_id
             and t.actor='runtime_resume' and t.from_status='starting'
          where r.sandbox_id=$1 and r.request_id=$2`,
        [f.row.id, request.request_id],
      );
      expect(result.rows).toEqual(
        expired || responseLost || fault || coverageLeaseLost
          ? [{ to_status: null, code: null, phase: "dispatched" }]
          : [expectedEdge],
      );
      if (taint) {
        if (!beforeFailure) throw Error("Missing admitted resume fence.");
        const { rows } = await f.db.query(
          `select s.lifecycle_generation::int as generation, s.stop_generation::int,
                  t.generation::int as journal_generation,
                  s.stop_requested_at is not null and s.reconcile_after <= now() as cleanup_due,
                  s.activity_lease_id is null and s.activity_until is null as activity_released
             from public.sandboxes s
             join public.sandbox_transitions t on t.sandbox_id=s.id and t.code='restore_unconfirmed'
            where s.id=$1`,
          [f.row.id],
        );
        expect(rows).toEqual([
          {
            generation: beforeFailure.generation + 1,
            stop_generation: beforeFailure.stop_generation + 1,
            journal_generation: beforeFailure.generation + 1,
            cleanup_due: true,
            activity_released: true,
          },
        ]);
      }
      if (!taint) expect(requests.some((path) => path.endsWith("/stop"))).toBe(false);
      if (responseLost) {
        const running = { body: { sandbox: sdkSandbox({ id: f.row.providerSandboxId, state: "running" }) } };
        const archive = { body: { sandbox: retainedSandbox({ id: f.row.providerSandboxId }) } };
        const starting = {
          body: { sandbox: sdkSandbox({ id: f.row.providerSandboxId, state: "provisioning" }) },
        };
        const { provider, requests: observations } = fakeBoat(starting, running, running, {}, archive);
        const worker = createSandboxLifecycle(f.sql, async () => provider);
        if (rollbackHandoff) {
          expect(await worker.reconcileOne()).toBe(false);
          await f.db.query(
            "update sandboxes set activity_until=now()-interval '1 second',reconcile_after=now() where id=$1",
            [f.row.id],
          );
        }
        expect(await worker.reconcileOne()).toBe(true);
        expect((await store.get(f.row.id))?.status).toBe("starting");
        expect(observations.map(({ method }) => method)).toEqual(["GET"]);
        expect(await worker.reconcileOne()).toBe(false);
        await f.db.query("update sandboxes set reconcile_after=now() where id=$1", [f.row.id]);
        expect(await worker.reconcileOne()).toBe(true);
        expect((await store.get(f.row.id))?.status).toBe("stopping");
        expect(await worker.reconcileOne()).toBe(true);
        expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
        expect((await store.get(f.row.id))?.status).toBe("stopped");
        await expect(
          createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, prepare)(f.caller, request),
        ).rejects.toThrow();
        expect(
          (
            await createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
              start: (_signal, restore) => f.reboot(restore),
              async checkDispatchCoverage() {},
              stop: async () => {},
            }))(f.caller, input(f.row.id))
          ).sourceCheckpoint.epoch,
        ).toBe(f.cp.runtime.epoch);
      }
      if (condition === "confirmed" || unverified) {
        const { provider } = fakeBoat({
          body: { sandbox: retainedSandbox({ id: f.row.providerSandboxId }) },
        });
        const worker = createSandboxLifecycle(f.sql, async () => provider);
        expect(await worker.reconcileOne()).toBe(true);
        expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
        expect((await store.get(f.row.id))?.status).toBe("stopped");
        await expect(
          createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
            start: (_signal, restore) => f.reboot(restore),
            async checkDispatchCoverage() {},
            stop: async () => {},
          }))(f.caller, input(f.row.id)),
        ).resolves.toMatchObject({
          sourceCheckpoint: { epoch: f.cp.runtime.epoch },
        });
      }
    } finally {
      restore();
      await f.close();
    }
  },
);

async function scopedAccessFor(f: Awaited<ReturnType<typeof stopped>>) {
  await f.db.query("update sandboxes set visibility='private',access_owner_id=owner_id where id=$1", [f.row.id]);
  await f.db.query(
    `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,golden_ids,credential_ids)
     values($1,'sandbox',$2,$3,$1,'ready',array[$4::uuid],array[$5::uuid])`,
    [f.row.id, f.people.org, f.people.owner, f.row.goldenId, f.account.id],
  );
  return createSandboxArmadaAccess({
    sql: f.sql,
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: PUBLIC_URL,
    commands: f.bridge,
  });
}

async function acknowledgedScopedGrant(tx: Sql, sandboxId: string) {
  const { rows } = await tx.query(
    `select 1 from orchestrator_delegations d join armada_access_parents p on p.id=d.orchestrator_id
     where p.id=$1 and d.epoch=p.authority_epoch and d.acknowledged_at is not null and d.revoked_at is null`,
    [sandboxId],
  );
  return rows.length > 0;
}

describe.each([
  ["boat", "codex"],
  ["boat", "claude"],
] as readonly ["boat" | "modal", Harness][])("empty retained runtime wake (%s/%s)", (provider, harness) => {
  const fixture = scopedRuntimeFixture(() => stopped(harness, provider, true));
  test("one fresh-epoch first conversation survives replay without inventing native history", async () => {
    const f = await fixture();
    expect(f.starts).toEqual([]);
    const scoped = provider === "modal" && harness === "codex";
    const authority = new DelegatedAuthority(f.sql, async () => {});
    const access = scoped ? await scopedAccessFor(f) : undefined;
    const admit = (turn: number) => {
      const server = f.mcpSnapshots[turn]?.servers.armada_orchestrator;
      const bearer = server?.type === "http" ? server.headers?.Authorization : undefined;
      return authority.admit(
        bearer?.slice("Bearer ".length) ?? "",
        {
          method: "launch",
          goldenId: f.row.goldenId,
          harness: "codex",
          credentialId: f.account.id,
          credentialVersion: f.account.version,
        },
        async (_tx, principal) => principal.ownerId,
      );
    };
    const old = f.active;
    let activations = 0,
      github = 0,
      mcp = 0;
    const resume = createRuntimeResume(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
      async () => ({
        async start(_signal, restore) {
          expect(restore.conversationId).toBeNull();
          activations++;
          return f.reboot(restore);
        },
        async checkDispatchCoverage() {},
        async stop() {
          throw Error("No healthy activation cleanup");
        },
      }),
      async () => {
        mcp++;
        return undefined;
      },
      async () => {
        github++;
        return { status: "not_connected", message: "offline" };
      },
      access?.restoreEnrolled,
    );
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, resume, access?.restoreEnrolled);
    const request = f.input("first instruction after empty stop");
    const accepted = await send(f.caller, request);
    expect(accepted).toMatchObject({
      resumed: true,
      runtime: { kind: "armada", epoch: "2" },
      sourceCheckpoint: { epoch: "1", watermark: f.cp.checkpoint.watermark, empty: true },
    });
    expect(f.starts).toEqual([undefined]);
    if (scoped) await expect(admit(0)).resolves.toBe(f.people.owner);
    expect(activations).toBe(1);
    expect(mcp).toBe(1);
    expect(github).toBe(1);
    await expect(f.authority.withSession(old.runtimeToken, old.epoch, async () => true)).rejects.toThrow();
    expect(await send(f.caller, request)).toEqual(accepted);
    expect(activations).toBe(1);
    expect(f.starts).toHaveLength(1);
    await expect(send(f.caller, { ...request, prompt: "changed" })).rejects.toThrow();
    const followUp = f.input("follow up");
    if (scoped) {
      await authority.revoke(f.row.id);
      await expect(
        send(f.caller, followUp, {
          canDispatch: async (tx) => !tx || !(await acknowledgedScopedGrant(tx, f.row.id)),
          handoffGeneration: () => Promise.reject(Error("Running follow-up does not advance generation.")),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await acknowledgedScopedGrant(f.sql, f.row.id)).toBe(false);
    }
    const next = await send(f.caller, followUp);
    if (scoped) {
      await expect(admit(0)).rejects.toThrow("denied");
      await expect(admit(1)).resolves.toBe(f.people.owner);
      await send(f.caller, f.input("reuse the current grant"));
      await expect(admit(1)).resolves.toBe(f.people.owner);
    }
    expect(next.conversationId).toBe(accepted.conversationId);
    expect(f.starts).toEqual(scoped ? [undefined, "native-thread", "native-thread"] : [undefined, "native-thread"]);
    expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.conversationIds).toEqual([
      accepted.conversationId,
    ]);
  });
});

describe("Modal resume job", () => {
  const fixture = scopedRuntimeFixture(() => stopped("codex", "modal"), { perTest: true });
  test.each([false, true])("reconciles a lost allocation response (deadline ended=%s)", async (expired) => {
    const f = await fixture();
    const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
    const firstGeneration = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!.lifecycleGeneration!;
    let allocated = false;
    let allocations = 0;
    let bootstraps = 0;
    let ticketToken: string | undefined;
    const restore = {
      epoch: f.cp.runtime.epoch,
      watermark: f.cp.checkpoint.watermark,
      conversationId: f.first.conversationId!,
    };
    const turns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
    const service = createResumeJob({
      turns,
      sql: f.sql,
      key: ENCRYPTION_KEY,
      commands: f.bridge,
      async provider() {
        return {
          async get() {
            return { state: "ready", expiresAt: new Date(Date.now() + 86_400_000) };
          },
          async runtimeResumeMachine({ sandboxId, generation, checkpoint, ticket }) {
            expect(checkpoint).toMatchObject(restore);
            return {
              predecessor: { sandboxId, generation: generation - 1, kind: "image", ref: "retained" },
              async resume() {
                if (!allocated) {
                  allocated = true;
                  allocations++;
                  throw Error("Allocation reply lost");
                }
                return { sandboxId, generation, machineId: "replacement" };
              },
              async bootstrap(request) {
                const descriptor = await ticket(request);
                expect(descriptor?.artifact).toEqual({ sha256: "b".repeat(64), bytes: 5 });
                ticketToken = descriptor?.enrolmentToken;
                bootstraps++;
              },
            };
          },
        } as Pick<
          import("@armada/provider-modal").ModalProvider,
          "runtimeResumeMachine"
        > as import("@armada/provider-modal").ModalProvider;
      },
      async prepare() {
        return {
          serverUrl: PUBLIC_URL,
          artifact: { sha256: "b".repeat(64), bytes: 5 },
          cacheDir: "/tmp/runtime",
          configuration: {},
        };
      },
      async prepareMcp() {
        return undefined;
      },
      async restoreScopedAccess() {},
    });
    const explicit = createRuntimeResume(
      f.sql,
      ENCRYPTION_KEY,
      f.bridge,
      undefined,
      undefined,
      undefined,
      undefined,
      service.resume,
    );
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, explicit, undefined, service.wake);
    turns.setDispatch(
      createQueuedSandboxDispatch({
        authStore: createMemoryAuthStore(),
        supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(f.sql),
        providers: {
          async resolve() {
            throw Error("Queued Modal resume must not resolve directly.");
          },
        },
        runtimeSend: send,
      }),
    );
    const request = input(f.row.id);
    const joined = input(f.row.id);
    const wake = Promise.withResolvers<void>();
    const unsubscribe = runtimeWakes.subscribe(JOBS_WAKE, wake.resolve);
    try {
      expect(await turns.accept(f.caller, request)).toMatchObject({ status: "queued" });
      expect(await turns.reconcileOne(new AbortController().signal)).toBe(true);
      await wake.promise;
      const receipt = explicit(f.caller, request).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (!expired)
        expect(await turns.accept(f.caller, joined, { resumeOnly: true })).toMatchObject({ status: "queued" });
      const owner = crypto.randomUUID();
      const take = async () => {
        const job = (await jobs.claim("resume", owner, 30, 8))!;
        expect(job.generation).toBe(String(firstGeneration + 1));
        const result = await service.handler.run(job, {
          signal: new AbortController().signal,
          canDispatch: async (tx) => (await jobs.inspect(job, owner, tx)) === "dispatch",
          async handoffGeneration() {
            throw Error("Resume already owns the target generation");
          },
        });
        expect(await jobs.complete(job, owner, result)).toBeTrue();
        return result.status;
      };
      expect(await take()).toBe("retry");
      await f.sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
      if (expired) {
        await f.sql.query("update public.jobs set deadline_at=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
        expect(await take()).toBe("fail");
        expect(await receipt).toMatchObject({ error: { code: "conflict" } });
        await turns.drain();
        expect((await jobs.claim("stop", owner, 30, 8))?.generation).toBe(String(firstGeneration + 1));
        expect(f.starts).toEqual([undefined]);
        return;
      }
      expect(await take()).toBe("retry");
      expect(ticketToken).toBeDefined();
      await f.reboot(restore, true, ticketToken);
      await f.sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
      expect(await take()).toBe("done");
      expect(f.starts).toEqual([undefined]);
      await turns.drain();
      f.lose();
      expect(await turns.reconcileOne(new AbortController().signal)).toBe(true);
      await turns.drain();
      await f.sql.query("update public.jobs set deadline_at=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
      expect(await turns.reconcileOne(new AbortController().signal)).toBe(true);
      await turns.drain();
      const accepted = await receipt;
      if (!("value" in accepted)) throw accepted.error;
      expect(await turns.status(f.caller, request.id, request.request_id)).toMatchObject({
        nativePromptId: accepted.value.promptId,
      });
      expect(allocations).toBe(1);
      expect(bootstraps).toBe(1);
      expect(f.starts).toEqual([undefined, "native-thread"]);
      expect(
        (
          await f.sql.query("select state from public.account_turn_queue where sandbox_id=$1 and request_id=$2", [
            joined.id,
            joined.request_id,
          ])
        ).rows,
      ).toEqual([{ state: "queued" }]);
      const { rows } = await f.sql.query(
        "select generation::text from public.jobs where sandbox_id=$1 and kind='resume'",
        [f.row.id],
      );
      expect(rows).toEqual([{ generation: String(firstGeneration + 1) }]);
      await f.sql.query("update public.sandboxes set expires_at=now() where id=$1", [f.row.id]);
      expect(await turns.accept(f.caller, request)).toMatchObject({ promptId: accepted.value.promptId });
      expect(await explicit(f.caller, request)).toEqual(accepted.value);
    } finally {
      unsubscribe();
    }
  });
});
