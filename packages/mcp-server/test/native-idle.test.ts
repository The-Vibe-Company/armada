import { expect, test } from "bun:test";
import type { Provider, SandboxInfo } from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { nativeQuiescent } from "../src/native-idle.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { bunLikeSql } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();
async function fixture(mode = "quiet") {
  const { db, people } = await sharedDatabase();
  const sql = bunLikeSql(db);
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const data = createSqlData(sql)(caller);
  const placement = mode === "modal-retry" ? "modal" : "boat";
  const golden =
    placement === "boat"
      ? (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!
      : { id: crypto.randomUUID() };
  if (placement === "modal")
    await db.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1,$2,$3,'native-modal-idle','org','modal','image','workspace','main','app','{}'::jsonb)`,
      [golden.id, people.org, people.owner],
    );
  const id = crypto.randomUUID(),
    physical = placement === "boat" ? "bx_23456789" : "native-modal",
    task = "turn";
  const at = Date.now();
  let phase = "active",
    nonactiveObservations = 0;
  let clock = at + 599_999,
    stopped = false,
    stops = 0,
    observations = 0;
  const credential = (
    await db.query<{ id: string }>(
      "select id from credentials where scope='user' and owner_id=$1 and kind='claude_oauth'",
      [people.owner],
    )
  ).rows[0]!;
  await data.sandboxes.insert({
    id,
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    credentialId: credential.id,
    credentialVersion: 1,
    provider: placement,
    providerSandboxId: physical,
    harness: "claude",
    status: "running",
    model: "claude-sonnet-5",
    reasoningEffort: "high",
    expiresAt: new Date(at + 3_600_000).toISOString(),
    effectiveTtlSeconds: 3600,
  });
  await data.sandboxes.update(id, { taskPromptId: task, conversationIds: ["conversation"] });
  const provider = {
    id: placement,
    observeOrchestrator: async () => {
      if (phase !== "active") {
        nonactiveObservations++;
        throw Error("Native observation requires active phase");
      }
      return {
        physicalGeneration: "1",
        state: "quiescent",
        eventWatermark: 1,
        acknowledgedSequence: 1,
        evidence: "f".repeat(64),
        nativeSessionId: "native",
      };
    },
    get: async (): Promise<SandboxInfo> => ({
      id: physical,
      state: stopped ? "stopped" : phase === "active" ? "running" : "stopping",
      createdAt: new Date(at),
      name: "native",
      providerState: phase,
      ...(placement === "modal" ? { physicalGeneration: "1" } : {}),
      ...(stopped && mode === "lost-retention" ? { stopNote: "checkpoint_failed_disk_not_retained" as const } : {}),
      labels: {},
    }),
    getPrompt: async () => ({
      promptId: task,
      status: mode === "running-turn" ? "running" : "finished",
      done: mode !== "running-turn",
    }),
    conversations:
      mode === "missing-port"
        ? undefined
        : async () => {
            observations++;
            return [
              { id: "conversation", running: mode === "active" || (mode === "becomes-active" && observations > 2) },
            ];
          },
    events: async () => {
      if (mode === "raced")
        await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
      return {
        events:
          mode === "missing-event"
            ? []
            : [
                {
                  id: "event",
                  promptId: task,
                  conversationId: "conversation",
                  kind: "prompt",
                  text: "done",
                  status: "finished",
                  at,
                },
              ],
        hasMore: false,
      };
    },
    quiesce: async () => {
      throw Error("Idle policy must never interrupt/quiesce native work");
    },
    interrupt: async () => {
      throw Error("Idle policy must never interrupt native work");
    },
    exec: async () => ({
      detached: false,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      stdout: '{"status":"clean"}',
      stderr: "",
    }),
    stop: async (request: { requireRetention?: boolean }) => {
      expect(request.requireRetention).toBe(true);
      stops++;
      if (mode === "modal-retry" && stops === 1) {
        phase = "checkpoint";
        throw Error("checkpoint reply lost");
      }
      stopped = true;
      phase = "stopped";
    },
    prompt: async () => {
      stopped = false;
      return { promptId: "next", conversationId: "conversation", status: "queued", resumed: true };
    },
  } as unknown as Provider;
  const worker = createSandboxLifecycle(sql, async () => provider, { now: () => clock, delayMs: 600_000 });
  const tick = async () => {
    await db.query("update sandboxes set reconcile_after=now()-interval '1 minute' where id=$1", [id]);
    await worker.reconcileOne();
  };
  return {
    db,
    data,
    caller,
    id,
    at,
    provider,
    tick,
    worker,
    stops: () => stops,
    nonactiveObservations: () => nonactiveObservations,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

test("native idle uses the quiet deadline, preserves work without interrupt and wakes with unchanged expiry", async () => {
  const f = await fixture();
  await f.tick();
  expect(f.stops()).toBe(0);
  f.setClock(f.at + 600_000);
  await f.tick();
  expect(f.stops()).toBe(1);
  const paused = (await f.data.sandboxes.get(f.id))!;
  expect(paused.status).toBe("stopped");
  expect(paused.statusReason).toBe("idle_paused");
  const receipt = await callSharedTool(
    {
      caller: f.caller,
      data: f.data,
      provider: async () => f.provider,
      launchCredentials: {
        resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }),
      },
      exposedSecrets: async () => [],
      now: () => new Date(f.at + 600_000),
      sleep: async () => {},
    },
    "send",
    { id: f.id, prompt: "continue", request_id: crypto.randomUUID() },
  );
  expect(receipt).toMatchObject({ promptId: "next", conversationId: "conversation" });
  const woke = (await f.data.sandboxes.get(f.id))!;
  expect(woke.status).toBe("running");
  expect(woke.expiresAt).toBe(paused.expiresAt);
  await f.worker.drain();
});

test.each([
  "active",
  "raced",
  "becomes-active",
  "unknown-exec",
  "running-turn",
  "missing-event",
  "missing-port",
  "tainted",
  "unbound",
] as const)("unproven native work is not interrupted or stopped (%s)", async (mode) => {
  const f = await fixture(mode);
  f.setClock(f.at + 700_000);
  if (mode === "tainted") await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.id]);
  if (mode === "unbound")
    await f.db.query("update sandboxes set credential_id=null,credential_version=null where id=$1", [f.id]);
  if (mode === "unknown-exec")
    await f.db.query("update sandboxes set activity_lease_id=$2,activity_until=now()-interval '1 minute' where id=$1", [
      f.id,
      crypto.randomUUID(),
    ]);
  await f.tick();
  expect(f.stops()).toBe(0);
  if (mode === "unknown-exec") {
    expect(
      (await f.db.query<{ activity_lease_id: string }>("select activity_lease_id from sandboxes where id=$1", [f.id]))
        .rows[0]?.activity_lease_id,
    ).not.toBeNull();
    await f.tick();
    expect(f.stops()).toBe(0);
  }
  if (mode === "becomes-active") {
    const stopping = (await f.data.sandboxes.get(f.id))!;
    if (stopping.lifecycleGeneration === undefined) throw Error("Missing lifecycle generation");
    expect(stopping.status).toBe("stopping");
    await expect(
      f.data.sandboxes.update(f.id, {
        status: "starting",
        stopRequested: false,
        activityToken: crypto.randomUUID(),
        advanceGeneration: true,
        expectedGeneration: stopping.lifecycleGeneration,
      }),
    ).rejects.toThrow();
    await f.tick();
    expect(f.stops()).toBe(0);
  }
  await f.worker.drain();
});

test("Modal native idle needs current physical quiescence and a synchronized watermark", async () => {
  const info = { id: "modal-logical", state: "running", createdAt: new Date(), physicalGeneration: "7" } as SandboxInfo;
  for (const [state, generation, watermark, acknowledged, expected] of [
    ["quiescent", "7", 5, 5, true],
    ["unknown", "7", 5, 5, false],
    ["active", "7", 5, 5, false],
    ["quiescent", "6", 5, 5, false],
    ["quiescent", "7", 5, 4, false],
  ] as const) {
    const provider = {
      id: "modal",
      observeOrchestrator: async () => ({
        state,
        physicalGeneration: generation,
        eventWatermark: watermark,
        acknowledgedSequence: acknowledged,
        evidence: "f".repeat(64),
        nativeSessionId: "native",
      }),
    } as unknown as Provider;
    expect(await nativeQuiescent(provider, info)).toBe(expected);
  }
  expect(await nativeQuiescent({ id: "modal" } as Provider, info)).toBe(false);
});

test("an expired native idle pause refuses wake before provider work", async () => {
  const f = await fixture();
  await f.data.sandboxes.update(f.id, {
    status: "stopped",
    statusReason: "idle_paused",
    stoppedAt: new Date(f.at).toISOString(),
    expiresAt: new Date(f.at + 600_000).toISOString(),
  });
  await expect(
    callSharedTool(
      {
        caller: f.caller,
        data: f.data,
        provider: async () => {
          throw Error("Provider must not be resolved for expired idle pause");
        },
        launchCredentials: {
          resolve: async () => {
            throw Error("No credentials after expiry");
          },
        },
        exposedSecrets: async () => [],
        now: () => new Date(f.at + 600_000),
        sleep: async () => {},
      },
      "send",
      { id: f.id, prompt: "too late" },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("native Modal retries its already-fenced stop phase without active-only observation", async () => {
  const f = await fixture("modal-retry");
  f.setClock(f.at + 600_000);
  await f.tick();
  expect(f.stops()).toBe(1);
  expect((await f.data.sandboxes.get(f.id))?.status).toBe("stopping");
  await f.tick();
  expect(f.stops()).toBe(2);
  expect(f.nonactiveObservations()).toBe(0);
  expect((await f.data.sandboxes.get(f.id))?.status).toBe("stopped");
  await f.worker.drain();
});

test("a provider-reported lost workspace is failed, never advertised as a resumable idle pause", async () => {
  const f = await fixture("lost-retention");
  f.setClock(f.at + 600_000);
  await f.tick();
  const failed = (await f.data.sandboxes.get(f.id))!;
  expect(failed.status).toBe("failed");
  expect(failed.statusReason).not.toBe("idle_paused");
  expect(failed.stoppedAt).not.toBeNull();
  await f.worker.drain();
});
