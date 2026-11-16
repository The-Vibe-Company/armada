import { expect, test } from "bun:test";
import type { Sql } from "../src/golden-store.ts";
import { createRoutineScheduler } from "../src/routine-scheduler.ts";
import { VaultError } from "../src/vault-error.ts";

const run = {
  id: "run",
  routine_id: "routine",
  org_id: "org",
  owner_id: "owner",
  request_key: "key",
  state: "admitted",
  lease_id: "lease",
};

// Recover one durable occurrence, then exercise real dispatch/settlement without timers or providers.
async function failure(error?: unknown, savedReason?: string, result?: Record<string, unknown>) {
  let recovered = false;
  let settled: unknown[] = [];
  const sql = {
    transaction: async (work: (tx: Sql) => Promise<unknown>) => work(sql as Sql),
    query: async (query: string, params: unknown[] = []) => {
      let rows: unknown[] = [];
      if (query.startsWith("select * from public.routine_runs where state in") && !recovered) {
        recovered = true;
        rows = [run];
      } else if (query.startsWith("update public.routine_runs set lease_id")) rows = [run];
      else if (query.includes("from public.template_launch_requests") && savedReason)
        rows = [{ id: "claim", state: "failed", reason: savedReason }];
      else if (query.includes("from public.routine_run_inputs where"))
        rows = [{ template_id: "template", template_revision: 1, prompt: "hello", ttl_seconds: 60 }];
      else if (query.includes("select m.role,r.scope")) rows = [{ role: "admin", scope: "personal" }];
      else if (query.startsWith("update public.routine_runs set state=")) {
        settled = params;
        rows = [{ id: run.id }];
      }
      return { rows };
    },
  } as Sql;
  const scheduler = createRoutineScheduler(sql, {
    observe: async () => "unknown",
    launch: async () => {
      if (error) throw error;
      return result ?? {};
    },
  });
  await scheduler.tick();
  await scheduler.drain();
  return { reason: settled[3], claim: settled[4], refusal: settled[8] };
}

test("pre-claim admission refusal is retained without arbitrary exception text", async () => {
  expect(await failure(new VaultError("conflict", "Template launch refused: variable_version_changed."))).toEqual({
    reason: "launch_failed",
    claim: null,
    refusal: "variable_version_changed",
  });
  for (const error of [
    new Error("private_value"),
    new VaultError("conflict", "Template launch refused: private_value."),
  ])
    expect((await failure(error)).refusal).toBeNull();
});

test("failed durable claims retain the allowlisted refusal during recovery", async () => {
  expect(await failure(undefined, "secret_version_changed")).toEqual({
    reason: "launch_failed",
    claim: "claim",
    refusal: "secret_version_changed",
  });
  expect((await failure(undefined, "private_value")).refusal).toBeNull();
  for (const reason of ["skillpack_credential_missing", "skillpack_credential_refused"])
    expect((await failure(undefined, reason)).refusal).toBe(reason);
});

test("returned pre-claim refusals are terminal and sanitized", async () => {
  expect(
    await failure(undefined, undefined, { state: "failed", reason: "no_credentials", message: "private_value" }),
  ).toEqual({ reason: "launch_failed", claim: null, refusal: "no_credentials" });
});

test("authorized history retains refusal for paused routines and denies nonmembers", async () => {
  const { createRoutineService } = await import("../src/routine-service.ts");
  const org = "00000000-0000-0000-0000-000000000001";
  const id = "00000000-0000-0000-0000-000000000002";
  let member = true;
  const sql = {
    transaction: async (work: (tx: Sql) => Promise<unknown>) => work(sql as Sql),
    query: async (query: string) => ({
      rows: query.includes("select role from public.members")
        ? member
          ? [{ role: "admin" }]
          : []
        : query.includes("select * from public.routines")
          ? [{ id, status: "paused", pause_reason: "repeated_launch_failures" }]
          : [{ reason: "launch_failed", launch_refusal: "variable_version_changed" }],
    }),
  } as Sql;
  const service = createRoutineService(sql);
  const actor = { userId: "owner", orgs: [{ orgId: org }] };
  const history = await service.command(actor, "history", { org, id });
  expect(history.items).toMatchObject([{ launchRefusal: "variable_version_changed" }]);
  member = false;
  await expect(service.command(actor, "history", { org, id })).rejects.toThrow("Routine access denied.");
});
