import { expect, test } from "bun:test";
import { assembleServer } from "../src/modules.ts";
import type { ServerServices } from "../src/server-services.ts";

test("server assembly preserves worker lane order and isolation", () => {
  const passiveLane = {
    reconcileOne: async () => false,
    drain: async () => {},
  };
  const services = {
    env: { ARMADA_INVITATION_MAIL: "supabase" },
    options: {},
    config: { encryptionKey: "test" },
    idleDelayMs: 100,
    control: { invitations: {} },
    githubApp: {},
    outputs: passiveLane,
    webhooks: passiveLane,
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
      ],
      "managed": [
        "sandbox-lifecycle",
        "pull-requests",
        "jobs",
        "outputs",
        "webhooks",
        "native-prompts",
        "delegated-access",
        "docker-cleanup",
        "account-turns",
        "runtime-idle",
      ],
    }
  `);
});
