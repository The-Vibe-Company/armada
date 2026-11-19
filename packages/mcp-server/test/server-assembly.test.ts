import { expect, test } from "bun:test";
import { assembleServer } from "../src/modules.ts";
import type { ServerServices } from "../src/server-services.ts";

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
    langfuse: passiveLane,
    modal: { inventoryReaper: () => ({ ...passiveLane, isolatedSweep: true }) },
  } as unknown as ServerServices;

  expect(assembleServer(services).planWorkers().description).toMatchInlineSnapshot(`
    {
      "background": [
        "invitations",
        "routines",
      ],
      "isolated": [
        {
          "name": "golden-builds",
          "sweep": true,
        },
        {
          "name": "langfuse",
          "sweep": false,
        },
        {
          "name": "steer-recovery",
          "sweep": false,
        },
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
        "pull-requests",
        "jobs",
        "native-prompts",
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
  expect(minimal.managed).not.toContain("pull-requests");
  expect(minimal.isolated.map(({ name }) => name)).not.toContain("docker-inventory:host-1");
});
