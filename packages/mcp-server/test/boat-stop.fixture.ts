import type { Machine, Sql } from "@armada/core/server";
import { createBoatStop } from "../src/jobs/boat-stop.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { ENCRYPTION_KEY } from "./support.ts";

export async function runBoatStop(sql: Sql, machine: Pick<Machine, "observe" | "stop">, now = Date.now) {
  const store = createJobsStore(sql, ENCRYPTION_KEY);
  const owner = crypto.randomUUID();
  const job = await store.claim("stop", owner, 30, 1);
  if (!job) throw Error("Missing Boat stop job.");
  const handler = createBoatStop(sql, ENCRYPTION_KEY, "fixture", now, async () => ({ machine, outputs: {} }));
  const result = await handler(job, {
    signal: new AbortController().signal,
    async canDispatch(tx) {
      return (await store.inspect(job, owner, tx)) === "dispatch";
    },
    async handoffGeneration() {
      throw Error("Unexpected generation handoff.");
    },
  });
  if (!(await store.complete(job, owner, result))) throw Error("Boat stop completion lost.");
  return result.status;
}

export function archivedBoat(usable = true) {
  return {
    observe: async () => ({ kind: "absent" as const }),
    async stop(request: Parameters<Machine["stop"]>[0]) {
      if (!usable) throw Error("Boat retention is unconfirmed.");
      return request.retain ? { ...request, kind: "disk" as const, ref: request.machineId } : null;
    },
  };
}
