import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, ProviderError } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeProvider, type RuntimeWorkProvider } from "../src/runtime-provider.ts";
import { preserveBeforeStop, readWorkRecovery } from "../src/work-preservation.ts";
import { closeableFixture } from "./closeable.fixture.ts";
import { encryptedRecoveryExec } from "./fixtures/recovery-exec.ts";
import { migratedDatabase } from "./migrated-database.ts";
import { bunLikeSql, ENCRYPTION_KEY, fakeBoat, seedDatabase } from "./support.ts";

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
test("recovery receipts retain encrypted versions and only current interior owners/admins can retrieve them", async () => {
  const { db, people, sharedGoldenId: goldenId } = sharedDatabase();
  const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  try {
    const sql = bunLikeSql(db);
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,outputs_failure_reasons)
      values($1,$2,$3,$4,'boat','bx_recovery','claude','running',array['collector_unsupported'])`,
      [id, goldenId, people.org, people.owner],
    );
    const historicalId = crypto.randomUUID();
    const historicalArchive = Buffer.from("older recovery fixture").toString("base64");
    await db.query(
      "insert into sandbox_work_recovery(id,sandbox_id,archive_enc,created_at) values($1,$2,$3,'2020-01-01')",
      [historicalId, id, await encryptSecret(historicalArchive)],
    );
    const data = (userId: string, orgId = people.org) =>
      createSqlData(sql)({ via: "service", userId, orgs: [{ orgId, role: "admin" }] }).sandboxes;
    const owner = data(people.owner);
    const boat = fakeBoat();
    const archive = Buffer.from("recovery fixture: private repository material").toString("base64");
    const provider = {
      ...boat.provider,
      async interrupt() {
        throw new Error("idle harness must not be interrupted");
      },
      async quiesce() {},
      async get() {
        return { id: "bx_recovery", name: "recovery", state: "ready" as const, providerState: "running", labels: {} };
      },
      exec: encryptedRecoveryExec(() => archive, boat.provider.exec),
    };
    const commands = boat.execs.length;
    const pending = {
      ...provider,
      quiesce: async () => {
        throw new ProviderError({
          provider: "boat",
          code: "sandbox_not_ready",
          retryable: true,
          message: "Interruption pending",
        });
      },
    };
    expect(await preserveBeforeStop(sql, pending, id, "bx_recovery")).toBe("pending");
    expect(boat.execs).toHaveLength(commands);
    expect((await owner.get(id))?.preservationNote).toBeNull();
    // A failed capture must retain the old archive and allow a later dirty capture.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "collector_failed" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect(await owner.readWorkRecovery?.(id, historicalId)).toBe(historicalArchive);
    expect((await owner.get(id))?.preservationNote).toContain("capture_collector_failed");

    boat.setExecOutput({
      stdout: JSON.stringify({
        status: "preserved",
        bytes: Buffer.from(archive, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex"),
      }),
    });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    const captured = (
      await db.query<{ id: string; archive_enc: Uint8Array<ArrayBuffer> }>(
        "select id,archive_enc from sandbox_work_recovery where sandbox_id=$1 and id<>$2",
        [id, historicalId],
      )
    ).rows[0];
    if (!captured) throw new Error("Missing recovery artifact");
    expect(Buffer.from(captured.archive_enc).includes(Buffer.from(archive))).toBe(false);
    expect(await decryptSecret(captured.archive_enc)).toBe(archive);
    expect((await owner.get(id))?.preservationNote).toBe(
      `unpushed work preserved at work_recovery:${id}/${captured.id}`,
    );
    expect(await owner.readWorkRecovery?.(id)).toBe(archive);

    // A clean retry clears the current banner without losing recovery data.
    await db.query("update sandboxes set preservation_note='old failure' where id=$1", [id]);
    // Clean stops do not create archives; historical archives remain retrievable.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);
    expect((await owner.get(id))?.preservationNote).toBeNull();

    expect(await owner.readWorkRecovery?.(id)).toBe(archive);
    expect(await owner.readWorkRecovery?.(id, historicalId)).toBe(historicalArchive);
    expect(await data(people.admin).readWorkRecovery?.(id)).toBe(archive);
    // Stale admin claims cannot upgrade an ordinary org member's interior access.
    await expect(data(people.member).readWorkRecovery?.(id, historicalId)).rejects.toThrow("No such sandbox");
    await expect(data(people.member, people.otherOrg).readWorkRecovery?.(id)).rejects.toThrow("No such sandbox");
    const otherId = crypto.randomUUID();
    expect(await owner.readWorkRecovery?.(id, otherId)).toBeNull();

    // Ciphertext is not directly readable with a dashboard user's database role.
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select archive_enc from sandbox_work_recovery")).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  } finally {
    if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
  }
});

// Distinct lifecycle contract: a timed-out observation must never admit later
// interrupt/exec work after the caller is free to stop the machine.
test.each(["observe", "quiesce", "capture", "known_capture"])(
  "the stop deadline fences late %s work",
  async (stage) => {
    const { db, people, sharedGoldenId: goldenId } = sharedDatabase();
    const originalTimeout = globalThis.setTimeout;
    try {
      const sql = bunLikeSql(db);
      const id = crypto.randomUUID();
      const physical = `bx_late_recovery_${id}`;
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat',$5,'claude','running')`,
        [id, goldenId, people.org, people.owner, physical],
      );
      const boat = fakeBoat();
      const info = {
        id: physical,
        name: "late",
        state: "ready" as const,
        providerState: "running",
        labels: {},
      };
      let release: (() => void) | undefined;
      let reached: (() => void) | undefined;
      const boundary = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let expire: (() => void) | undefined;
      let interrupts = 0;
      let execs = 0;
      let captureSignal: AbortSignal | undefined;
      const provider = {
        ...boat.provider,
        get: () =>
          stage === "observe"
            ? new Promise<Awaited<ReturnType<typeof boat.provider.get>>>((resolve) => {
                release = () => resolve(info);
                reached?.();
              })
            : Promise.resolve(info),
        quiesce: () => {
          interrupts++;
          return stage === "capture" || stage === "known_capture"
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                release = resolve;
                reached?.();
              });
        },
        async interrupt() {
          interrupts++;
        },
        async exec(request: Parameters<typeof boat.provider.exec>[0]) {
          execs++;
          captureSignal = request.signal;
          const result = {
            detached: false as const,
            exitCode: 0,
            stdout: '{"status":"clean"}',
            stderr: "",
            timedOut: false,
            truncated: false,
          };
          if (stage === "known_capture" && execs === 1)
            return {
              ...result,
              stdout: JSON.stringify({
                status: "preserved",
                bytes: 32,
                sha256: "0".repeat(64),
                key: Buffer.alloc(256).toString("base64"),
              }),
            };
          return new Promise<typeof result>((resolve) => {
            release = () => resolve(result);
            reached?.();
          });
        },
      };
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms === 20_000) {
          expire = () => callback(...args);
          return originalTimeout(() => {}, 100_000);
        }
        return originalTimeout(callback, ms, ...args);
      }) as typeof setTimeout;
      const stopped = preserveBeforeStop(sql, provider, id, physical);
      await boundary;
      if (!expire || !release) throw new Error("Expected pending provider observation and deadline");
      expire();
      expect(await stopped).toBe(stage === "capture" || stage === "known_capture" ? undefined : "pending");
      if (stage === "capture" || stage === "known_capture") expect(captureSignal?.aborted).toBe(true);
      release();
      await Promise.resolve();
      await Promise.resolve();
      const row = (
        await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id])
      ).rows[0];
      if (stage === "known_capture") expect(row?.preservation_note).toContain("(capture_timeout)");
      else if (stage === "capture")
        expect(row?.preservation_note).toBe(
          "could not check for unpushed work (capture_timeout). If this sandbox had local work, resume it and push or copy it before stopping again.",
        );
      else expect(row?.preservation_note ?? null).toBeNull();
      expect(interrupts).toBe(stage === "observe" ? 0 : 1);
      expect(execs).toBe(stage === "known_capture" ? 2 : stage === "capture" ? 1 : 0);
      expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(0);
    } finally {
      globalThis.setTimeout = originalTimeout;
    }
  },
);

async function withPreservationRow(
  work: (fixture: {
    db: Awaited<ReturnType<typeof sharedDatabase>>["db"];
    sql: ReturnType<typeof bunLikeSql>;
    id: string;
    physical: string;
    boat: ReturnType<typeof fakeBoat>;
    provider: ReturnType<typeof fakeBoat>["provider"];
  }) => Promise<void>,
  machine: "boat" | "modal" = "boat",
) {
  const { db, people, sharedGoldenId: goldenId, modalGoldenId } = sharedDatabase();
  const id = crypto.randomUUID();
  const modal = machine === "modal";
  const physical = modal ? `modal_machine_${id}` : `bx_policy_${id}`;
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,runtime_transport,outputs_failure_reasons)
    values($1,$2,$3,$4,$5,$6,$7,'running',$8,array['collector_unsupported'])`,
    [
      id,
      modal ? modalGoldenId : goldenId,
      people.org,
      people.owner,
      machine,
      physical,
      modal ? "codex" : "claude",
      modal ? "dialout" : null,
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
  await work({ db, id, physical, boat, provider, sql: bunLikeSql(db) });
}

test("confirmed work at risk records a closed stage/reason and owner action", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider }) => {
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "size_limit", workAtRisk: true }) });
    await preserveBeforeStop(sql, provider, id, physical);
    expect(
      (await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id]))
        .rows[0]?.preservation_note,
    ).toBe(
      "unpushed work could not be preserved (capture_size_limit). Resume the sandbox and push or copy any local work before stopping again.",
    );
  });
});

test.each(["get", "quiesce", "exec"] as const)(
  "unknown work after %s failure keeps an informational owner notice",
  async (method) => {
    await withPreservationRow(async ({ db, id, physical, sql, provider }) => {
      const log = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await preserveBeforeStop(
          sql,
          {
            ...provider,
            [method]: async () => {
              throw new ProviderError({
                provider: "boat",
                code: "unavailable",
                status: 502,
                retryable: true,
                message: "PRIVATE_MESSAGE",
                details: { secret: "PRIVATE_BODY" },
              });
            },
          },
          id,
          physical,
        );
        expect(
          (
            await db.query<{ preservation_note: string | null }>(
              "select preservation_note from sandboxes where id=$1",
              [id],
            )
          ).rows[0]?.preservation_note,
        ).toContain("could not check for unpushed work (");
        const line = String(log.mock.calls.at(-1)?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "work_preservation_failed",
          workRisk: "unknown",
          providerStatus: 502,
        });
        expect(line).not.toContain("PRIVATE");
      } finally {
        log.mockRestore();
      }
    });
  },
);

test("refused collector exec preserves conditional guidance when risk cannot be checked", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, provider }) => {
    await preserveBeforeStop(
      sql,
      {
        ...provider,
        exec: async () => {
          throw new ProviderError({
            provider: "boat",
            code: "sandbox_not_ready",
            retryable: false,
            message: "PRIVATE_PROVIDER_TEXT",
          });
        },
      },
      id,
      physical,
    );
    const row = (
      await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [id])
    ).rows[0];
    expect(row?.preservation_note).toBe(
      "could not check for unpushed work (collect_exec_not_ready). If this sandbox had local work, resume it and push or copy it before stopping again.",
    );
  });
});

test("a successful clean check stays silent if clearing the receipt must be retried", async () => {
  await withPreservationRow(async ({ db, id, physical, boat, provider }) => {
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    let failed = false;
    const sql = bunLikeSql(db, (text) => {
      if (!failed && /^\s*update/i.test(text)) {
        failed = true;
        throw new Error("Synthetic cleanup failure");
      }
    });
    await preserveBeforeStop(sql, provider, id, physical);
    expect(
      (
        await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [
          id,
        ])
      ).rows[0]?.preservation_note,
    ).toBeNull();
  });
});

test("a late failed pass cannot overwrite a concurrent successful stop receipt", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider }) => {
    await db.query("update sandboxes set stop_requested_at='2026-11-11T08:00:00Z',stop_generation=1 where id=$1", [id]);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const late = {
      ...provider,
      get: () =>
        new Promise<Awaited<ReturnType<typeof provider.get>>>((resolve) => {
          release = () => {
            void provider.get(physical).then(resolve);
          };
          entered?.();
        }),
      exec: async () => {
        throw new ProviderError({
          provider: "boat",
          code: "sandbox_not_ready",
          retryable: false,
          message: "Archiving",
        });
      },
    };
    const failed = preserveBeforeStop(sql, late, id, physical, "lifecycle_stop");
    await ready;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    await preserveBeforeStop(sql, provider, id, physical, "user_stop");
    release?.();
    await failed;
    expect(
      (
        await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [
          id,
        ])
      ).rows[0],
    ).toMatchObject({ preservation_note: null });
  });
});

test("a fresh stop epoch does not reuse an earlier clean capture", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider }) => {
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    await db.query("update sandboxes set stop_requested_at='2026-11-11T08:00:00Z',stop_generation=1 where id=$1", [id]);
    await preserveBeforeStop(sql, provider, id, physical);
    const count = boat.execs.length;
    await db.query("update sandboxes set stop_requested_at='2026-11-11T09:00:00Z',stop_generation=2 where id=$1", [id]);
    await preserveBeforeStop(sql, provider, id, physical);
    expect(boat.execs.length).toBe(count + 1);
  });
});

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

test.each([
  "dirty",
  "clean",
  "takeover_before_capture",
  "takeover_during_capture",
  "takeover_on_failure",
  "quiescence_rejected",
  "lost_receipt_response",
] as const)("Modal runtime stop preserves work independently of journal retention: %s", async (scenario) => {
  await withPreservationRow(async ({ db, id, physical, sql, provider }) => {
    const activity = crypto.randomUUID();
    const reconcile = crypto.randomUUID();
    const archive = Buffer.from("dirty Modal workspace fixture").toString("base64");
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=1,activity_lease_id=$2,
         activity_until=now()+interval '2 minutes' where id=$1`,
      [id, activity],
    );
    const generation = (
      await db.query<{ lifecycle_generation: number }>("select lifecycle_generation from sandboxes where id=$1", [id])
    ).rows[0]!.lifecycle_generation;
    const takeOver = () =>
      db.query(
        `update sandboxes set activity_lease_id=null,activity_until=null,reconcile_lease=$2,
           reconcile_lease_until=now()+interval '2 minutes' where id=$1`,
        [id, reconcile],
      );
    let observed = 0;
    let captures = 0;
    const host: RuntimeWorkProvider = {
      ...provider,
      id: "modal",
      async get() {
        observed++;
        if (observed === 1 && scenario === "takeover_before_capture") await takeOver();
        return {
          id: physical,
          name: physical,
          state: "ready",
          providerState: "active",
          labels: {},
          physicalGeneration: "7",
        };
      },
      async captureRuntimeWork(request) {
        expect(request.sandboxId).toBe(physical);
        expect(request.physicalGeneration).toBe("7");
        expect(request.signal.aborted).toBe(false);
        captures++;
        if (captures === 1) {
          if (scenario === "takeover_during_capture" || scenario === "takeover_on_failure") {
            await takeOver();
            if (scenario === "takeover_on_failure") return { status: "failed", reason: "collector_failed" };
          }
          if (scenario === "quiescence_rejected") throw Error("unverified process quiescence");
        }
        return scenario === "clean" ? { status: "clean" } : { status: "preserved", archive };
      },
    };
    const runtime = createRuntimeProvider(host, physical, host);
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
      const rejected = scenario === "quiescence_rejected";
      expect(outcome).toBe(takeover || rejected || scenario === "lost_receipt_response" ? "pending" : undefined);
      if (takeover) {
        expect(await readWorkRecovery(sql, id)).toBeNull();
        expect(captures).toBe(scenario === "takeover_before_capture" ? 0 : 1);
      } else {
        expect(captures).toBe(1);
        await takeOver();
      }
      const nextOwner = { kind: "reconcile", token: reconcile, generation } as const;
      expect(await preserveBeforeStop(sql, runtime, id, physical, "lifecycle_stop", nextOwner)).toBeUndefined();
      expect(await readWorkRecovery(sql, id)).toBe(scenario === "clean" ? null : archive);
      expect(captures).toBe((takeover && scenario !== "takeover_before_capture") || rejected ? 2 : 1);
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
  }, "modal");
});
