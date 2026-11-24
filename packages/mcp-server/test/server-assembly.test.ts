import { expect, test } from "bun:test";
import { assembleServer } from "../src/modules.ts";
import type { ServerServices } from "../src/server-services.ts";
import { jobsModule, type LaneFactory } from "../src/server-worker-modules.ts";

const modalCleanup = {
  launchCleanupJob: {
    concurrency: 1,
    async run() {
      throw new Error("An empty claim must not run Modal cleanup.");
    },
  },
} satisfies Pick<ServerServices["modal"], "launchCleanupJob">;

test("server assembly preserves worker lane order and isolation", () => {
  const neverCall = async () => {
    throw new Error("Planning must not call a provider.");
  };
  const passiveLane = {
    reconcileOne: async () => false,
    drain: async () => {},
  };
  const services = {
    env: { ARMADA_INVITATION_MAIL: "supabase" },
    options: {
      providerReaperSources: [
        {
          provider: "docker",
          sourceId: "host-1",
          deploymentId: "test",
          inventory: { listInventory: neverCall },
          lookupOwnership: neverCall,
        },
      ],
    },
    config: { encryptionKey: "test" },
    idleDelayMs: 100,
    control: { invitations: {} },
    githubApp: {},
    outputs: { captureJob: { concurrency: 4, run: neverCall } },
    webhooks: { run: neverCall },
    delegatedAccess: { childWorker: passiveLane },
    accountTurns: passiveLane,
    runtimeMcp: { prepare: neverCall },
    langfuse: { exportJob: { concurrency: 1 } },
    modal: { ...modalCleanup, inventoryReaper: () => ({ ...passiveLane, isolatedSweep: true }) },
  } as unknown as ServerServices;

  expect(assembleServer(services).planWorkers().description).toMatchInlineSnapshot(`
    {
      "background": [
        "invitations",
        "routines",
      ],
      "isolated": [
        {
          "name": "modal-inventory",
          "sweep": true,
        },
        {
          "name": "docker-inventory:host-1",
          "sweep": true,
        },
      ],
      "managed": [
        "sandbox-lifecycle",
        "jobs",
        "delegated-access",
        "docker-cleanup",
        "account-turns",
        "runtime-idle",
      ],
    }
  `);

  const minimal = assembleServer({
    ...services,
    env: {},
    options: {},
    githubApp: null,
  }).planWorkers().description;
  expect(minimal.background).toEqual(["routines"]);
  expect(minimal.managed).toContain("jobs");
  expect(minimal.isolated.map(({ name }) => name)).not.toContain("docker-inventory:host-1");
});

test("the shared jobs lane claims only configured job kinds", async () => {
  const neverCalled = async () => {
    throw new Error("An empty claim must not run a job.");
  };
  const managed = new Map<string, LaneFactory>();
  jobsModule({ workers: { managed } } as Parameters<typeof jobsModule>[0]);
  const createLane = managed.get("jobs")!;
  for (const { githubApp, encryptionKey, modalRuntime, expected } of [
    {
      githubApp: null,
      encryptionKey: undefined,
      expected: ["golden_build", "langfuse_export", "maintenance", "webhook"],
    },
    {
      githubApp: {},
      encryptionKey: undefined,
      expected: ["golden_build", "langfuse_export", "maintenance", "webhook", "pr_scan"],
    },
    {
      githubApp: null,
      encryptionKey: "test",
      expected: ["golden_build", "langfuse_export", "maintenance", "webhook", "outputs_capture"],
    },
    {
      githubApp: {},
      encryptionKey: "test",
      modalRuntime: true,
      expected: ["golden_build", "langfuse_export", "maintenance", "webhook", "pr_scan", "outputs_capture", "launch"],
    },
  ]) {
    if (encryptionKey) expected.push("stop");
    const claimed = new Set<string>();
    const errors: string[] = [];
    let backfillAttempts = 0;
    const lane = createLane({
      githubApp,
      control: {},
      options: { logError: (message: string) => errors.push(message) },
      config: { encryptionKey },
      accountTurns: {
        async backfillDispatchJobs() {
          backfillAttempts++;
          throw new Error("Backfill unavailable");
        },
      },
      runtimeMcp: { prepare: neverCalled },
      modal: modalCleanup,
      modalLaunchJob: modalRuntime ? { concurrency: 1, run: neverCalled } : undefined,
      sql: { query: async () => ({ rows: [] }) },
      jobs: {
        async enqueue() {},
        async claim(kind: string) {
          claimed.add(kind);
        },
      },
      langfuse: { exportJob: { concurrency: 1, run: neverCalled } },
      webhooks: { run: async () => ({ status: "done" }) },
      outputs: {
        captureJob: { concurrency: 4, run: async () => ({ status: "done" }) },
        enqueueCaptures: async () => {},
      },
    } as unknown as Parameters<LaneFactory>[0]);
    await lane?.reconcileOne(new AbortController().signal);
    expect(claimed).toEqual(
      new Set(["delete", ...(encryptionKey ? ["launch_initial_turn"] : []), ...expected, "snapshot_retirement"]),
    );
    expect(backfillAttempts).toBe(encryptionKey ? 1 : 0);
    expect(errors).toEqual(encryptionKey ? ["armada: queued turn job backfill unavailable."] : []);
  }
});
