import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, ProviderError } from "@armada/core/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Caller } from "../src/caller.ts";
import { createSqlData } from "../src/data.ts";
import { createRuntimeProvider, type RuntimeWorkProvider } from "../src/runtime-provider.ts";
import { bindRestTool, type ToolContext } from "../src/tools.ts";
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

    const token = crypto.randomUUID();
    const {
      rows: [stop],
    } = await db.query<{ lifecycle_generation: number }>(
      `update sandboxes set status='stopping', stop_requested_at=now(), stop_generation=1,
       activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1 returning lifecycle_generation`,
      [id, token],
    );
    const authority = { kind: "activity" as const, token, generation: stop!.lifecycle_generation };
    boat.setExecOutput({
      stdout: JSON.stringify({
        status: "preserved",
        bytes: Buffer.from(archive, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex"),
      }),
    });
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);
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

    await owner.update(id, {
      ownerStop: true,
      status: "stopping",
      stopRequested: true,
      finishActivity: true,
      expectedGeneration: authority.generation,
      activityToken: token,
    });
    const handoff = (
      await db.query<{ current: boolean; lifecycle_generation: number }>(
        `select s.lifecycle_generation, r.generation = s.lifecycle_generation as current
         from sandboxes s left join sandbox_native_preservation_receipts r on r.sandbox_id=s.id where s.id=$1`,
        [id],
      )
    ).rows[0];
    expect(handoff?.current).toBe(true);
    authority.generation = handoff!.lifecycle_generation;

    await db.query("update sandboxes set activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1", [
      id,
      token,
    ]);
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);

    await db.query("delete from sandbox_work_recovery where id=$1", [captured.id]);
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect(await owner.readWorkRecovery?.(id)).toBe(archive);
    expect(await owner.readWorkRecovery?.(id, captured.id)).toBeNull();

    // A clean retry clears the current banner without losing recovery data.
    await db.query(
      `update sandboxes set stop_generation=2, preservation_note='old failure',
       activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    // Clean stops do not create archives; historical archives remain retrievable.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);
    expect((await owner.get(id))?.preservationNote).toBeNull();

    await owner.update(id, {
      ownerStop: true,
      status: "stopped",
      stoppedAt: new Date(0).toISOString(),
      stopRequested: false,
      finishActivity: true,
      expectedGeneration: authority.generation,
      activityToken: token,
    });
    const receipt = (
      await db.query(
        `select s.status, r.generation = s.lifecycle_generation and r.stop_generation = s.stop_generation as current
         from sandboxes s left join sandbox_native_preservation_receipts r on r.sandbox_id=s.id where s.id=$1`,
        [id],
      )
    ).rows[0];
    expect(receipt).toEqual({ status: "stopped", current: true });

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
      await expect(db.query("select generation from sandbox_native_preservation_receipts")).rejects.toThrow(
        "permission denied",
      );
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
    generation: number;
    activity: string | null;
    boat: ReturnType<typeof fakeBoat>;
    provider: ReturnType<typeof fakeBoat>["provider"];
  }) => Promise<void>,
  machine: "boat" | "modal" = "boat",
) {
  const { db, people, sharedGoldenId: goldenId, modalGoldenId } = sharedDatabase();
  const id = crypto.randomUUID();
  const modal = machine === "modal";
  const physical = modal ? `modal_machine_${id}` : `bx_policy_${id}`;
  const activity = modal ? crypto.randomUUID() : null;
  const inserted = await db.query<{ lifecycle_generation: number }>(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
       runtime_transport,outputs_failure_reasons,stop_requested_at,stop_generation,activity_lease_id,activity_until)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,array['collector_unsupported'],
       case when $10::uuid is not null then now() end,
       case when $10::uuid is not null then 1 else 0 end,
       $10,case when $10::uuid is not null then now()+interval '2 minutes' end)
    returning lifecycle_generation`,
    [
      id,
      modal ? modalGoldenId : goldenId,
      people.org,
      people.owner,
      machine,
      physical,
      modal ? "codex" : "claude",
      modal ? "stopping" : "running",
      modal ? "dialout" : null,
      activity,
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
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    await db.query("update sandboxes set activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1", [
      id,
      token,
    ]);
    const authority = { kind: "activity", token, generation } as const;
    await db.query("update sandboxes set stop_requested_at='2026-11-11T08:00:00Z',stop_generation=1 where id=$1", [id]);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const late = {
      ...provider,
      exec: () =>
        new Promise<Awaited<ReturnType<typeof provider.exec>>>((_, reject) => {
          release = () =>
            reject(
              new ProviderError({
                provider: "boat",
                code: "sandbox_not_ready",
                retryable: false,
                message: "Archiving",
              }),
            );
          entered?.();
        }),
    };
    const failed = preserveBeforeStop(sql, late, id, physical, "user_stop", authority);
    await ready;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    await preserveBeforeStop(sql, provider, id, physical, "user_stop", authority);
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

test("native stop recaptures an unbound or superseded receipt before reusing current evidence", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    await db.query(
      `update sandboxes set status='stopping', stop_requested_at=now(), stop_generation=1,
       preservation_stop_generation=1, activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    const capture = (currentGeneration: number) =>
      preserveBeforeStop(sql, provider, id, physical, "user_stop", {
        kind: "activity",
        token,
        generation: currentGeneration,
      });
    expect(await capture(generation)).toBeUndefined();
    expect(boat.execs).toHaveLength(1);
    expect(await capture(generation)).toBeUndefined();
    expect(boat.execs).toHaveLength(1);

    await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
    expect(await capture(Number(generation) + 1)).toBeUndefined();
    expect(boat.execs).toHaveLength(2);

    await db.query("update sandboxes set stop_generation=2, preservation_stop_generation=2 where id=$1", [id]);
    expect(await capture(Number(generation) + 1)).toBeUndefined();
    expect(boat.execs).toHaveLength(3);
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
  await withPreservationRow(async ({ db, id, physical, sql, provider, activity, generation }) => {
    if (!activity) throw new Error("Missing Modal activity lease fixture");
    const { people } = sharedDatabase();
    const recoveryScope: [string[], string] = [[people.org], people.owner];
    const reconcile = crypto.randomUUID();
    const archive = Buffer.from("dirty Modal workspace fixture").toString("base64");
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
    const runtime = createRuntimeProvider(host, physical, host, undefined, host.captureRuntimeWork);
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
        expect(await readWorkRecovery(sql, recoveryScope, id)).toBeNull();
        expect(captures).toBe(scenario === "takeover_before_capture" ? 0 : 1);
      } else {
        expect(captures).toBe(1);
        await takeOver();
      }
      const nextOwner = { kind: "reconcile", token: reconcile, generation } as const;
      expect(await preserveBeforeStop(sql, runtime, id, physical, "lifecycle_stop", nextOwner)).toBeUndefined();
      expect(await readWorkRecovery(sql, recoveryScope, id)).toBe(scenario === "clean" ? null : archive);
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

test.each(["observe", "capture"] as const)(
  "native stop ownership transfer during %s leaves no stale receipt",
  async (phase) => {
    await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
      const activity = crypto.randomUUID();
      const reconcile = crypto.randomUUID();
      await db.query(
        `update sandboxes set status='stopping', stop_requested_at=now(), stop_generation=1,
         activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1`,
        [id, activity],
      );
      const takeOver = () =>
        db.query(
          `update sandboxes set activity_lease_id=null, activity_until=null,
           reconcile_lease=$2, reconcile_lease_until=now()+interval '2 minutes' where id=$1`,
          [id, reconcile],
        );
      boat.setExecOutput({ stdout: '{"status":"clean"}' });
      let captures = 0;
      let observations = 0;
      const host: typeof provider = {
        ...provider,
        async get() {
          observations++;
          if (phase === "observe" && observations === 1) await takeOver();
          return provider.get(physical);
        },
        async exec(request) {
          captures++;
          if (phase === "capture" && captures === 1) await takeOver();
          return provider.exec(request);
        },
      };
      const readReceipt = async () =>
        (
          await db.query<{ preservation_stop_generation: number | null }>(
            "select preservation_stop_generation from sandboxes where id=$1",
            [id],
          )
        ).rows[0]?.preservation_stop_generation;
      expect(
        await preserveBeforeStop(sql, host, id, physical, "user_stop", {
          kind: "activity",
          token: activity,
          generation,
        }),
      ).toBe("pending");
      expect(await readReceipt()).toBeNull();
      const priorCaptures = phase === "observe" ? 0 : 1;
      expect(captures).toBe(priorCaptures);
      expect(
        await preserveBeforeStop(sql, host, id, physical, "lifecycle_stop", {
          kind: "reconcile",
          token: reconcile,
          generation,
        }),
      ).toBeUndefined();
      expect(Number(await readReceipt())).toBe(1);
      expect(captures).toBe(priorCaptures + 1);
    });
  },
);

async function seedNativeDrainReceipt(ciphertext = new Uint8Array([21, 34, 55])) {
  const { db, people, sharedGoldenId } = sharedDatabase();
  const sandboxId = crypto.randomUUID();
  const archiveId = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
       stopped_at,lifecycle_generation,stop_generation,preservation_stop_generation)
     values($1,$2,$3,$4,'boat',$5,'claude','stopped',now(),4,2,2)`,
    [sandboxId, sharedGoldenId, people.org, people.owner, `bx_${sandboxId}`],
  );
  await db.query("insert into sandbox_work_recovery(id,sandbox_id,archive_enc) values($1,$2,$3)", [
    archiveId,
    sandboxId,
    ciphertext,
  ]);
  await db.query(
    `insert into sandbox_native_preservation_receipts
       (sandbox_id,generation,stop_generation,capture_generation,capture_stop_generation,archive_id)
     values($1,4,2,4,2,$2)`,
    [sandboxId, archiveId],
  );
  async function copy(generation = 4) {
    const result = await db.query<{ outcome: string }>("select copy_native_drain_recovery($1,$2) as outcome", [
      sandboxId,
      generation,
    ]);
    return result.rows[0]?.outcome;
  }
  return { db, people, sandboxId, archiveId, ciphertext, copy };
}

test("ordinary native exec excludes owner stop until workspace mutation finishes", async () => {
  const { db, people, sharedGoldenId } = sharedDatabase();
  const boat = fakeBoat();
  const machine = await boat.provider.fork({
    from: "fixture-snapshot",
    noEnv: true,
    env: {},
    labels: {},
    ttlSeconds: 3600,
  });
  const sandboxId = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
     values($1,$2,$3,$4,'boat',$5,'claude','ready')`,
    [sandboxId, sharedGoldenId, people.org, people.owner, machine.id],
  );
  const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "admin" }] };
  let stopDuringExec: CallToolResult | undefined;
  const provider = {
    ...boat.provider,
    async exec(request: Parameters<typeof boat.provider.exec>[0]) {
      if (request.command === "edit workspace") stopDuringExec = await invoke("stop", { id: sandboxId });
      return boat.provider.exec(request);
    },
  };
  const context: ToolContext = {
    caller,
    data: createSqlData(bunLikeSql(db))(caller),
    launchCredentials: {
      async resolve() {
        throw new Error("Exec does not launch a sandbox.");
      },
    },
    exposedSecrets: async () => [],
    provider: async () => provider,
    now: () => new Date(),
    sleep: async () => {
      throw new Error("Unexpected wait");
    },
  };
  function invoke(name: string, input: Record<string, unknown>) {
    let reply: Promise<CallToolResult> | undefined;
    bindRestTool(context, name, (_, _contract, run) => {
      reply = run(input as never);
    });
    if (!reply) throw new Error(`Missing tool: ${name}`);
    return reply;
  }

  const result = await invoke("exec", { id: sandboxId, command: "edit workspace" });
  expect(stopDuringExec?.isError).toBe(true);
  expect(boat.stops).toHaveLength(0);
  expect(result.structuredContent).toMatchObject({ exitCode: 0 });
  const ready = await context.data.sandboxes.controlState?.(sandboxId);
  boat.setExecOutput({ stdout: '{"status":"clean"}' });
  const stopped = await invoke("stop", { id: sandboxId });
  expect(stopped.structuredContent).toMatchObject({ status: "stopped" });
  expect(boat.stops).toEqual([machine.id]);

  // Replay the preflight read when stop settled before exec loaded its live row.
  expect(ready?.status).toBe("ready");
  context.data.sandboxes.controlState = async () => ready ?? null;
  const commands = boat.execs.length;
  expect((await invoke("exec", { id: sandboxId, command: "must not restore" })).isError).toBe(true);
  expect(boat.execs).toHaveLength(commands);
});

test("owners and admins can recover the exact native archive after normal deletion and handoff replay", async () => {
  const archive = Buffer.from("detached work fixture").toString("base64");
  const previousKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  try {
    const { db, people, sandboxId, archiveId, ciphertext, copy } = await seedNativeDrainReceipt(
      await encryptSecret(archive),
    );
    expect(await copy()).toBe("archived");
    expect(await copy()).toBe("archived");
    const data = (userId: string) =>
      createSqlData(bunLikeSql(db))({ via: "service", userId, orgs: [{ orgId: people.org, role: "admin" }] }).sandboxes;
    const owner = data(people.owner);
    const token = crypto.randomUUID();
    await db.query("update sandboxes set activity_lease_id=$2,activity_until=now()+interval '1 day' where id=$1", [
      sandboxId,
      token,
    ]);
    await owner.update(sandboxId, {
      deleteCompleted: true,
      expectedGeneration: 4,
      activityToken: token,
      finishActivity: true,
    });

    expect((await owner.get(sandboxId))?.status).toBe("deleted");
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
    expect(await copy(5)).toBe("ineligible");
    expect(
      (
        await db.query("select archive_id,org_id,owner_id,archive_enc from native_drain_recovery where sandbox_id=$1", [
          sandboxId,
        ])
      ).rows,
    ).toEqual([{ archive_id: archiveId, org_id: people.org, owner_id: people.owner, archive_enc: ciphertext }]);
    expect(await owner.readWorkRecovery?.(sandboxId, archiveId)).toBe(archive);
    expect(await data(people.admin).readWorkRecovery?.(sandboxId)).toBe(archive);
    expect(await owner.readWorkRecovery?.(sandboxId, crypto.randomUUID())).toBeNull();
    await expect(data(people.member).readWorkRecovery?.(sandboxId, archiveId)).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    if (previousKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = previousKey;
  }
});

test("native handoff refuses stale and missing proof even with a historical archive", async () => {
  const { db, sandboxId, archiveId, copy } = await seedNativeDrainReceipt();
  expect(await copy(3)).toBe("ineligible");
  await db.query("delete from sandbox_work_recovery where id=$1", [archiveId]);
  await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [
    sandboxId,
    new Uint8Array([89]),
  ]);
  expect(await copy()).toBe("unverified");

  await db.query(
    "update sandbox_native_preservation_receipts set archive_id=null, capture_generation=3 where sandbox_id=$1",
    [sandboxId],
  );
  expect(await copy()).toBe("unverified");
  await db.query("update sandbox_native_preservation_receipts set capture_generation=4 where sandbox_id=$1", [
    sandboxId,
  ]);
  expect(await copy()).toBe("clean");
  expect(
    (await db.query("select archive_id from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows,
  ).toEqual([]);
});

test("native drain recovery is service-only and taint purges the detached copy", async () => {
  const { db, sandboxId, copy } = await seedNativeDrainReceipt();
  const privileges = await db.query(
    `select
      has_function_privilege('authenticated','public.copy_native_drain_recovery(uuid,bigint)','execute') as jwt_copy,
      has_table_privilege('authenticated','public.native_drain_recovery','select') as jwt_read,
      has_function_privilege('service_role','public.copy_native_drain_recovery(uuid,bigint)','execute') as service_copy,
      has_table_privilege('service_role','public.native_drain_recovery','select') as service_read`,
  );
  expect(privileges.rows).toEqual([{ jwt_copy: false, jwt_read: false, service_copy: true, service_read: true }]);
  expect(await copy()).toBe("archived");
  await db.query("update sandboxes set application_secret_tainted=true where id=$1", [sandboxId]);
  expect(await copy()).toBe("ineligible");
  expect(
    (await db.query("select archive_id from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows,
  ).toEqual([]);
});

test.each(["prompt", "steer", "queued", "dispatching"] as const)(
  "native handoff leaves verified work attached while %s work is unresolved",
  async (kind) => {
    const { db, sandboxId, copy } = await seedNativeDrainReceipt();
    let settle: string;
    if (kind === "prompt") {
      await db.query(
        `insert into native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id,failures)
         select id,'turn',provider,provider_sandbox_id,owner_id,org_id,5 from sandboxes where id=$1`,
        [sandboxId],
      );
      settle = "update native_webhook_prompts set completed_at=now() where sandbox_id=$1";
    } else if (kind === "steer") {
      await db.query(
        "insert into native_steer_cursors(sandbox_id,steer_id,pending_since,pending_steers) values($1,gen_random_uuid(),now(),1)",
        [sandboxId],
      );
      settle = "update native_steer_cursors set pending_since=null,pending_steers=0 where sandbox_id=$1";
    } else {
      await db.query(
        `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
           actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
         select s.id,gen_random_uuid(),c.id,s.owner_id,s.org_id,1,c.version,'input',$3,'conversation',$2,
           case when $2='dispatching' then s.lifecycle_generation end
         from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
         where s.id=$1 limit 1`,
        [sandboxId, kind, new Uint8Array([1])],
      );
      settle = "update account_turn_queue set state='admitted' where sandbox_id=$1";
    }

    expect(await copy()).toBe("ineligible");
    expect((await db.query("select 1 from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
    await db.query(settle, [sandboxId]);
    expect(await copy()).toBe("archived");
  },
);

test.each([
  ["Dispatch outcome uncertain; inspect sandbox history before resending.", false, "ineligible", false],
  [
    "Queued receipt already has dispatch evidence; inspect sandbox history before resending.",
    false,
    "ineligible",
    false,
  ],
  ["Dispatch cancelled by confirmed stop.", false, "ineligible", false],
  ["Dispatch refused by owner stop.", true, "ineligible", false],
  ["Dispatch refused by owner stop.", false, "archived", false],
  ["Queued prompt was cancelled.", false, "ineligible", true],
] as const)(
  "native handoff classifies failed receipt %s with retained claim %p",
  async (reason, claimed, outcome, currentTask) => {
    const { db, sandboxId, copy } = await seedNativeDrainReceipt();
    const requestId = crypto.randomUUID();
    await db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
       actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,
       dispatch_generation,dispatch_until,failure_reason)
     select s.id,$5,c.id,s.owner_id,s.org_id,1,c.version,'input',$4,'conversation','failed',
       case when $2 then s.lifecycle_generation end,case when $2 then now() end,$3
     from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
     where s.id=$1 limit 1`,
      [sandboxId, claimed, reason, new Uint8Array([1]), requestId],
    );
    if (currentTask) {
      await db.query("update sandboxes set task_prompt_id=$2 where id=$1", [sandboxId, requestId]);
      await db.query("update native_webhook_prompts set completed_at=now() where sandbox_id=$1", [sandboxId]);
    }
    await db.query("update sandboxes set stopped_at=now() where id=$1", [sandboxId]);

    expect(await copy()).toBe(outcome);
    if (outcome === "ineligible")
      expect((await db.query("select 1 from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
  },
);

test("native handoff refuses a failed receipt even when an unrelated prompt was aliased and settled", async () => {
  const { db, sandboxId, copy } = await seedNativeDrainReceipt();
  await db.query(
    `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
       actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation,dispatch_until)
     select s.id,gen_random_uuid(),c.id,s.owner_id,s.org_id,1,c.version,'input',$2,'conversation',
       'dispatching',s.lifecycle_generation,now()
     from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
     where s.id=$1 limit 1`,
    [sandboxId, new Uint8Array([1])],
  );
  await db.query("update sandboxes set task_prompt_id='unrelated-turn' where id=$1", [sandboxId]);
  await db.query(
    "update native_webhook_prompts set completed_at=now() where sandbox_id=$1 and prompt_id='unrelated-turn'",
    [sandboxId],
  );
  const { rows } = await db.query(
    `update account_turn_queue set state='failed', dispatch_generation=null, dispatch_until=null
     where sandbox_id=$1 returning native_prompt_id`,
    [sandboxId],
  );
  expect(rows).toEqual([{ native_prompt_id: "unrelated-turn" }]);

  expect(await copy()).toBe("ineligible");
  expect((await db.query("select 1 from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
});

test.each([
  ["before clean capture", "clean"],
  ["during clean capture", "ineligible"],
  ["before archive capture", "archived"],
] as const)("failed native dispatch settled %s requires matching capture evidence", async (settlement, outcome) => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
           actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
         select s.id,$2,c.id,s.owner_id,s.org_id,1,c.version,'input',$3,'conversation',
           'dispatching',s.lifecycle_generation
         from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai' where s.id=$1 limit 1`,
      [id, requestId, new Uint8Array([1])],
    );
    await db.query(
      `insert into native_webhook_prompts
           (sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id,acknowledged_request_id)
         select id,'bound-turn',provider,provider_sandbox_id,owner_id,org_id,$2 from sandboxes where id=$1`,
      [id, requestId],
    );
    const settlePrompt = () =>
      db.query("update native_webhook_prompts set completed_at=now() where sandbox_id=$1", [id]);
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=1,
           activity_lease_id=$2,activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    const archive = Buffer.from("exact failed request work").toString("base64");
    const archived = outcome === "archived";
    boat.setExecOutput({ stdout: archived ? '{"status":"preserved"}' : '{"status":"clean"}' });
    const exec = archived ? encryptedRecoveryExec(() => archive, provider.exec) : provider.exec;
    let captures = 0;
    const host = {
      ...provider,
      async quiesce() {
        if (settlement !== "during clean capture") await settlePrompt();
      },
      async exec(request: Parameters<typeof provider.exec>[0]) {
        if (request.preservationStage !== "chunk_exec") {
          captures++;
          if (settlement === "during clean capture") await settlePrompt();
        }
        return exec(request);
      },
    };
    const authority = { kind: "activity", token, generation } as const;
    const previousKey = process.env.ARMADA_ENCRYPTION_KEY;
    process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
    try {
      await preserveBeforeStop(sql, host, id, physical, "user_stop", authority);
      await preserveBeforeStop(sql, host, id, physical, "user_stop", authority);
    } finally {
      if (previousKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
      else process.env.ARMADA_ENCRYPTION_KEY = previousKey;
    }
    expect(captures).toBe(1);

    await db.query(
      "update account_turn_queue set state='failed',failure_reason='Dispatch cancelled by confirmed stop.' where sandbox_id=$1",
      [id],
    );
    const { people } = sharedDatabase();
    const owner = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "admin" }],
    }).sandboxes;
    await owner.update(id, {
      ownerStop: true,
      status: "stopped",
      stoppedAt: new Date(0).toISOString(),
      stopRequested: false,
      finishActivity: true,
      expectedGeneration: generation,
      activityToken: token,
    });
    const copy = async () =>
      (
        await db.query<{ outcome: string }>("select copy_native_drain_recovery($1,$2) as outcome", [
          id,
          Number(generation) + 1,
        ])
      ).rows[0]?.outcome;
    expect(await copy()).toBe(outcome);
    if (archived) {
      const {
        rows: [detached],
      } = await db.query<{ archive_enc: Uint8Array<ArrayBuffer> }>(
        "select archive_enc from native_drain_recovery where sandbox_id=$1",
        [id],
      );
      expect(detached).toBeDefined();
      expect(await decryptSecret(detached!.archive_enc, ENCRYPTION_KEY)).toBe(archive);
    }
    if (outcome === "clean") {
      const publishWithoutAcknowledgements = () =>
        db.query("update sandbox_native_preservation_receipts set archive_id=null where sandbox_id=$1", [id]);
      await publishWithoutAcknowledgements();
      expect(await copy()).toBe("ineligible");
    }
  });
});

test("native stop retries a failed acknowledgement snapshot before collecting work", async () => {
  await withPreservationRow(async ({ db, id, physical, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=1,
         activity_lease_id=$2,activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    const sql = bunLikeSql(db, (statement) => {
      if (statement.includes("jsonb_object_agg(p.acknowledged_request_id"))
        throw new Error("acknowledgement snapshot unavailable");
    });
    const authority = { kind: "activity", token, generation } as const;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    expect(await preserveBeforeStop(sql, provider, id, physical, "user_stop", authority)).toBe("pending");
    expect(boat.execs).toHaveLength(0);
    expect(await preserveBeforeStop(bunLikeSql(db), provider, id, physical, "user_stop", authority)).toBeUndefined();
    expect(boat.execs).toHaveLength(1);
  });
});
