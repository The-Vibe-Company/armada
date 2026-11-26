import { describe, expect, spyOn, test } from "bun:test";
import { createMemoryAuthStore, sha256Hex } from "@armada/auth";
import { createSqlVaultStore, type Harness, type Provider } from "@armada/core/server";
import { createTurnDispatchJob } from "../src/account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { createQueuedSandboxDispatch, dispatchControlCommand } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { createResumeJob } from "../src/jobs/resume.ts";
import { createJobsRunner } from "../src/jobs/runner.ts";
import { createJobsStore, JOBS_WAKE } from "../src/jobs/store.ts";
import { continueRequest } from "../src/request-observability.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { createRuntimeResume } from "../src/runtime-resume.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { runtimeWakes, SANDBOX_ADMISSION_WAKE } from "../src/wake-bus.ts";
import { archivedBoat, runBoatStop } from "./boat-stop.fixture.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { configureRuntimeFixture, runtimeFixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { runClaimedStop } from "./stop-job.fixture.ts";
import { ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

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
  const resume = createRuntimeResume(f.sql, async () => {
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
  const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, undefined, service.wake);
  await expect(send(f.caller, input(f.row.id), undefined, { fromQueue: true })).rejects.toMatchObject({
    code: "unavailable",
    message: "This harness cannot resume a stopped conversation.",
  });
  expect((await f.db.query("select 1 from jobs where sandbox_id=$1 and kind='resume'", [f.row.id])).rows).toEqual([]);
  expect((await f.db.query("select 1 from runtime_resumes where sandbox_id=$1", [f.row.id])).rows).toEqual([]);
});

describe.each(["boat", "modal"] as const)("historical %s resume receipt", (provider) => {
  const fixture = scopedRuntimeFixture(() => stopped("codex", provider), { perTest: true });
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
    const resume = createRuntimeResume(f.sql, async () => {
      throw Error("Historical receipts never admit another resume.");
    });
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

describe.each(["boat", "modal"] as const)("%s resume job", (placement) => {
  const fixture = scopedRuntimeFixture(() => stopped("codex", placement), { perTest: true });
  const scenarios =
    placement === "boat"
      ? (["recovered", "expired", "owner stop", "credential retry", "exhausted"] as const)
      : (["recovered", "expired", "exhausted"] as const);
  test.each([...scenarios])("reconciles resume across %s", async (scenario) => {
    const f = await fixture();
    const expired = scenario === "expired";
    if (scenario === "exhausted")
      await f.sql.query("update public.sandboxes set lifecycle_generation=$2::bigint where id=$1", [
        f.row.id,
        String(Number.MAX_SAFE_INTEGER - (placement === "boat" ? 1 : 0)),
      ]);

    const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
    const firstGeneration = (await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))!.lifecycleGeneration!;
    let allocated = false;
    let allocations = 0;
    let bootstraps = 0;
    let credentialFailure = scenario === "credential retry";
    let ticketToken: string | undefined;
    const restore = {
      epoch: f.cp.runtime.epoch,
      watermark: f.cp.checkpoint.watermark,
      conversationId: f.first.conversationId!,
    };
    const turns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
    const explicitAdmission = Promise.withResolvers<void>();
    const service = createResumeJob({
      turns: {
        ...turns,
        async accept(...args) {
          const result = await turns.accept(...args);
          explicitAdmission.resolve();
          return result;
        },
      },
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
      async boat() {
        return {
          host: {
            async get(id: string) {
              expect(id).toBe(f.row.providerSandboxId);
              return {
                id,
                name: "retained",
                labels: {},
                providerState: allocated ? "ready" : "archived",
                state: allocated ? ("ready" as const) : ("stopped" as const),
                retainedSnapshot: "usable" as const,
                expiresAt: new Date(Date.now() + 86_400_000),
              };
            },
            async resumeRuntime(id: string) {
              expect(id).toBe(f.row.providerSandboxId);
              allocated = true;
              allocations++;
              throw Error("Activation reply lost");
            },
          } as unknown as ReturnType<typeof import("../src/observed-boat.ts").createObservedBoatProvider>,
          providerAuthority: "fixture",
          async authorize() {
            if (credentialFailure) {
              credentialFailure = false;
              throw Error("Credential lookup was interrupted");
            }
          },
          async bootstrap(_host, descriptor) {
            expect(descriptor.sandboxId).toBe(f.row.providerSandboxId);
            expect(descriptor.artifact).toEqual({ sha256: "b".repeat(64), bytes: 5 });
            ticketToken = descriptor.enrolmentToken;
            bootstraps++;
          },
        };
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
    const explicit = createRuntimeResume(f.sql, service.resume);
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, undefined, service.wake);
    const turnRunner = createJobsRunner(jobs, {
      turn_dispatch: createTurnDispatchJob(
        f.sql,
        ENCRYPTION_KEY,
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
      ),
    });
    const request = input(f.row.id);
    const joined = input(f.row.id);
    const runTurn = async (requestId = request.request_id) => {
      await f.sql.query(
        `update public.jobs set run_after=case when idem_key::jsonb->>5=$2 then '-infinity'::timestamptz
           else 'infinity'::timestamptz end where sandbox_id=$1 and kind='turn_dispatch' and state='queued'`,
        [f.row.id, requestId],
      );
      expect(await turnRunner.reconcileOne(new AbortController().signal)).toBe(true);
      await turnRunner.drain();
    };
    const wake = Promise.withResolvers<void>();
    const unsubscribe = runtimeWakes.subscribe(JOBS_WAKE, wake.resolve);
    const toolFailures = spyOn(console, "error");
    try {
      const readReceipt = () =>
        explicit(f.caller, request).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      const explicitFirst = placement === "boat" && scenario === "recovered";
      const waiting = explicitFirst ? readReceipt() : undefined;
      if (waiting) {
        const admitted = await Promise.race([explicitAdmission.promise, waiting]);
        if (admitted) throw Error("The explicit request resolved before durable admission.");
      } else {
        expect(await turns.accept(f.caller, request)).toMatchObject({ status: "queued" });
      }
      await runTurn();
      if (!waiting && scenario !== "exhausted") {
        expect(toolFailures).not.toHaveBeenCalledWith(expect.stringContaining('"phase":"tool.send"'));
      }
      toolFailures.mockRestore();
      if (scenario === "exhausted") {
        expect(await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id)).toMatchObject({
          status: "stopped",
          lifecycleGeneration: firstGeneration,
        });
        expect(
          (await f.sql.query("select id from jobs where sandbox_id=$1 and kind='resume'", [f.row.id])).rows,
        ).toEqual([]);
        expect(allocations).toBe(0);
        return;
      }
      await wake.promise;
      const receipt = waiting ?? readReceipt();
      if (scenario === "recovered" || scenario === "credential retry")
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
      const expectLoggedRetry = async () => {
        const logs: string[] = [];
        expect(await continueRequest(crypto.randomUUID(), take, (line) => logs.push(line))).toBe("retry");
        expect(logs.map((line) => JSON.parse(line))).toMatchObject([
          {
            event: "operator_failure",
            phase: "jobs.resume.run",
            sandboxId: f.row.id,
            operationId: expect.any(String),
            code: "retry",
            message: "Exception message withheld",
          },
        ]);
      };
      if (scenario === "credential retry") {
        await expectLoggedRetry();
        expect(allocations).toBe(0);
        await f.sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
      }
      await expectLoggedRetry();
      await f.sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
      if (expired) {
        await f.sql.query("update public.jobs set deadline_at=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
        expect(await take()).toBe("fail");
        expect(await receipt).toMatchObject({ error: { code: "conflict" } });
        expect((await jobs.claim("stop", owner, 30, 8))?.generation).toBe(String(firstGeneration + 1));
        expect(f.starts).toEqual([undefined]);
        return;
      }
      expect(await take()).toBe("retry");
      expect(ticketToken).toBeDefined();
      await f.reboot(restore, true, ticketToken);
      if (scenario === "owner stop") {
        const sandboxes = createSqlData(f.sql)(f.caller).sandboxes;
        await sandboxes.update(f.row.id, {
          ownerStop: true,
          status: "stopping",
          stoppedAt: null,
          stopRequested: true,
          expectedGeneration: firstGeneration + 1,
          advanceGeneration: true,
          activityToken: crypto.randomUUID(),
        });
        runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
        expect(await receipt).toMatchObject({ error: { code: "conflict" } });
        await f.sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
        expect(await runBoatStop(f.sql, archivedBoat())).toBe("done");
        expect(await sandboxes.get(f.row.id)).toMatchObject({
          status: "stopped",
          lifecycleGeneration: firstGeneration + 2,
        });
        const next = input(f.row.id);
        expect(await turns.accept(f.caller, next)).toMatchObject({ status: "queued" });
        await runTurn(next.request_id);
        expect(await sandboxes.get(f.row.id)).toMatchObject({
          status: "starting",
          lifecycleGeneration: firstGeneration + 3,
        });
        expect(f.starts).toEqual([undefined]);
        return;
      }
      await f.sql.query("update public.jobs set run_after=now() where sandbox_id=$1 and kind='resume'", [f.row.id]);
      expect(await take()).toBe("done");
      expect(f.starts).toEqual([undefined]);
      f.lose();
      await runTurn();
      await f.sql.query(
        "update public.account_turn_queue set dispatch_until=now() where sandbox_id=$1 and request_id=$2 and state='dispatching'",
        [f.row.id, request.request_id],
      );
      await runTurn();
      expect(await turns.status(f.caller, request.id, request.request_id)).toHaveProperty("nativePromptId");
      const accepted = await receipt;
      if (!("value" in accepted)) throw accepted.error;
      expect(await turns.status(f.caller, request.id, request.request_id)).toMatchObject({
        nativePromptId: accepted.value.promptId,
      });
      if (placement === "boat") {
        expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.providerSandboxId).toBe(
          f.row.providerSandboxId,
        );
        expect(
          (
            await f.db.query("select observed_generation::text from boat_runtime_extension_state where sandbox_id=$1", [
              f.row.id,
            ])
          ).rows,
        ).toEqual([{ observed_generation: String(firstGeneration + 1) }]);
      }
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
      toolFailures.mockRestore();
    }
  });
});

test("Modal resume skips re-bootstrap after bootstrap_acknowledged and wakes immediately on enrolment", async () => {
  const f = await stopped("codex", "modal");
  const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
  const turns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
  const restore = {
    epoch: f.cp.runtime.epoch,
    watermark: f.cp.checkpoint.watermark,
    conversationId: f.first.conversationId!,
  };
  let providerCalls = 0,
    resumeCalls = 0,
    bootstrapCalls = 0;
  let ticketToken: string | undefined;
  const service = createResumeJob({
    turns,
    sql: f.sql,
    key: ENCRYPTION_KEY,
    commands: f.bridge,
    async provider() {
      providerCalls++;
      return {
        get: async () => ({ state: "ready", expiresAt: new Date(Date.now() + 86_400_000) }),
        async runtimeResumeMachine({ sandboxId, generation, ticket }) {
          return {
            predecessor: { sandboxId, generation: generation - 1, kind: "image", ref: "retained" },
            async resume() {
              resumeCalls++;
              return { sandboxId, generation, machineId: "replacement" };
            },
            async bootstrap(request) {
              ticketToken = (await ticket(request))?.enrolmentToken;
              bootstrapCalls++;
            },
          };
        },
      } as Pick<
        import("@armada/provider-modal").ModalProvider,
        "runtimeResumeMachine"
      > as import("@armada/provider-modal").ModalProvider;
    },
    prepare: async () => ({
      serverUrl: PUBLIC_URL,
      artifact: { sha256: "b".repeat(64), bytes: 5 },
      cacheDir: "/tmp/runtime",
      configuration: {},
    }),
    prepareMcp: async () => undefined,
    restoreScopedAccess: async () => {},
  });
  await f.sql.query(
    "insert into public.sandbox_launch_stages(sandbox_id,activation,stage,at) values($1,1,'accepted',now())",
    [f.row.id],
  );
  const turnRunner = createJobsRunner(jobs, {
    turn_dispatch: createTurnDispatchJob(
      f.sql,
      ENCRYPTION_KEY,
      createQueuedSandboxDispatch({
        authStore: createMemoryAuthStore(),
        supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(f.sql),
        providers: {
          resolve: async () => {
            throw Error("unused");
          },
        },
        runtimeSend: createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, undefined, service.wake),
      }),
    ),
  });
  expect(await turns.accept(f.caller, input(f.row.id))).toMatchObject({ status: "queued" });
  expect(await turnRunner.reconcileOne(new AbortController().signal)).toBe(true);
  await turnRunner.drain();

  const owner = crypto.randomUUID();
  const take = async () => {
    const job = (await jobs.claim("resume", owner, 30, 8))!;
    const result = await service.handler.run(job, {
      signal: new AbortController().signal,
      canDispatch: async (tx) => (await jobs.inspect(job, owner, tx)) === "dispatch",
      handoffGeneration: async () => {
        throw Error("unused");
      },
    });
    expect(await jobs.complete(job, owner, result)).toBeTrue();
    return result.status;
  };

  expect(await take()).toBe("retry");
  expect([providerCalls, resumeCalls, bootstrapCalls]).toEqual([1, 1, 1]);
  expect(
    (
      await f.sql.query(
        "select outcome->>'bootstrap_acknowledged' as ack from public.jobs where sandbox_id=$1 and kind='resume'",
        [f.row.id],
      )
    ).rows,
  ).toEqual([{ ack: "true" }]);

  await f.sql.query("update public.jobs set run_after='-infinity' where sandbox_id=$1 and kind='resume'", [f.row.id]);
  expect(await take()).toBe("retry");
  expect([providerCalls, resumeCalls, bootstrapCalls]).toEqual([1, 1, 1]);

  let wakes = 0;
  const unsubscribe = runtimeWakes.subscribe(JOBS_WAKE, () => void wakes++);
  try {
    await f.reboot(restore, true, ticketToken);
    expect(wakes).toBeGreaterThan(0);
    expect(
      (
        await f.sql.query("select stage from public.sandbox_launch_stages where sandbox_id=$1 and stage='enrolled'", [
          f.row.id,
        ])
      ).rows,
    ).toEqual([{ stage: "enrolled" }]);
    expect(await take()).toBe("done");
    expect([resumeCalls, bootstrapCalls]).toEqual([1, 1]);
  } finally {
    unsubscribe();
  }
});
