import { describe, expect, spyOn, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlVaultStore, DelegatedAuthority, type Provider } from "@armada/core/server";
import { fakeBoat, retainedSandbox, sandbox as sdkSandbox } from "../../provider-boat/test/support.ts";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { boatRuntimeResume } from "../src/boat-runtime-resume.ts";
import { dispatchControlCommand } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { modalRuntimeLaunch } from "../src/modal-runtime-launch.ts";
import { modalRuntimeResume } from "../src/modal-runtime-resume.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import { createRuntimeHistory } from "../src/runtime-history.ts";
import { createRuntimeResume } from "../src/runtime-resume.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { createSandboxArmadaAccess } from "../src/sandbox-armada-access.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runtimeFixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function stopped(
  harness: "codex" | "claude" | "opencode" = "codex",
  provider: "boat" | "modal" = "boat",
  idle = false,
) {
  const f = await runtimeFixture(await sharedDatabase(), provider, harness, idle);
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
}
const input = (id: string) => ({
  id,
  request_id: crypto.randomUUID(),
  runtimeVersion: 1 as const,
  prompt: "continue the previous conversation",
});

describe("Modal user stop and wake-on-send", () => {
  const fixture = scopedRuntimeFixture(async () => runtimeFixture(await sharedDatabase(), "modal"), {
    perTest: true,
  });

  test.each([false, true])(
    "wake restores the same native conversation after Modal stop (recover=%s)",
    async (recover) => {
      const f = await fixture();
      let needsRetry = recover;
      let state: "ready" | "stopped" = "ready";
      let retained: { epoch: string; watermark: number } | undefined;
      const host = {
        id: "modal",
        async get() {
          return { id: f.row.providerSandboxId, state, providerState: state, physicalGeneration: "1" };
        },
        async captureRuntimeWork() {
          return { status: "clean" };
        },
        async stop() {
          state = "stopped";
        },
        async stopRuntime({ epoch, watermark }: { epoch: string; watermark: number }) {
          if (needsRetry) {
            needsRetry = false;
            throw Error("Stop response was lost before physical stop was confirmed");
          }
          retained = { epoch, watermark };
          state = "stopped";
        },
      } as unknown as Provider;
      const serve = createRuntimeServing(f.sql, ENCRYPTION_KEY);
      const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
        async start(_signal, restore) {
          expect(restore).toMatchObject({
            epoch: retained?.epoch,
            watermark: retained?.watermark,
            conversationId: f.first.conversationId,
          });
          return f.reboot(restore);
        },
        async stop() {
          throw Error("Unexpected cleanup of healthy resume");
        },
      }));
      const controls = {
        authStore: createMemoryAuthStore(),
        supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        data: createSqlData(f.sql),
        providers: { resolve: (target: Parameters<typeof serve>[1]) => serve(host, target, f.caller) },
        runtimeStopCheckpoint: createRuntimeStopCheckpoint(
          f.sql,
          createRuntimeCheckpoint(f.sql, ENCRYPTION_KEY, f.bridge),
        ),
        runtimeSend: createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, resume),
      };
      const stop = () => dispatchControlCommand("sandbox/stop", f.caller, { id: f.row.id }, controls);
      if (recover) {
        await expect(stop()).rejects.toThrow();
        await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
        const target = (await controls.data(f.caller).sandboxes.get(f.row.id))!;
        const provider = await serve(host, target, f.caller);
        const stopCall = spyOn(provider, "stop");
        const lifecycle = createSandboxLifecycle(f.sql, async () => provider);
        expect(await lifecycle.reconcileOne()).toBe(true);
        await lifecycle.drain();
        expect(stopCall).toHaveBeenCalledWith({ sandboxId: f.row.providerSandboxId, requireRetention: true });
        expect((await controls.data(f.caller).sandboxes.get(f.row.id))?.status).toBe("stopped");
      } else {
        expect(await stop()).toMatchObject({ status: "stopped" });
      }
      const accountTurns = createAccountTurnQueue(f.sql, ENCRYPTION_KEY);
      accountTurns.setDispatch((caller, request) =>
        dispatchControlCommand("sandbox/send", caller, { ...request }, controls),
      );
      const outcome = Promise.withResolvers<"finished" | "interrupted">();
      f.hold(outcome.promise);
      const request = f.input();
      expect(
        await dispatchControlCommand("sandbox/send", f.caller, request, { ...controls, accountTurns }),
      ).toMatchObject({
        status: "queued",
      });
      expect(await accountTurns.reconcileOne(new AbortController().signal)).toBe(true);
      await accountTurns.drain();
      expect(await accountTurns.status(f.caller, request.id, request.request_id)).toEqual({
        nativePromptId: expect.any(String),
      });
      expect((await controls.data(f.caller).sandboxes.get(f.row.id))?.conversationIds).toEqual([
        f.first.conversationId,
      ]);
      const status = () =>
        dispatchControlCommand("sandbox/status", f.caller, { id: request.id, recorded: true }, controls);
      expect(await status()).toMatchObject({ status: "running" });
      outcome.resolve(recover ? "interrupted" : "finished");
      await outcome.promise;
      await f.runner.flushOutbox();
      expect(await status()).toMatchObject({ status: "ready" });
      const list = await dispatchControlCommand("sandbox/list", f.caller, { status: ["ready"] }, controls);
      expect(list).toMatchObject({ sandboxes: [expect.objectContaining({ id: request.id, status: "ready" })] });
      expect(retained).toMatchObject({ epoch: "1", watermark: expect.any(Number) });
      expect(f.starts).toEqual([undefined, "native-thread"]);
    },
  );
});

describe.each([
  ["boat", "codex"],
  ["boat", "claude"],
  ["modal", "codex"],
  ["modal", "claude"],
  ["modal", "opencode"],
] as const)("retained runtime resume (%s/%s)", (provider, harness) => {
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
           where sandbox_id=$1 and from_status='starting' and to_status='running'`,
          [f.row.id],
        )
      ).rows,
    ).toEqual([{ actor: "runtime_enrolment", code: "runtime_enrolled", generation: String(row.lifecycleGeneration) }]);
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
    const recovered = await createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, request);
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
    expect(stops).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an unenrolled Boat resume returns to a confirmed retained stop before another request can resume", async () => {
  const f = await stopped();
  try {
    let retainedStops = 0;
    const host = {
      id: "boat",
      get: async () => ({ id: "physical", state: "running" }),
      async stop() {
        retainedStops++;
      },
    } as unknown as Provider;
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
    const worker = createSandboxLifecycle(f.sql, async () => host);
    expect(await worker.reconcileOne()).toBe(true);
    expect(retainedStops).toBe(1);
    expect((await callerStore.get(f.row.id))?.status).toBe("stopping");

    const archivedWorker = createSandboxLifecycle(
      f.sql,
      async () => fakeBoat({ body: { sandbox: sdkSandbox(archive) } }).provider,
    );
    const archivedAt = "2026-11-19T00:00:00Z";
    let archive = {
      id: f.row.providerSandboxId,
      state: "archived",
      snapshotAvailable: false,
      stoppedAt: archivedAt,
      snapshotVerifiedAt: archivedAt,
    };
    await f.db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [f.row.id]);
    expect(await archivedWorker.reconcileOne()).toBe(true);
    expect((await callerStore.get(f.row.id))?.status).toBe("stopping");
    await expect(resume(f.caller, input(f.row.id))).rejects.toMatchObject({ code: "conflict" });

    archive = { ...archive, snapshotAvailable: true };
    await f.db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [f.row.id]);
    expect(await archivedWorker.reconcileOne()).toBe(true);
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
      expect((await store.get(f.row.id))?.status).toBe("stopped");
      await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
      expect((await resume(f.caller, input(f.row.id))).sourceCheckpoint.epoch).toBe(f.cp.runtime.epoch);
    } finally {
      await f.close();
    }
  },
);

test("rollback of an observed Boat archive handoff remains recoverable", async () => {
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
    let archiveHandoffs = 0;
    const rollback = Error("Injected handoff rollback");
    const workerSql: typeof f.sql = {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!(async (tx) => {
          const result = await work(tx);
          if (result === true && ++archiveHandoffs === 1) throw rollback;
          return result;
        }),
    };
    const worker = createSandboxLifecycle(workerSql, async () => provider);

    await expect(worker.reconcileOne()).rejects.toBe(rollback);
    expect(archiveHandoffs).toBe(1);
    expect((await store.get(f.row.id))?.status).toBe("starting");
    expect(await worker.reconcileOne()).toBe(false);

    await f.db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [f.row.id]);
    expect(await worker.reconcileOne()).toBe(true);
    expect((await store.get(f.row.id))?.status).toBe("stopping");

    expect(await worker.reconcileOne()).toBe(true);
    expect((await store.get(f.row.id))?.status).toBe("stopped");
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
  } finally {
    await f.close();
  }
});

test.each(["request catch", "expired activity lease", "activation before ticket"])(
  "an unenrolled Modal replacement recovers through %s and can enrol the current artifact",
  async (handoff) => {
    const f = await stopped("codex", "modal");
    try {
      const retainedArtifact = { sha256: "a".repeat(64), bytes: 3 };
      const currentArtifact = { sha256: "b".repeat(64), bytes: 5 };
      let artifact = retainedArtifact;
      let activated = false;
      let loseSettlement = false;
      let rollbacks = 0;
      const settlementFailure = Error("Lost logical settlement");
      const expireActivity = () =>
        f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
      let activations = 0,
        generation: number,
        refused: string | undefined;
      let enrolled: Awaited<ReturnType<typeof f.authority.enrol>> | undefined;
      let refusedGeneration: number | undefined;
      const physicalDeadline = new Date(Date.now() + 86_400_000);
      const host = {
        id: "modal",
        async get() {
          if (!activated) return { state: "stopped" };
          if (activations === 1 && handoff === "activation before ticket") {
            await expireActivity();
            throw Error("Lost read after confirming activation");
          }
          return { state: "ready", providerState: "active", expiresAt: physicalDeadline };
        },
        async resumeRuntime(request: { generation: number }) {
          generation = request.generation;
          activations++;
          if (activations === 1) refusedGeneration = generation;
          activated = true;
        },
        async rollbackRuntimeResume(request: { sandboxId: string; generation: number }) {
          expect(request).toEqual({ sandboxId: f.row.providerSandboxId, generation });
          activated = false;
          rollbacks++;
          if (handoff === "request catch" && rollbacks === 1) loseSettlement = true;
        },
        async startRuntime(request: { artifact: typeof artifact; enrolmentToken: string; resumeGeneration: number }) {
          expect(activated).toBe(true);
          expect(request.resumeGeneration).toBe(generation);
          artifact = request.artifact;
          if (activations === 1) {
            refused = request.enrolmentToken;
            await expect(f.authority.enrol(refused, "999")).rejects.toThrow("runtime_protocol_unsupported");
            if (handoff === "expired activity lease") await expireActivity();
            throw Error("Replacement did not enrol");
          }
          await expect(
            f.authority.issue({
              sandboxId: f.row.id,
              ownerId: f.caller.userId,
              configuration: {},
              expectedGeneration: refusedGeneration!,
            }),
          ).rejects.toThrow("runtime_enrolment_denied");
          enrolled = await f.authority.enrol(request.enrolmentToken);
          throw Error("Fixture ends after enrolment, before health");
        },
      } as unknown as import("@armada/provider-modal").ModalProvider;
      const prepare = modalRuntimeResume({
        sql: f.sql,
        vault: createSqlVaultStore(f.sql),
        key: ENCRYPTION_KEY,
        hostFor: async () => host,
        policy: modalRuntimeLaunch({
          sql: f.sql,
          encryptionKey: ENCRYPTION_KEY,
          serverUrl: "https://armada.example",
          architecture: "x64",
          manifest: {
            protocol: 1,
            platform: "linux",
            architecture: "x64",
            libc: "glibc",
            runtime: currentArtifact,
            harnesses: { codex: { files: [{ path: "bin/codex" }] } },
          },
        }),
      });
      const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, prepare);
      const first = input(f.row.id);
      await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
      const store = createSqlData(f.sql)(f.caller).sandboxes;
      const worker = createSandboxLifecycle(
        {
          ...f.sql,
          async transaction(work) {
            if (loseSettlement) {
              loseSettlement = false;
              throw settlementFailure;
            }
            return f.sql.transaction!(work);
          },
        },
        async () => host,
      );
      if (handoff !== "request catch") {
        expect((await store.get(f.row.id))?.status).toBe("starting");
        expect(
          (
            await f.db.query<{ parked: boolean }>(
              "select reconcile_after='infinity'::timestamptz as parked from sandboxes where id=$1",
              [f.row.id],
            )
          ).rows[0]?.parked,
        ).toBe(true);
        expect(await worker.reconcileOne()).toBe(true);
      }
      expect((await store.get(f.row.id))?.status).toBe("stopping");
      if (handoff === "request catch") {
        await expect(worker.reconcileOne()).rejects.toBe(settlementFailure);
        expect((await store.get(f.row.id))?.status).toBe("stopping");
        await f.db.query("update sandboxes set reconcile_lease_until=now()-interval '1 second' where id=$1", [
          f.row.id,
        ]);
      }
      expect(await worker.reconcileOne()).toBe(true);
      expect(rollbacks).toBe(handoff === "request catch" ? 2 : 1);
      expect((await store.get(f.row.id))?.status).toBe("stopped");
      expect(Boolean(refused)).toBe(handoff !== "activation before ticket");
      if (refused) await expect(f.authority.enrol(refused)).rejects.toThrow("runtime_enrolment_denied");
      await expect(resume(f.caller, first)).rejects.toMatchObject({ code: "conflict" });
      expect(activations).toBe(1);
      await expect(resume(f.caller, input(f.row.id))).rejects.toMatchObject({ code: "conflict" });
      expect(activations).toBe(2);
      expect(artifact).toEqual(currentArtifact);
      expect(enrolled?.epoch).toBe("2");
      const configuration = enrolled?.configuration as Record<string, unknown> | undefined;
      expect(configuration?.grant).toEqual({ expiresAt: physicalDeadline.getTime() });
      expect(configuration?.artifactManifest).toMatchObject({ runtime: currentArtifact });
      expect(configuration?.restoreCheckpoint).toMatchObject({
        epoch: f.cp.runtime.epoch,
        watermark: f.cp.checkpoint.watermark,
      });
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

test.each(["confirmed", "tainted", "lease expired", "archive unverified", "response lost", "handoff rollback"])(
  "Boat resume activation and recovery respect retained disk and lease authority (%s)",
  async (condition) => {
    const taint = condition === "tainted";
    const expired = condition === "lease expired";
    const unverified = condition === "archive unverified";
    const rollbackHandoff = condition === "handoff rollback";
    const responseLost = condition === "response lost" || rollbackHandoff;
    const f = await stopped();
    const requests: string[] = [];
    let activated = false;
    let canIssueTicket = false;
    const network = spyOn(globalThis, "fetch").mockImplementation((async (value: Parameters<typeof fetch>[0]) => {
      const url = String(value instanceof Request ? value.url : value);
      requests.push(url);
      if (url.endsWith("/resume")) {
        activated = true;
        if (responseLost) return new Response(null, { status: 504 });
        if (expired)
          await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
      }
      if (url.endsWith("/stop")) activated = false;
      return Response.json({
        ok: true,
        sandbox: activated
          ? sdkSandbox({ id: "physical", state: "running" })
          : retainedSandbox({ id: "physical", snapshotAvailable: !unverified }),
      });
    }) as typeof fetch);
    try {
      const prepare = boatRuntimeResume({
        sql: f.sql,
        vault: createSqlVaultStore(f.sql),
        key: ENCRYPTION_KEY,
        modelAuth: createModelAuthOwnership(f.sql, ENCRYPTION_KEY),
        policy: {
          async start(value) {
            if (taint) await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.row.id]);
            await value.activate?.(value.signal);
            canIssueTicket = true;
            throw Error("Fixture ends before ticket issuance");
          },
        },
      });
      let handoffRolledBack = false;
      const requestSql: typeof f.sql = rollbackHandoff
        ? {
            ...f.sql,
            transaction: (work) =>
              f.sql.transaction!(async (tx) => {
                const result = await work(tx);
                if (result === undefined) {
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
      expect(handoffRolledBack).toBe(rollbackHandoff);
      expect(canIssueTicket).toBe(!taint && !expired && !unverified && !responseLost);
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
              ...(expired ? [] : [{ stage: "machine_started", dated_correctly: true }]),
              { stage: "provider_claimed", dated_correctly: true },
            ]),
      ]);
      expect(requests.some((path) => path.endsWith("/resume"))).toBe(!taint && !unverified);
      const store = createSqlData(f.sql)(f.caller).sandboxes;
      expect((await store.get(f.row.id))?.status).toBe(
        taint ? "failed" : expired || responseLost ? "starting" : "stopping",
      );
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
        expect((await store.get(f.row.id))?.status).toBe("stopped");
        await expect(
          createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, prepare)(f.caller, request),
        ).rejects.toThrow();
        expect(
          (
            await createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
              start: (_signal, restore) => f.reboot(restore),
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
        expect((await store.get(f.row.id))?.status).toBe("stopped");
        await expect(
          createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
            start: (_signal, restore) => f.reboot(restore),
            stop: async () => {},
          }))(f.caller, input(f.row.id)),
        ).resolves.toMatchObject({
          sourceCheckpoint: { epoch: f.cp.runtime.epoch },
        });
      }
    } finally {
      network.mockRestore();
      await f.close();
    }
  },
);

// The Modal preparation adapter must resolve fresh credentials before activation
// and recheck the admitted SQL fence, not merely trust a retained host receipt.
test.each([false, true])(
  "Modal activation uses the source checkpoint only while disk remains untainted (%s)",
  async (taint) => {
    const f = await stopped("codex", "modal");
    const { modalRuntimeResume } = await import("../src/modal-runtime-resume.ts");
    try {
      const activations: unknown[] = [];
      const host = {
        id: "modal",
        get: async () => ({ id: "physical", state: "stopped" }),
        resumeRuntime: async (input: unknown) => {
          activations.push(input);
        },
        stop: async () => {},
      } as unknown as import("@armada/provider-modal").ModalProvider;
      const prepare = modalRuntimeResume({
        sql: f.sql,
        vault: createSqlVaultStore(f.sql),
        key: ENCRYPTION_KEY,
        hostFor: async () => host,
        policy: {
          async start(value) {
            if (taint) await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.row.id]);
            await value.activate?.(value.signal);
            throw Error("Fixture ends after Modal activation boundary");
          },
        },
      });
      await expect(
        createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, prepare)(f.caller, input(f.row.id)),
      ).rejects.toThrow();
      expect(activations).toEqual(
        taint
          ? []
          : [
              {
                sandboxId: "physical",
                generation: expect.any(Number),
                ttlSeconds: expect.any(Number),
                checkpoint: { epoch: "1", watermark: f.cp.checkpoint.watermark },
              },
            ],
      );
      expect(f.starts).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

describe.each([
  ["boat", "codex"],
  ["boat", "claude"],
  ["modal", "codex"],
  ["modal", "claude"],
  ["modal", "opencode"],
] as const)("empty retained runtime wake (%s/%s)", (provider, harness) => {
  const fixture = scopedRuntimeFixture(() => stopped(harness, provider, true));
  test("one fresh-epoch first conversation survives replay without inventing native history", async () => {
    const f = await fixture();
    expect(f.starts).toEqual([]);
    const scoped = provider === "modal" && harness === "codex";
    const authority = new DelegatedAuthority(f.sql, async () => {});
    const access = createSandboxArmadaAccess({
      sql: f.sql,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: PUBLIC_URL,
      commands: f.bridge,
    });
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
    if (scoped) {
      await f.db.query("update sandboxes set visibility='private',access_owner_id=owner_id where id=$1", [f.row.id]);
      await f.db.query(
        `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,golden_ids,credential_ids)
         values($1,'sandbox',$2,$3,$1,'ready',array[$4::uuid],array[$5::uuid])`,
        [f.row.id, f.people.org, f.people.owner, f.row.goldenId, f.account.id],
      );
    }
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
      access.restoreEnrolled,
    );
    const send = createRuntimeFollowup(f.sql, ENCRYPTION_KEY, f.bridge, undefined, resume, access.restoreEnrolled);
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
    if (scoped) await authority.revoke(f.row.id);
    const next = await send(f.caller, f.input("follow up"));
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

describe("uncertain empty Modal wake", () => {
  const fixture = scopedRuntimeFixture(() => stopped("codex", "modal", true));
  test("fresh server reconciles the first conversation without reactivation or another model turn", async () => {
    const f = await fixture();
    let activations = 0;
    const resume = createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge, async () => ({
      async start(_signal, restore) {
        activations++;
        return f.reboot(restore);
      },
      async stop() {
        throw Error("No activation retry");
      },
    }));
    const request = { ...f.input("first instruction"), runtimeVersion: 1 as const };
    f.lose();
    await expect(resume(f.caller, request)).rejects.toMatchObject({ code: "conflict" });
    expect(f.starts).toEqual([undefined]);
    expect(activations).toBe(1);
    const recovered = await createRuntimeResume(f.sql, ENCRYPTION_KEY, f.bridge)(f.caller, request);
    expect(recovered.sourceCheckpoint.empty).toBe(true);
    expect(recovered.runtime.epoch).toBe("2");
    expect(f.starts).toEqual([undefined]);
    expect(activations).toBe(1);
    expect((await createSqlData(f.sql)(f.caller).sandboxes.get(f.row.id))?.conversationIds).toEqual([
      recovered.conversationId,
    ]);
  });
});
