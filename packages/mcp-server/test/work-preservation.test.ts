import { afterAll, beforeAll, expect, test } from "bun:test";
import { encryptSecret } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeProvider, type RuntimeWorkProvider } from "../src/runtime-provider.ts";
import { preserveBeforeStop, readWorkRecovery } from "../src/work-preservation.ts";
import { closeableFixture } from "./closeable.fixture.ts";
import { reuseCollectorKeyPair } from "./fixtures/recovery-exec.ts";
import { migratedDatabase } from "./migrated-database.ts";
import { bunLikeSql, ENCRYPTION_KEY, fakeBoat, seedDatabase } from "./support.ts";

let restoreCollectorKeys: (() => void) | undefined;
beforeAll(() => {
  restoreCollectorKeys = reuseCollectorKeyPair();
});
afterAll(() => restoreCollectorKeys?.());

const fixture = closeableFixture(async () => {
  const db = await migratedDatabase();
  try {
    await db.exec("set search_path=public");
    const seeded = await seedDatabase(db);
    const modalGolden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
         modal_workspace,modal_environment,modal_app_id,config)
         values($1,$2,'preservation-modal','private','modal','preservation-modal','preservation-modal',
         'workspace','main','app','{"repos":[],"init":[]}') returning id`,
        [seeded.people.org, seeded.people.owner],
      )
    ).rows[0];
    if (!modalGolden) throw new Error("Missing Modal golden fixture");
    return { ...seeded, modalGoldenId: modalGolden.id, close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
});

beforeAll(fixture.setup);
afterAll(fixture.close);
const sharedDatabase = fixture.get;

// Primary owner for encrypted persistence and recovery authorization. Collector behavior
// (including actual Git reconstruction) belongs to core's work-preservation test.
test("a detached historical archive remains recoverable only by its owner and org admins", async () => {
  const { db, people, sharedGoldenId } = sharedDatabase();
  const id = crypto.randomUUID(),
    archiveId = crypto.randomUUID();
  const archive = "historical-work";
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,visibility,deleted_at)
       values($1,$2,$3,$4,'boat','bx_historical','codex','deleted','org',now())`,
    [id, sharedGoldenId, people.org, people.owner],
  );
  await db.query(
    "insert into native_drain_recovery(archive_id,sandbox_id,org_id,owner_id,archive_enc) values($1,$2,$3,$4,$5)",
    [archiveId, id, people.org, people.owner, await encryptSecret(archive, ENCRYPTION_KEY)],
  );
  const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  try {
    const read = (actor: string) => readWorkRecovery(bunLikeSql(db), [[people.org], actor], id, archiveId);
    expect(await read(people.owner)).toBe(archive);
    expect(await read(people.admin)).toBe(archive);
    expect(await read(people.member)).toBeUndefined();
  } finally {
    if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
  }
});

async function withPreservationRow(
  work: (fixture: {
    db: Awaited<ReturnType<typeof sharedDatabase>>["db"];
    sql: ReturnType<typeof bunLikeSql>;
    id: string;
    physical: string;
    generation: number;
    activity: string | null;
    boat: ReturnType<typeof fakeBoat>;
    provider: ReturnType<typeof fakeBoat>["provider"];
  }) => Promise<void>,
  machine: "boat" | "boat-runtime" | "modal" | "modal-native" = "boat",
) {
  const { db, people, sharedGoldenId: goldenId, modalGoldenId } = sharedDatabase();
  const id = crypto.randomUUID();
  const modal = machine === "modal" || machine === "modal-native";
  const physical = modal ? `modal_machine_${id}` : `bx_policy_${id}`;
  const activity = machine !== "boat" ? crypto.randomUUID() : null;
  const inserted = await db.query<{ lifecycle_generation: number }>(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
       runtime_transport,outputs_failure_reasons,stop_requested_at,stop_generation,activity_lease_id,activity_until,boat_runtime)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,array['collector_unsupported'],
       case when $10::uuid is not null then now() end,
       case when $10::uuid is not null then 1 else 0 end,
       $10,case when $10::uuid is not null then now()+interval '2 minutes' end,$11)
    returning lifecycle_generation`,
    [
      id,
      modal ? modalGoldenId : goldenId,
      people.org,
      people.owner,
      modal ? "modal" : "boat",
      physical,
      modal ? "codex" : "claude",
      activity ? "stopping" : "running",
      machine === "modal" ? "dialout" : null,
      activity,
      machine === "boat-runtime",
    ],
  );
  const boat = fakeBoat();
  const provider = {
    ...boat.provider,
    get: async () => ({
      id: physical,
      name: "policy",
      state: "ready" as const,
      providerState: "idle",
      labels: {},
    }),
    quiesce: async () => {},
  };
  await work({
    db,
    id,
    physical,
    generation: inserted.rows[0]!.lifecycle_generation,
    activity,
    boat,
    provider,
    sql: bunLikeSql(db),
  });
}

test("a user JWT cannot forge stop receipts or write application-secret taint", async () => {
  await withPreservationRow(async ({ db }) => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("insert into sandboxes(preservation_stop_generation) values(1)")).rejects.toThrow(
        "permission denied",
      );
      await expect(db.query("update sandboxes set application_secret_tainted=true")).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await db.exec("reset role");
    }
  });
});

test("an unavailable receipt lookup defers stop without provider work", async () => {
  const sql = {
    query: async () => {
      throw new Error("Synthetic receipt outage");
    },
  };
  const boat = fakeBoat();
  let reads = 0;
  const provider = {
    ...boat.provider,
    async get() {
      reads++;
      throw new Error("Must defer before observing the machine");
    },
  };
  expect(await preserveBeforeStop(sql, provider, crypto.randomUUID(), "bx_policy")).toBe("pending");
  expect(reads).toBe(0);
});

// The real persistence boundary owns this no-archive contract, including restart.
test("application-secret taint permanently disables collection and recovery, purging older archives", async () => {
  const { db, people, sharedGoldenId: goldenId } = sharedDatabase();

  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
       values($1,$2,$3,$4,'boat','bx_tainted','claude','running')`,
    [id, goldenId, people.org, people.owner],
  );
  await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [id, new Uint8Array([1])]);
  // Taint after a completed stop must replace the now-purged recovery pointer,
  // even when the completed stop receipt prevents normal note updates.
  await db.query(
    "update sandboxes set stop_requested_at=now(),preservation_stop_generation=stop_generation,preservation_note='unpushed work preserved' where id=$1",
    [id],
  );
  await db.query("update sandboxes set application_secret_tainted=true where id=$1", [id]);
  expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(0);
  await expect(db.query("update sandboxes set application_secret_tainted=false where id=$1", [id])).rejects.toThrow(
    "irreversible",
  );
  await expect(
    db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [id, new Uint8Array([1])]),
  ).rejects.toThrow("Work recovery unavailable");
  const taintNote = (
    await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id])
  ).rows[0]!.preservation_note;
  expect(taintNote).toContain("resume and recovery are unavailable");
  // Permit the collector's note write, rather than only exercising a completed
  // receipt whose fence suppresses it. Both writers must give identical guidance.
  await db.query("update sandboxes set stop_requested_at=null,preservation_stop_generation=null where id=$1", [id]);
  const boat = fakeBoat();
  let providerReads = 0;
  const provider = {
    ...boat.provider,
    async get() {
      providerReads++;
      throw Error("must not touch tainted compute");
    },
  };
  for (const source of ["user_stop", "lifecycle_stop", "managed_child_stop"] as const) {
    await preserveBeforeStop(bunLikeSql(db), provider, id, "bx_tainted", source);
    const data = createSqlData(bunLikeSql(db))({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    });
    expect(await data.sandboxes.readWorkRecovery?.(id)).toBeNull();
    expect((await data.sandboxes.get(id))?.preservationNote).toBe(taintNote);
  }
  expect(providerReads).toBe(0);
  expect(boat.execs).toHaveLength(0);
});

const runtimeCaptureScenarios = [
  "dirty",
  "clean",
  "takeover_before_capture",
  "takeover_during_capture",
  "takeover_on_failure",
  "quiescence_rejected",
  "lost_receipt_response",
] as const;

test.each([
  ...runtimeCaptureScenarios.map((scenario) => ["modal", scenario] as const),
  ...[
    "dirty",
    "clean",
    "takeover_before_capture",
    "takeover_during_capture",
    "lost_receipt_response",
    "physical_generation_missing",
    "takeover_during_boot_probe",
    "physical_generation_changed",
    "wrong_binding",
    "archiving",
  ].map((scenario) => ["boat", scenario] as const),
])("%s runtime stop preserves work independently of journal retention: %s", async (hostId, scenario) => {
  await withPreservationRow(
    async ({ db, id, physical, sql, provider, activity, generation }) => {
      if (!activity) throw new Error("Missing runtime activity lease fixture");
      const { people } = sharedDatabase();
      const recoveryScope: [string[], string] = [[people.org], people.owner];
      const reconcile = crypto.randomUUID();
      const archive = Buffer.from("dirty runtime workspace fixture").toString("base64");
      const takeOver = () =>
        db.query(
          `update sandboxes set activity_lease_id=null,activity_until=null,reconcile_lease=$2,
           reconcile_lease_until=now()+interval '2 minutes' where id=$1`,
          [id, reconcile],
        );
      let observed = 0;
      let captures = 0;
      const initialGeneration = hostId === "boat" ? "e76cc889-0359-4544-9320-dd938debba67" : "7";
      const replacementBoot = "32bfc56e-248e-4c0a-9ec1-feee745598bd";
      let physicalGeneration = initialGeneration;
      let bootProbes = 0;
      const host: RuntimeWorkProvider = {
        ...provider,
        id: hostId,
        async get() {
          observed++;
          if (observed === 1 && scenario === "takeover_before_capture") await takeOver();
          return {
            id: observed === 1 && scenario === "wrong_binding" ? "other-machine" : physical,
            name: physical,
            state: observed === 1 && scenario === "archiving" ? "stopping" : "ready",
            providerState: observed === 1 && scenario === "archiving" ? "archiving" : "active",
            labels: {},
            physicalGeneration: hostId === "boat" ? "stale-get-identity" : physicalGeneration,
          };
        },
        async observeCaptureBoot(sandboxId, signal) {
          expect(sandboxId).toBe(physical);
          expect(signal.aborted).toBe(false);
          if (++bootProbes === 1) {
            if (scenario === "takeover_during_boot_probe") await takeOver();
            if (scenario === "physical_generation_missing") return null;
          }
          return physicalGeneration;
        },
        async captureRuntimeWork(request) {
          expect(request.sandboxId).toBe(physical);
          expect(request.physicalGeneration).toBe(
            captures === 1 && scenario === "physical_generation_changed" ? replacementBoot : initialGeneration,
          );
          expect(request.signal.aborted).toBe(false);
          captures++;
          if (captures === 1) {
            if (scenario === "takeover_during_capture" || scenario === "takeover_on_failure") {
              await takeOver();
              if (scenario === "takeover_on_failure") return { status: "failed", reason: "collector_failed" };
            }
            if (scenario === "quiescence_rejected") throw Error("unverified process quiescence");
            if (scenario === "physical_generation_changed") physicalGeneration = replacementBoot;
          }
          if (request.physicalGeneration !== physicalGeneration)
            throw Error("collector refused the replaced incarnation");
          return scenario === "clean" ? { status: "clean" } : { status: "preserved", archive };
        },
      };
      const runtime = createRuntimeProvider(
        host,
        physical,
        host,
        undefined,
        hostId === "modal" ? host.captureRuntimeWork : undefined,
      );
      const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
      process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
      try {
        let lost = false;
        const stopSql: typeof sql = {
          ...sql,
          async query<T>(query: string, params?: unknown[]) {
            const result = await sql.query<T>(query, params);
            if (
              !lost &&
              scenario === "lost_receipt_response" &&
              query.includes("insert into public.sandbox_work_recovery")
            ) {
              lost = true;
              throw Error("connection lost after publication");
            }
            return result;
          },
        };
        const outcome = await preserveBeforeStop(stopSql, runtime, id, physical, "user_stop", {
          kind: "activity",
          token: activity,
          generation,
        });
        const takeover = scenario.startsWith("takeover_");
        const collectorRefused = ["quiescence_rejected", "physical_generation_changed"].includes(scenario);
        const noFirstDispatch = [
          "takeover_before_capture",
          "physical_generation_missing",
          "takeover_during_boot_probe",
          "wrong_binding",
          "archiving",
        ].includes(scenario);
        const pending = takeover || collectorRefused || scenario === "lost_receipt_response" || noFirstDispatch;
        expect(outcome).toBe(pending ? "pending" : undefined);
        expect(captures).toBe(noFirstDispatch ? 0 : 1);
        if (["wrong_binding", "archiving", "takeover_before_capture"].includes(scenario)) expect(bootProbes).toBe(0);
        if (scenario === "physical_generation_missing" || scenario === "takeover_during_boot_probe") {
          expect(bootProbes).toBe(1);
          const { rows } = await db.query<{ unpublished: boolean }>(
            "select preservation_stop_generation is null as unpublished from sandboxes where id=$1",
            [id],
          );
          expect(rows[0]?.unpublished).toBe(true);
        }
        if (takeover || collectorRefused || noFirstDispatch)
          expect(await readWorkRecovery(sql, recoveryScope, id)).toBeNull();
        if (scenario === "archiving") return;
        if (!takeover) await takeOver();
        const nextOwner = { kind: "reconcile", token: reconcile, generation } as const;
        expect(await preserveBeforeStop(sql, runtime, id, physical, "lifecycle_stop", nextOwner)).toBeUndefined();
        expect(await readWorkRecovery(sql, recoveryScope, id)).toBe(scenario === "clean" ? null : archive);
        expect(captures).toBe((takeover && !noFirstDispatch) || collectorRefused ? 2 : 1);
        const receipt = (
          await db.query<{ preservation_note: string | null; complete: boolean; archives: number }>(
            `select preservation_note,preservation_stop_generation=stop_generation as complete,
             (select count(*)::int from sandbox_work_recovery where sandbox_id=$1) as archives
             from sandboxes where id=$1`,
            [id],
          )
        ).rows[0]!;
        expect(receipt.complete).toBe(true);
        expect(receipt.archives).toBe(scenario === "clean" ? 0 : 1);
        if (scenario === "clean") expect(receipt.preservation_note).toBeNull();
        else expect(receipt.preservation_note).toStartWith(`unpushed work preserved at work_recovery:${id}/`);
      } finally {
        if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
        else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
      }
    },
    hostId === "boat" ? "boat-runtime" : "modal",
  );
});
