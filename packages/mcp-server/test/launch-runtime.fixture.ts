import type { LaunchOptions, Sql } from "@armada/core/server";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { ENCRYPTION_KEY, type FakeBoat } from "./support.ts";

export function enrolledLaunchPolicy(sql: Sql) {
  const enrolments = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  return {
    async start({ host, sandbox }) {
      const ticket = await enrolments.issue({
        sandboxId: sandbox.id,
        ownerId: sandbox.ownerId,
        configuration: {},
      });
      const active = await enrolments.enrol(ticket.enrolmentToken);
      return {
        epoch: active.epoch,
        prepareWorkspace: async () => ({ status: "not_connected" }),
        installSkills: async () => {
          throw Error("Unexpected skill installation");
        },
        prompt: (request) => (host as FakeBoat["provider"]).prompt(request),
      };
    },
  } satisfies NonNullable<LaunchOptions["runtime"]>;
}
